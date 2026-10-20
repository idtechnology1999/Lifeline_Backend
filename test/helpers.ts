import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { TokensService } from '../src/auth/tokens.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';

type User = Prisma.UserGetPayload<object>;

/**
 * Boots the real app once per test file and wipes the database before each
 * test (like Laravel's RefreshDatabase).
 */
export function useApp() {
  const ctx = {} as { app: NestExpressApplication; prisma: PrismaService };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    ctx.app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    await configureApp(ctx.app);
    await ctx.app.init();
    ctx.prisma = ctx.app.get(PrismaService);
  });

  beforeEach(async () => {
    // Never wipe anything but a test database
    const [{ db }] = await ctx.prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    if (!db.endsWith('_test')) throw new Error(`Refusing to empty "${db}": not a _test database.`);
    const tables = await ctx.prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'spatial_ref_sys')`;
    await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await ctx.app.get(RedisService).client.flushdb();
  });

  afterAll(async () => {
    await ctx.app?.close();
  });

  return {
    get app() {
      return ctx.app;
    },
    get prisma() {
      return ctx.prisma;
    },
    /** Unauthenticated client. */
    guest: () => client(ctx.app),
    /** Client signed in as this user (a fresh token, like Sanctum's actingAs). */
    as: async (user: User) => client(ctx.app, await ctx.app.get(TokensService).issue(user.id, 'test')),
    createUser: (data: Partial<Prisma.UserUncheckedCreateInput> & { name: string; password?: string }) => {
      const { password, ...rest } = data;
      return ctx.prisma.user.create({
        data: { ...rest, ...(password && { passwordHash: bcrypt.hashSync(password, 4) }) },
      });
    },
    /** A provider user with a profile (approved unless stated). */
    createProvider: async (type: string, phone: string, data: Partial<Prisma.ProviderUncheckedCreateInput> = {}) => {
      const user = await ctx.prisma.user.create({ data: { name: data.contactName ?? 'Contact', phone, role: 'provider' } });
      const provider = await ctx.prisma.provider.create({
        data: { userId: user.id, type, businessName: 'Business', contactName: 'Contact', phone, verification: 'approved', ...data },
      });
      return { user, provider };
    },
  };
}

function client(app: NestExpressApplication, token?: string) {
  const agent = request(app.getHttpServer());
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string, body?: object) => {
    let req = agent[method](`/api/v1${url}`).set('Accept', 'application/json');
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  return { get: call('get'), post: call('post'), patch: call('patch'), put: call('put'), delete: call('delete'), token, agent };
}
