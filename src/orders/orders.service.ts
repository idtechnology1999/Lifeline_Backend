import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { LiveService } from '../realtime/live.service.js';
import { orderInclude, presentOrder } from '../common/presenters.js';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly live: LiveService,
  ) {}

  async present(id: number) {
    return presentOrder(await this.prisma.supplyOrder.findUniqueOrThrow({ where: { id }, include: orderInclude }));
  }

  /** Cancel an order: give back reserved stock and refund any payment. */
  async cancel(id: number, byAdmin: boolean) {
    await this.prisma.$transaction(async (db) => {
      const order = await db.supplyOrder.findUniqueOrThrow({ where: { id }, include: { items: true } });
      // Stock was taken when the pharmacy accepted
      if (order.status === 'accepted' || order.status === 'picked_up') {
        for (const item of order.items) {
          if (item.productId) await db.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } }).catch(() => {});
        }
      }
      await db.supplyOrder.update({ where: { id }, data: { status: 'cancelled' } });
      if (order.paidAt) await this.payments.refundFor('supply_order', id, db);
    });
    const order = await this.prisma.supplyOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
    await this.notifier.orderCancelled(order, byAdmin);
    void this.live.order(id);
    return presentOrder(order);
  }
}
