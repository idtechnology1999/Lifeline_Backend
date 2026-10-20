import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service.js';
import { RedisService } from './redis/redis.service.js';

/** For uptime monitors and the deploy script. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const database = await this.prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
    const redis = await this.redis.client.ping().then(() => true, () => false);
    if (!database) throw new ServiceUnavailableException('Database unavailable.');
    return { status: 'ok', database, redis };
  }
}
