import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsObject, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { TokensService } from '../auth/tokens.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { Auth } from '../auth/guards.js';
import { pageParams, paginate } from '../common/http.js';
import {
  orderInclude,
  presentOrder,
  presentProvider,
  presentRequester,
  presentTransaction,
  presentWithdrawal,
  providerInclude,
} from '../common/presenters.js';
import { num } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

class ReasonDto {
  @IsString() @MaxLength(255) reason: string;
}

class AccountStatusDto {
  @IsIn(['active', 'suspended']) status: 'active' | 'suspended';
}

class WithdrawalStatusDto {
  @IsIn(['paid', 'declined']) status: 'paid' | 'declined';
}

class RatesDto {
  @Type(() => Number) @IsNumber() @Min(0) bls: number;
  @Type(() => Number) @IsNumber() @Min(0) als: number;
  @Type(() => Number) @IsNumber() @Min(0) erv: number;
}

class PlansDto {
  @Type(() => Number) @IsNumber() @Min(0) basic: number;
  @Type(() => Number) @IsNumber() @Min(0) family: number;
  @Type(() => Number) @IsNumber() @Min(0) annual: number;
}

class SettingsDto {
  @IsObject() @ValidateNested() @Type(() => RatesDto) baseRates: RatesDto;
  @Type(() => Number) @IsNumber() @Min(0) perKmRate: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) commissionPercent: number;
  @Type(() => Number) @IsNumber() @Min(0) deliveryBaseFee: number;
  @IsObject() @ValidateNested() @Type(() => PlansDto) plans: PlansDto;
  @IsBoolean() autoApproveProviders: boolean;
  @IsBoolean() maintenanceMode: boolean;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

