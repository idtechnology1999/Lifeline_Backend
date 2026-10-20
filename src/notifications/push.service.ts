import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Firebase Cloud Messaging. Configure with FIREBASE_SERVICE_ACCOUNT (path to
 * the service-account JSON from the Firebase console). Without it, pushes are
 * skipped and only in-app notifications are sent.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger('Push');
  private messaging: Messaging | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!path) return;
    try {
      const credentials = JSON.parse(readFileSync(path, 'utf8'));
      const app = getApps().length ? getApp() : initializeApp({ credential: cert(credentials) });
      this.messaging = getMessaging(app);
      this.logger.log('FCM push enabled');
    } catch (err) {
      this.logger.warn(`FCM disabled: ${(err as Error).message}`);
    }
  }

  async send(userId: number, title: string, body: string, data: Record<string, string>) {
    if (!this.messaging) return;
    try {
      const devices = await this.prisma.deviceToken.findMany({ where: { userId } });
      if (!devices.length) return;
      const res = await this.messaging.sendEachForMulticast({
        tokens: devices.map((d) => d.token),
        notification: { title, body },
        data,
        android: { priority: 'high', notification: { channelId: 'lifeline' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      // Forget tokens Firebase says are dead (app uninstalled, etc.)
      const dead = res.responses
        .map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? devices[i].token : null))
        .filter((t): t is string => !!t);
      if (dead.length) await this.prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
    } catch (err) {
      this.logger.warn(`push failed: ${(err as Error).message}`);
    }
  }
}
