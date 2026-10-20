import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.service.js';
import { RedisModule } from './redis/redis.service.js';
import { SettingsModule } from './settings/settings.service.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health.controller.js';
// Auth
import { AuthController } from './auth/auth.controller.js';
import { OtpService } from './auth/otp.service.js';
import { TokensService } from './auth/tokens.service.js';
// Realtime & notifications
import { RealtimeGateway } from './realtime/realtime.gateway.js';
import { LiveService } from './realtime/live.service.js';
import { PushService } from './notifications/push.service.js';
import { NotifierService } from './notifications/notifier.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
// Money
import { WalletService } from './payments/wallet.service.js';
import { PaymentService } from './payments/payment.service.js';
// Emergencies
import { EmergencyService } from './emergency/emergency.service.js';
import { RequesterEmergencyController } from './emergency/requester-emergency.controller.js';
import { ProviderEmergencyController } from './emergency/provider-emergency.controller.js';
import { AdminEmergencyController } from './emergency/admin-emergency.controller.js';
// Supplies
import { OrdersService } from './orders/orders.service.js';
import { CatalogController } from './orders/catalog.controller.js';
import { RequesterOrdersController } from './orders/requester-orders.controller.js';
import { DeliveriesController, SupplierOrdersController } from './orders/provider-orders.controller.js';
// Providers, patients, admin
import { ProviderProfileController } from './providers/profile.controller.js';
import { SupplierProductsController } from './providers/products.controller.js';
import { ProviderWalletController } from './providers/provider-wallet.controller.js';
import { RequesterController } from './requester/requester.controller.js';
import { AdminController } from './admin/admin.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, SettingsModule, FilesModule],
  controllers: [
    HealthController,
    AuthController,
    NotificationsController,
    CatalogController,
    RequesterEmergencyController,
    RequesterOrdersController,
    RequesterController,
    // Specific provider routes before the profile's catch-all ones
    ProviderEmergencyController,
    SupplierProductsController,
    SupplierOrdersController,
    DeliveriesController,
    ProviderWalletController,
    ProviderProfileController,
    AdminEmergencyController,
    AdminController,
  ],
  providers: [
    OtpService,
    TokensService,
    RealtimeGateway,
    LiveService,
    PushService,
    NotifierService,
    WalletService,
    PaymentService,
    EmergencyService,
    OrdersService,
  ],
})
export class AppModule {}