@Controller('admin')
@Auth('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly tokens: TokensService,
    private readonly orders: OrdersService,
  ) {}

  @Get('dashboard')
  async dashboard() {
    const today = { gte: startOfToday() };
    const db = this.prisma;
    const [
      requesters,
      providers,
      pendingVerification,
      online,
      byType,
      activeEmergencies,
      unassigned,
      completedToday,
      activeOrders,
      deliveredToday,
      revenue,
      revenueToday,
      pendingWithdrawals,
    ] = await Promise.all([
      db.user.count({ where: { role: 'requester' } }),
      db.provider.count(),
      db.provider.count({ where: { verification: 'pending' } }),
      db.provider.count({ where: { online: true } }),
      db.provider.groupBy({ by: ['type'], _count: { _all: true } }),
      db.emergencyRequest.count({ where: { status: { in: ['searching', 'negotiating', 'en_route', 'on_trip'] } } }),
      db.emergencyRequest.count({ where: { status: { in: ['searching', 'negotiating'] } } }),
      db.emergencyRequest.count({ where: { status: 'completed', completedAt: today } }),
      db.supplyOrder.count({ where: { status: { in: ['pending', 'accepted', 'picked_up'] } } }),
      db.supplyOrder.count({ where: { status: 'delivered', deliveredAt: today } }),
      db.transaction.aggregate({ where: { status: 'successful' }, _sum: { amount: true, commission: true } }),
      db.transaction.aggregate({ where: { status: 'successful', createdAt: today }, _sum: { amount: true } }),
      db.withdrawal.aggregate({ where: { status: 'pending' }, _count: { _all: true }, _sum: { amount: true } }),
    ]);

    return {
      data: {
        requesters,
        providers: {
          total: providers,
          pendingVerification,
          online,
          byType: Object.fromEntries(byType.map((g) => [g.type, g._count._all])),
        },
        emergencies: { active: activeEmergencies, unassigned, completedToday },
        orders: { active: activeOrders, deliveredToday },
        revenue: {
          gross: num(revenue._sum.amount),
          commission: num(revenue._sum.commission),
          today: num(revenueToday._sum.amount),
        },
        pendingWithdrawals: { count: pendingWithdrawals._count._all, amount: num(pendingWithdrawals._sum.amount) },
      },
    };
  }

  // ---------- Providers ----------

  @Get('providers')
  async providers(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const term = query.search;
    const where: Prisma.ProviderWhereInput = {
      ...(query.type && { type: query.type }),
      ...(query.verification && { verification: query.verification }),
      ...(term && {
        OR: [
          { businessName: { contains: term, mode: 'insensitive' } },
          { contactName: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.provider.findMany({ where, include: providerInclude, orderBy: { submittedAt: { sort: 'desc', nulls: 'last' } }, skip, take }),
      this.prisma.provider.count({ where }),
    ]);
    return paginate(rows.map(presentProvider), total, page, perPage);
  }

  private async provider(id: number) {
    const p = await this.prisma.provider.findUnique({ where: { id }, include: providerInclude });
    if (!p) throw new NotFoundException('Not found.');
    return p;
  }

  @Get('providers/:id')
  async showProvider(@Param('id', ParseIntPipe) id: number) {
    return { data: presentProvider(await this.provider(id)) };
  }

  @Post('providers/:id/approve')
  @HttpCode(200)
  async approve(@Param('id', ParseIntPipe) id: number) {
    await this.provider(id);
    const p = await this.prisma.provider.update({ where: { id }, data: { verification: 'approved', rejectionReason: null } });
    await this.notifier.providerReviewed(p);
    return this.showProvider(id);
  }

  @Post('providers/:id/reject')
  @HttpCode(200)
  async reject(@Param('id', ParseIntPipe) id: number, @Body() dto: ReasonDto) {
    await this.provider(id);
    const p = await this.prisma.provider.update({ where: { id }, data: { verification: 'rejected', rejectionReason: dto.reason, online: false } });
    await this.notifier.providerReviewed(p);
    return this.showProvider(id);
  }

  @Patch('providers/:id/status')
  async providerStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: AccountStatusDto) {
    const p = await this.provider(id);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: p.userId }, data: { accountStatus: dto.status } }),
      ...(dto.status === 'suspended' ? [this.prisma.provider.update({ where: { id }, data: { online: false } })] : []),
    ]);
    // Sign them out everywhere
    if (dto.status === 'suspended') await this.tokens.revokeAll(p.userId);
    return this.showProvider(id);
  }

  // ---------- Patients ----------

  private readonly requesterCounts = { _count: { select: { emergencyRequests: true, supplyOrders: true } } } as const;

  @Get('requesters')
  async requesters(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const term = query.search;
    const where: Prisma.UserWhereInput = {
      role: 'requester',
      ...(query.status && { accountStatus: query.status }),
      ...(term && {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
          { email: { contains: term, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, include: this.requesterCounts, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(rows.map(presentRequester), total, page, perPage);
  }

  @Patch('requesters/:id/status')
  async requesterStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: AccountStatusDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== 'requester') throw new NotFoundException('Not found.');
    const updated = await this.prisma.user.update({ where: { id }, data: { accountStatus: dto.status }, include: this.requesterCounts });
    if (dto.status === 'suspended') await this.tokens.revokeAll(id);
    return { data: presentRequester(updated) };
  }

  // ---------- Orders ----------

  @Get('orders')
  async orderList(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const where = query.status ? { status: { in: query.status.split(',') } } : {};
    const [rows, total] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.supplyOrder.count({ where }),
    ]);
    return paginate(rows.map(presentOrder), total, page, perPage);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancelOrder(@Param('id', ParseIntPipe) id: number) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Not found.');
    if (['delivered', 'cancelled'].includes(o.status)) throw new ConflictException('This order is already closed.');
    return { data: await this.orders.cancel(id, true) };
  }

  // ---------- Payments ----------

  @Get('transactions')
  async transactions(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const where = { ...(query.kind && { kind: query.kind }), ...(query.status && { status: query.status }) };
    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, include: { payer: true, payee: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.transaction.count({ where }),
    ]);
    return paginate(rows.map(presentTransaction), total, page, perPage);
  }

  /** Marks the transaction refunded. TODO: also call the gateway's refund API once one is connected. */
  @Post('transactions/:id/refund')
  @HttpCode(200)
  async refund(@Param('id', ParseIntPipe) id: number) {
    const t = await this.prisma.transaction.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Not found.');
    if (t.status !== 'successful') throw new ConflictException('Only successful payments can be refunded.');
    await this.payments.refund(id);
    return { data: presentTransaction(await this.prisma.transaction.findUniqueOrThrow({ where: { id }, include: { payer: true, payee: true } })) };
  }

  @Get('withdrawals')
  async withdrawals(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({ where, include: { provider: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return paginate(rows.map(presentWithdrawal), total, page, perPage);
  }

  @Patch('withdrawals/:id/status')
  async withdrawalStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: WithdrawalStatusDto) {
    const w = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Not found.');
    if (w.status !== 'pending') throw new ConflictException('This withdrawal has already been processed.');
    const updated = await this.prisma.withdrawal.update({ where: { id }, data: { status: dto.status }, include: { provider: true } });
    await this.notifier.withdrawalProcessed(updated);
    return { data: presentWithdrawal(updated) };
  }

  // ---------- Settings ----------

  @Get('settings')
  async showSettings() {
    return { data: await this.settings.platform() };
  }

  @Put('settings')
  async updateSettings(@Body() dto: SettingsDto) {
    return {
      data: await this.settings.save({
        baseRates: { bls: dto.baseRates.bls, als: dto.baseRates.als, erv: dto.baseRates.erv },
        perKmRate: dto.perKmRate,
        commissionPercent: dto.commissionPercent,
        deliveryBaseFee: dto.deliveryBaseFee,
        plans: { basic: dto.plans.basic, family: dto.plans.family, annual: dto.plans.annual },
        autoApproveProviders: dto.autoApproveProviders,
        maintenanceMode: dto.maintenanceMode,
      }),
    };
  }
}
