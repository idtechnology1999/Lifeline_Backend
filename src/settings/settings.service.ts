import { Global, HttpException, HttpStatus, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PlatformSettings {
  baseRates: { bls: number; als: number; erv: number };
  perKmRate: number;
  commissionPercent: number;
  deliveryBaseFee: number;
  /** Basic and Family are monthly, Annual is yearly */
  plans: { basic: number; family: number; annual: number };
  autoApproveProviders: boolean;
  maintenanceMode: boolean;
}

/** Defaults match the prices the mobile app shows. */
export const PLATFORM_DEFAULTS: PlatformSettings = {
  baseRates: { bls: 2500, als: 4200, erv: 3400 },
  perKmRate: 150,
  commissionPercent: 10,
  deliveryBaseFee: 1500,
  plans: { basic: 25000, family: 50000, annual: 450000 },
  autoApproveProviders: false,
  maintenanceMode: false,
};

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async platform(): Promise<PlatformSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'platform' } });
    const stored = (row?.value ?? {}) as Partial<PlatformSettings>;
    return {
      ...PLATFORM_DEFAULTS,
      ...stored,
      baseRates: { ...PLATFORM_DEFAULTS.baseRates, ...stored.baseRates },
      plans: { ...PLATFORM_DEFAULTS.plans, ...stored.plans },
    };
  }

  async save(settings: PlatformSettings): Promise<PlatformSettings> {
    await this.prisma.setting.upsert({
      where: { key: 'platform' },
      create: { key: 'platform', value: settings as object },
      update: { value: settings as object },
    });
    return this.platform();
  }

  async commissionRate(): Promise<number> {
    return (await this.platform()).commissionPercent / 100;
  }

  /** Stop new requests and orders while maintenance mode is on. */
  async abortIfMaintenance(): Promise<void> {
    if ((await this.platform()).maintenanceMode) {
      throw new HttpException(
        { message: 'Lifeline is under maintenance. For a life-threatening emergency, call 112.' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
