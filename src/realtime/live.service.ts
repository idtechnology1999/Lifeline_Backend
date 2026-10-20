import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { orderInclude, presentOrder, presentRequest, requestInclude } from '../common/presenters.js';

/**
 * Pushes fresh state to everyone following a trip or delivery, so the apps
 * update instantly instead of waiting for their next poll.
 *   request.updated  -> request:<id>, and providers:ambulance while it's open
 *   order.updated    -> order:<id>
 *   location         -> request/order rooms of the provider's active jobs
 */
@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  private readonly logger = new Logger('Live');

  // Broadcasts are fire-and-forget: they log failures instead of throwing
  request(id: number) {
    return this._request(id).catch((err) => this.logger.warn(`request ${id}: ${(err as Error).message}`));
  }

  order(id: number) {
    return this._order(id).catch((err) => this.logger.warn(`order ${id}: ${(err as Error).message}`));
  }

  providerMoved(providerId: number, lat: number, lng: number) {
    return this._providerMoved(providerId, lat, lng).catch((err) => this.logger.warn(`location ${providerId}: ${(err as Error).message}`));
  }

  private async _request(id: number) {
    const r = await this.prisma.emergencyRequest.findUnique({
      where: { id },
      include: { ...requestInclude, offers: { where: { status: 'open' }, include: { provider: true } } },
    });
    if (!r) return;
    const payload = presentRequest(r);
    this.gateway.emit(`request:${id}`, 'request.updated', payload);
    if (r.status === 'searching' || r.status === 'negotiating' || r.status === 'cancelled') {
      this.gateway.emit('providers:ambulance', 'requests.changed', { id: String(id), status: r.status });
    }
  }

  private async _order(id: number) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id }, include: orderInclude });
    if (!o) return;
    this.gateway.emit(`order:${id}`, 'order.updated', presentOrder(o));
    if (o.status === 'accepted' && !o.dispatcherId) {
      this.gateway.emit('providers:dispatcher', 'deliveries.changed', { id: String(id) });
    }
  }

  /** A provider moved: tell whoever is following their active jobs. */
  private async _providerMoved(providerId: number, lat: number, lng: number) {
    const payload = { providerId: String(providerId), lat, lng, updatedAt: new Date().toISOString() };
    const [trips, deliveries] = await Promise.all([
      this.prisma.emergencyRequest.findMany({ where: { providerId, status: { in: ['en_route', 'on_trip'] } }, select: { id: true } }),
      this.prisma.supplyOrder.findMany({
        where: { OR: [{ dispatcherId: providerId }, { supplierId: providerId }], status: { in: ['accepted', 'picked_up'] } },
        select: { id: true },
      }),
    ]);
    trips.forEach((t) => this.gateway.emit(`request:${t.id}`, 'location', payload));
    deliveries.forEach((d) => this.gateway.emit(`order:${d.id}`, 'location', payload));
  }
}
