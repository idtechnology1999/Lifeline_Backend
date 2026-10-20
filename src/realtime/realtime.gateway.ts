import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokensService } from '../auth/tokens.service.js';
import type { AuthUser } from '../auth/guards.js';

interface ClientData {
  user: AuthUser;
}

/**
 * Socket.IO endpoint (path /socket.io). Clients connect with
 * `auth: { token }` (the same bearer token as the REST API) and are placed in:
 *   user:<id>                 their own events (notifications)
 *   providers:<type>          e.g. providers:ambulance, for new jobs
 * They can also `subscribe` to request:<id> / order:<id> to follow a trip or
 * delivery live (status changes and vehicle positions).
 */
@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Realtime');
  @WebSocketServer() server: Server;

  constructor(
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Authenticate during the handshake, so a client's `connect` only fires
   * once we know who they are (bad tokens get `connect_error`).
   */
  afterInit(server: Server) {
    server.use((client, next) => {
      this.authenticate(client).then(
        (ok) => next(ok ? undefined : new Error('Unauthenticated.')),
        () => next(new Error('Unauthenticated.')),
      );
    });
  }

  private async authenticate(client: Socket) {
    const raw = (client.handshake.auth?.token as string | undefined) ?? client.handshake.headers.authorization?.replace(/^Bearer /, '');
    const token = raw ? await this.tokens.resolve(raw) : null;
    if (!token || token.user.accountStatus === 'suspended') return false;
    (client.data as ClientData).user = token.user;
    return true;
  }

  async handleConnection(client: Socket) {
    const user = (client.data as ClientData).user;
    await client.join(`user:${user.id}`);
    if (user.provider?.verification === 'approved') {
      await client.join(`providers:${user.provider.type}`);
    }
  }

  /** Follow a trip or delivery: { type: 'request' | 'order', id }. */
  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { type?: string; id?: string | number }) {
    const user = (client.data as ClientData).user;
    const id = Number(body?.id);
    if (!user || !id) return { ok: false };

    let allowed = false;
    if (body.type === 'request') {
      const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
      allowed =
        !!r &&
        (r.requesterId === user.id ||
          user.role === 'admin' ||
          (user.provider?.type === 'ambulance' && (r.providerId === user.provider.id || ['searching', 'negotiating'].includes(r.status))));
    } else if (body.type === 'order') {
      const o = await this.prisma.supplyOrder.findUnique({ where: { id } });
      const pid = user.provider?.id;
      allowed = !!o && (o.requesterId === user.id || user.role === 'admin' || o.supplierId === pid || o.dispatcherId === pid);
    }

    if (!allowed) return { ok: false };
    await client.join(`${body.type}:${id}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { type?: string; id?: string | number }) {
    await client.leave(`${body?.type}:${Number(body?.id)}`);
    return { ok: true };
  }

  emit(room: string, event: string, payload: unknown) {
    try {
      this.server?.to(room).emit(event, payload);
    } catch (err) {
      this.logger.warn(`emit ${event} to ${room} failed: ${(err as Error).message}`);
    }
  }
}
