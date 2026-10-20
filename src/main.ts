import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  await configureApp(app);
  const port = Number(process.env.PORT ?? 8000);
  // 0.0.0.0 so phones on the same Wi-Fi (Expo) can reach it
  await app.listen(port, process.env.HOST ?? '0.0.0.0');
}
await bootstrap();
