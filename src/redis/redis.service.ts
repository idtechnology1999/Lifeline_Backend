import { Global, HttpException, HttpStatus, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
    this.client.on('error', (err) => this.logger.warn(err.message));
  }

  /** A second connection, for Socket.IO's pub/sub adapter. */
  duplicate(): Redis {
    return this.client.duplicate();
  }

  /**
   * Fixed-window rate limit. Throws 429 once `limit` hits happen within
   * `windowSeconds` for this key. Fails open if Redis is down.
   */
  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    let count: number;
    try {
      const k = `rl:${key}`;
      count = await this.client.incr(k);
      if (count === 1) await this.client.expire(k, windowSeconds);
    } catch {
      return;
    }
    if (count > limit) {
      throw new HttpException({ message: 'Too many attempts. Please wait a minute and try again.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
