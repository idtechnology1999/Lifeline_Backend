import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { LiveService } from '../realtime/live.service.js';
import { Auth, CurrentUser, type AuthUser } from '../auth/guards.js';
import { OrdersService } from './orders.service.js';
import { FieldErrors, fieldError, pageParams, paginate } from '../common/http.js';
import { orderInclude, presentOrder } from '../common/presenters.js';
import { num, round2 } from '../common/money.js';

class OrderItemDto {
  @Type(() => Number) @IsInt() productId: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) qty: number;
}

class PlaceOrderDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
  @IsString() @MaxLength(255) deliveryAddress: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) deliveryLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) deliveryLng?: number;
  @IsOptional() @IsString() @MaxLength(500) deliveryNote?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
}

class PayDto {
  @IsIn(['card', 'transfer', 'wallet']) method: string;
}

@Controller('orders')
@Auth('requester')
export class RequesterOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly live: LiveService,
    private readonly orders: OrdersService,
  ) {}

  private async own(user: AuthUser, id: number) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id } });
    if (!o || o.requesterId !== user.id) throw new NotFoundException('Not found.');
    return o;
  }

  @Get()
  async index(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 100);
    const where = { requesterId: user.id, ...(query.status && { status: query.status }) };
    const [rows, total] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.supplyOrder.count({ where }),
    ]);
    return paginate(rows.map(presentOrder), total, page, perPage);
  }

  @Post()
  @HttpCode(201)
  async store(@CurrentUser() user: AuthUser, @Body() dto: PlaceOrderDto) {
    const ids = dto.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) fieldError('items', 'Each product can only appear once in an order.');

    const products = await this.prisma.product.findMany({ where: { id: { in: ids } }, include: { supplier: true } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = dto.items.findIndex((i) => !byId.has(i.productId));
    if (missing >= 0) fieldError(`items.${missing}.productId`, 'The selected product is invalid.');
    if (new Set(products.map((p) => p.supplierId)).size > 1) fieldError('items', 'All items in one order must come from the same pharmacy.');

    const stockErrors: Record<string, string[]> = {};
    dto.items.forEach((item, i) => {
      const p = byId.get(item.productId)!;
      if (!p.available || p.supplier.verification !== 'approved' || p.stock < item.qty) {
        stockErrors[`items.${i}.qty`] = [`Only ${p.stock} of ${p.name} left in stock.`];
      }
    });
    if (Object.keys(stockErrors).length) throw new FieldErrors(stockErrors);

    await this.settings.abortIfMaintenance();
    const subtotal = round2(dto.items.reduce((s, i) => s + num(byId.get(i.productId)!.price) * i.qty, 0));
    const deliveryFee = (await this.settings.platform()).deliveryBaseFee;

    const order = await this.prisma.supplyOrder.create({
      data: {
        requesterId: user.id,
        supplierId: products[0].supplierId,
        deliveryAddress: dto.deliveryAddress,
        deliveryLat: dto.deliveryLat ?? null,
        deliveryLng: dto.deliveryLng ?? null,
        deliveryNote: dto.deliveryNote ?? null,
        urgent: dto.urgent ?? false,
        subtotal,
        deliveryFee,
        total: subtotal + deliveryFee,
        items: {
          create: dto.items.map((i) => {
            const p = byId.get(i.productId)!;
            return { productId: p.id, name: p.name, qty: i.qty, price: p.price, requiresPrescription: p.requiresPrescription };
          }),
        },
      },
      include: orderInclude,
    });
    await this.notifier.newOrder(order);
    return { data: presentOrder(order) };
  }

  @Get(':id')
  async show(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.own(user, id);
    return { data: await this.orders.present(id) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const o = await this.own(user, id);
    if (!['pending', 'accepted'].includes(o.status)) throw new ConflictException('This order has already been picked up and can no longer be cancelled.');
    return { data: await this.orders.cancel(id, false) };
  }

  @Post(':id/pay')
  @HttpCode(200)
  async pay(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PayDto) {
    const o = await this.own(user, id);
    if (o.status === 'cancelled' || o.paidAt) throw new ConflictException('This order cannot be paid for.');
    const supplier = await this.prisma.provider.findUnique({ where: { id: o.supplierId } });

    await this.prisma.$transaction(async (tx) => {
      await this.payments.charge({
        payerId: user.id,
        kind: 'supplies',
        amount: num(o.total),
        // Commission is on the goods only; the delivery fee goes to the rider in full
        commission: await this.payments.commissionOn(num(o.subtotal)),
        method: dto.method,
        payeeProviderId: o.supplierId,
        payeeName: supplier?.businessName,
        payable: { type: 'supply_order', id },
        tx,
      });
      await tx.supplyOrder.update({ where: { id }, data: { paidAt: new Date() } });
    });
    void this.live.order(id);
    return { data: await this.orders.present(id) };
  }
}
