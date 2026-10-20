import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WalletService } from './wallet.service.js';
import { num, reference, round2 } from '../common/money.js';

export type PayableType = 'emergency_request' | 'supply_order';

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
  ) {}

  async commissionOn(amount: number): Promise<number> {
    return round2(amount * (await this.settings.commissionRate()));
  }

  /** What a provider keeps from an amount after Lifeline's commission. */
  async afterCommission(amount: number): Promise<number> {
    return round2(amount - (await this.commissionOn(amount)));
  }

  /**
   * Record a payment from a patient. Wallet payments spend the stored
   * balance; card/transfer are treated as successful (demo mode).
   * TODO: Paystack initialise -> verify webhook before marking successful.
   */
  async charge(input: {
    payerId: number;
    kind: 'ambulance' | 'supplies' | 'subscription';
    amount: number;
    commission: number;
    method: string;
    payeeProviderId?: number | null;
    payeeName?: string | null;
    payable?: { type: PayableType; id: number } | null;
    tx?: Tx;
  }) {
    const run = async (db: Tx) => {
      if (input.method === 'wallet') {
        await this.wallet.debit(input.payerId, input.amount, describe(input.kind, input.payeeName), db);
      }
      return db.transaction.create({
        data: {
          reference: reference(),
          kind: input.kind,
          payerId: input.payerId,
          payeeProviderId: input.payeeProviderId ?? null,
          payableType: input.payable?.type ?? null,
          payableId: input.payable?.id ?? null,
          amount: input.amount,
          commission: input.commission,
          method: input.method,
          status: 'successful',
        },
      });
    };
    return input.tx ? run(input.tx) : this.prisma.$transaction(run);
  }

  /** Refund every successful payment for a trip/order (wallet ones go back to the wallet). */
  async refundFor(type: PayableType, id: number, tx?: Tx) {
    const run = async (db: Tx) => {
      const txs = await db.transaction.findMany({ where: { payableType: type, payableId: id, status: 'successful' }, include: { payee: true } });
      for (const t of txs) await this.refundOne(t, db);
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** TODO: card/transfer refunds also need the gateway's refund API once connected. */
  async refund(transactionId: number) {
    return this.prisma.$transaction(async (db) => {
      const t = await db.transaction.findUniqueOrThrow({ where: { id: transactionId }, include: { payee: true } });
      await this.refundOne(t, db);
    });
  }

  private async refundOne(t: { id: number; method: string; payerId: number; amount: Prisma.Decimal; kind: string; payee: { businessName: string } | null }, db: Tx) {
    await db.transaction.update({ where: { id: t.id }, data: { status: 'refunded' } });
    if (t.method === 'wallet') {
      await this.wallet.refund(t.payerId, num(t.amount), `Refund: ${describe(t.kind, t.payee?.businessName)}`, db);
    }
  }
}

function describe(kind: string, payee?: string | null) {
  if (kind === 'ambulance') return `Ambulance trip${payee ? ` with ${payee}` : ''}`;
  if (kind === 'supplies') return `Medical supplies${payee ? ` from ${payee}` : ''}`;
  return 'Lifeline subscription';
}
