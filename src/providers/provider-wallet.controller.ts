import { Body, Controller, Get, Post, Query, UnprocessableEntityException, HttpCode } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsString, Matches, MaxLength, Min } from 'class-validator';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { ApprovedProvider, Auth, CurrentProvider } from '../auth/guards.js';
import { pageParams, paginate } from '../common/http.js';
import { presentWithdrawal } from '../common/presenters.js';
import { iso, num, round2 } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

type Provider = Prisma.ProviderGetPayload<object>;

class WithdrawDto {
  @Type(() => Number) @IsNumber() @Min(1000) amount: number;
  @IsString() @MaxLength(80) bank: string;
  @IsString() @MaxLength(120) accountName: string;
  @Matches(/^\d{10}$/, { message: 'The account number must be 10 digits.' }) accountNumber: string;
}

/** Earnings minus withdrawals that are pending or already paid out. */
export async function availableBalance(db: Tx | PrismaService, providerId: number) {
  // Sequential: inside a transaction both queries share one connection
  const provider = await db.provider.findUniqueOrThrow({ where: { id: providerId } });
  const withdrawn = await db.withdrawal.aggregate({ where: { providerId, status: { in: ['pending', 'paid'] } }, _sum: { amount: true } });
  return round2(num(provider.earnings) - num(withdrawn._sum.amount));
}

/** Earnings and withdrawals, for every provider type. */
@Controller('provider')
@Auth('provider')
@ApprovedProvider()
export class ProviderWalletController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  @Get('earnings')
  async earnings(@CurrentProvider() p: Provider) {
    const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id: p.id } });
    return {
      data: {
        totalEarnings: num(provider.earnings),
        availableBalance: await availableBalance(this.prisma, provider.id),
        completedJobs: provider.completedJobs,
        recent: await this.recentJobs(provider),
      },
    };
  }

  /** Recent paid-out jobs, shaped for the app's Earnings screens. */
  private async recentJobs(provider: Provider) {
    if (provider.type === 'ambulance') {
      const trips = await this.prisma.emergencyRequest.findMany({
        where: { providerId: provider.id, status: 'completed' },
        include: { requester: true },
        orderBy: { completedAt: 'desc' },
        take: 30,
      });
      return Promise.all(
        trips.map(async (r) => ({
          id: String(r.id),
          title: r.requester?.name ?? null,
          subtitle: `${r.ambulanceType.toUpperCase()} · ${r.destination}`,
          amount: await this.payments.afterCommission(num(r.agreedPrice)),
          date: iso(r.completedAt),
        })),
      );
    }

    const where = provider.type === 'supplier' ? { supplierId: provider.id } : { dispatcherId: provider.id };
    const orders = await this.prisma.supplyOrder.findMany({
      where: { ...where, status: 'delivered' },
      include: { requester: true, supplier: true, items: true },
      orderBy: { deliveredAt: 'desc' },
      take: 30,
    });
    return Promise.all(
      orders.map(async (o) =>
        provider.type === 'supplier'
          ? {
              id: String(o.id),
              title: o.requester?.name ?? null,
              subtitle: `${o.items.reduce((s, i) => s + i.qty, 0)} items`,
              amount: await this.payments.afterCommission(num(o.subtotal)),
              date: iso(o.deliveredAt),
            }
          : {
              id: String(o.id),
              title: o.supplier?.businessName ?? null,
              subtitle: `To ${o.requester?.name ?? ''}`,
              amount: num(o.deliveryFee),
              date: iso(o.deliveredAt),
            },
      ),
    );
  }

  @Get('withdrawals')
  async withdrawals(@CurrentProvider() provider: Provider, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 20);
    const where = { providerId: provider.id };
    const [rows, total] = await Promise.all([
      this.prisma.withdrawal.findMany({ where, include: { provider: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return paginate(rows.map(presentWithdrawal), total, page, perPage);
  }

  @Post('withdrawals')
  @HttpCode(201)
  async withdraw(@CurrentProvider() provider: Provider, @Body() dto: WithdrawDto) {
    const withdrawal = await this.prisma.$transaction(async (db) => {
      // Lock the provider so two withdrawals can't both pass the balance check
      await db.$queryRaw`SELECT id FROM providers WHERE id = ${provider.id} FOR UPDATE`;
      if (dto.amount > (await availableBalance(db, provider.id))) {
        throw new UnprocessableEntityException('You cannot withdraw more than your available balance.');
      }
      return db.withdrawal.create({
        data: { providerId: provider.id, amount: dto.amount, bank: dto.bank, accountName: dto.accountName, accountNumber: dto.accountNumber },
        include: { provider: true },
      });
    });
    return { data: presentWithdrawal(withdrawal) };
  }
}
