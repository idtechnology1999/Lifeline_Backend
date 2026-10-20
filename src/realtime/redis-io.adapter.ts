import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import { RedisService } from '../redis/redis.service.js';

/**
 * Socket.IO over Redis pub/sub, so events reach clients connected to any
 * API process (needed once you run more than one instance on the VPS).
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connect() {
    try {
      const redis = this.app.get(RedisService);
      const pub = redis.duplicate();
      const sub = redis.duplicate();
      await Promise.all([pub.ping(), sub.ping()]);
      this.adapterConstructor = createAdapter(pub, sub);
    } catch (err) {
      new Logger('Realtime').warn(`Redis adapter unavailable, using in-memory sockets: ${(err as Error).message}`);
    }
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
