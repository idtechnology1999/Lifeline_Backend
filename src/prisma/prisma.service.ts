import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** A transaction client (inside prisma.$transaction). */
export type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
