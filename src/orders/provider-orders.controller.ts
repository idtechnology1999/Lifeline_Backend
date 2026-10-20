import { ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { LiveService } from '../realtime/live.service.js';
import { ApprovedProvider, Auth, CurrentProvider } from '../auth/guards.js';
import { OrdersService } from './orders.service.js';
import { pageParams, paginate } from '../common/http.js';
import { orderInclude, presentOrder } from '../common/presenters.js';
import { num } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

type Provider = Prisma.ProviderGetPayload<object>;

/** Orders placed with a pharmacy. */
@Controller('provider/orders')
@Auth('provider')
@ApprovedProvider('supplier')
export class SupplierOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly live: LiveService,
    private readonly orders: OrdersService,
  ) {}

  private async own(provider: Provider, id: number) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id } });
    if (!o || o.supplierId !== provider.id) throw new NotFoundException('Not found.');
    return o;
  }

  @Get()
  async index(@CurrentProvider() provider: Provider, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 100);
    const where = { supplierId: provider.id, ...(query.status && { status: { in: query.status.split(',') } }) };
    const [rows, total] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.supplyOrder.count({ where }),
    ]);
    return paginate(rows.map(presentOrder), total, page, perPage);
  }

  @Get(':id')
  async show(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    await this.own(provider, id);
    return { data: await this.orders.present(id) };
  }

  /** Accepting reserves the stock and releases the order to riders. */
  @Post(':id/accept')
  @HttpCode(200)
  async accept(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    await this.own(provider, id);
    await this.prisma.$transaction(async (db) => {
      const [locked] = await db.$queryRaw<{ status: string }[]>`SELECT status FROM supply_orders WHERE id = ${id} FOR UPDATE`;
      if (locked?.status !== 'pending') throw new ConflictException('Only pending orders can be accepted.');
      const items = await db.supplyOrderItem.findMany({ where: { supplyOrderId: id } });
      for (const item of items) {
        const [product] = item.productId
          ? await db.$queryRaw<{ stock: number }[]>`SELECT stock FROM products WHERE id = ${item.productId} FOR UPDATE`
          : [];
        if (!product || product.stock < item.qty) throw new ConflictException(`Not enough ${item.name} in stock to accept this order.`);
        await db.product.update({ where: { id: item.productId! }, data: { stock: { decrement: item.qty } } });
      }
      await db.supplyOrder.update({ where: { id }, data: { status: 'accepted' } });
    });
    const order = await this.prisma.supplyOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
    await this.notifier.orderAccepted(order);
    void this.live.order(id);
    return { data: presentOrder(order) };
  }

  @Post(':id/decline')
  @HttpCode(200)
  async decline(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const o = await this.own(provider, id);
    if (o.status !== 'pending') throw new ConflictException('Only pending orders can be declined.');
    await this.prisma.$transaction(async (db) => {
      await db.supplyOrder.update({ where: { id }, data: { status: 'cancelled' } });
      if (o.paidAt) await this.payments.refundFor('supply_order', id, db);
    });
    const order = await this.prisma.supplyOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
    await this.notifier.orderDeclined(order);
    void this.live.order(id);
    return { data: presentOrder(order) };
  }
}

/** The dispatcher (rider) side of a supply order. */
@Controller('provider/deliveries')
@Auth('provider')
@ApprovedProvider('dispatcher')
export class DeliveriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly live: LiveService,
  ) {}

  /** Orders a pharmacy has accepted that no rider has taken yet. */
  @Get('available')
  async available(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 100);
    const where = { status: 'accepted', dispatcherId: null };
    const [rows, total] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where, include: orderInclude, orderBy: [{ urgent: 'desc' }, { createdAt: 'asc' }], skip, take }),
      this.prisma.supplyOrder.count({ where }),
    ]);
    return paginate(rows.map(presentOrder), total, page, perPage);
  }

  @Get()
  async index(@CurrentProvider() provider: Provider, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 100);
    const where = { dispatcherId: provider.id, ...(query.status && { status: { in: query.status.split(',') } }) };
    const [rows, total] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.supplyOrder.count({ where }),
    ]);
    return paginate(rows.map(presentOrder), total, page, perPage);
  }

  @Post(':id/accept')
  @HttpCode(200)
  async accept(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    await this.prisma.$transaction(async (db) => {
      const [locked] = await db.$queryRaw<{ status: string; dispatcher_id: number | null }[]>`
        SELECT status, dispatcher_id FROM supply_orders WHERE id = ${id} FOR UPDATE`;
      if (!locked) throw new NotFoundException('Not found.');
      if (locked.status !== 'accepted' || locked.dispatcher_id) throw new ConflictException('Another rider has already taken this delivery.');
      const active = await db.supplyOrder.count({ where: { dispatcherId: provider.id, status: { in: ['accepted', 'picked_up'] } } });
      if (active) throw new ConflictException('Finish your current delivery before accepting another.');
      await db.supplyOrder.update({ where: { id }, data: { dispatcherId: provider.id } });
    });
    const order = await this.prisma.supplyOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
    await this.notifier.riderAssigned(order);
    void this.live.order(id);
    return { data: presentOrder(order) };
  }

  /** "I've collected the order" from the pharmacy. */
  @Post(':id/pickup')
  @HttpCode(200)
  async pickup(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const o = await this.mine(provider, id);
    if (o.status !== 'accepted') throw new ConflictException('This order is not waiting for pickup.');
    const order = await this.prisma.supplyOrder.update({ where: { id }, data: { status: 'picked_up' }, include: orderInclude });
    await this.notifier.orderPickedUp(order);
    void this.live.order(id);
    return { data: presentOrder(order) };
  }

  /** "I've delivered": pays out the pharmacy and the rider. */
  @Post(':id/deliver')
  @HttpCode(200)
  async deliver(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const o = await this.mine(provider, id);
    if (o.status !== 'picked_up') throw new ConflictException('Pick up the order before marking it delivered.');
    const supplierEarned = await this.payments.afterCommission(num(o.subtotal));
    await this.prisma.$transaction([
      this.prisma.supplyOrder.update({ where: { id }, data: { status: 'delivered', deliveredAt: new Date() } }),
      this.prisma.provider.update({ where: { id: o.supplierId }, data: { completedJobs: { increment: 1 }, earnings: { increment: supplierEarned } } }),
      this.prisma.provider.update({ where: { id: provider.id }, data: { completedJobs: { increment: 1 }, earnings: { increment: num(o.deliveryFee) } } }),
    ]);
    const order = await this.prisma.supplyOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
    await this.notifier.orderDelivered(order, supplierEarned);
    void this.live.order(id);
    return { data: presentOrder(order) };
  }

  private async mine(provider: Provider, id: number) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id } });
    if (!o || o.dispatcherId !== provider.id) throw new NotFoundException('Not found.');
    return o;
  }
}
