import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiExceptionFilter, validationPipe } from './common/http.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';

/** Shared by main.ts and the e2e tests so both run the same app. */
export async function configureApp(app: NestExpressApplication) {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(validationPipe);
  app.useGlobalFilters(new ApiExceptionFilter());
  // Behind nginx on the VPS: use X-Forwarded-For for rate limits
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.enableCors({
    origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()) : true,
  });
  app.useBodyParser('json', { limit: '1mb' });

  const io = new RedisIoAdapter(app);
  await io.connect();
  app.useWebSocketAdapter(io);
  return app;
}
