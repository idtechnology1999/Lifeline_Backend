import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { num, reference, round2 } from '../common/money.js';

export const MIN_FUND = 100;
export const MAX_FUND = 1_000_000;

/** A patient's prepaid wallet. Every change is a WalletEntry. */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Top up. TODO: like PaymentService, this treats the card/transfer payment
   * as successful straight away; move it behind the payment gateway.
   */
  fund(userId: number, amount: number, method: string, tx?: Tx) {
    return this.apply(userId, 'fund', amount, 'Wallet funded', method, tx);
  }

  /** Take money out for a payment. 422 if the balance is too low. */
  debit(userId: number, amount: number, description: string, tx?: Tx) {
    return this.apply(userId, 'payment', -amount, description, null, tx);
  }

  refund(userId: number, amount: number, description: string, tx?: Tx) {
    return this.apply(userId, 'refund', amount, description, null, tx);
  }

  private async apply(userId: number, type: string, amount: number, description: string, method: string | null, tx?: Tx) {
    const run = async (db: Tx) => {
      // Lock the row so two payments can't spend the same naira
      const rows = await db.$queryRaw<{ wallet_balance: string }[]>`SELECT wallet_balance FROM users WHERE id = ${userId} FOR UPDATE`;
      const balance = round2(num(rows[0]?.wallet_balance) + amount);
      if (balance < 0) {
        throw new UnprocessableEntityException('Your wallet balance is too low. Fund your wallet or choose another payment method.');
      }
      await db.user.update({ where: { id: userId }, data: { walletBalance: balance } });
      return db.walletEntry.create({
        data: { userId, type, amount, balanceAfter: balance, description, method, reference: reference('LLW') },
      });
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }
}
