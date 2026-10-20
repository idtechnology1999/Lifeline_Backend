import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { PushService } from './push.service.js';
import { num } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

type RequestRow = Prisma.EmergencyRequestGetPayload<{ include: { provider: true } }>;
type OrderRow = Prisma.SupplyOrderGetPayload<{ include: { requester: true; supplier: true; dispatcher: true; items: true } }>;
type ProviderRow = Prisma.ProviderGetPayload<object>;

/**
 * One method per event people care about. Each notification is saved to the
 * user's inbox, sent over the WebSocket, and pushed to their phones via FCM.
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger('Notifier');

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  async send(userId: number | null | undefined, type: string, title: string, body: string, data: Record<string, string> = {}) {
    if (!userId) return;
    // Never fail the action that triggered this: it has already happened
    try {
      const n = await this.prisma.appNotification.create({ data: { userId, type, title, body, data } });
      this.realtime.emit(`user:${userId}`, 'notification', {
        id: String(n.id),
        type,
        title,
        body,
        data,
        read: false,
        createdAt: n.createdAt.toISOString(),
      });
      void this.push.send(userId, title, body, { type, ...data });
    } catch (err) {
      this.logger.error(`notification ${type} for user ${userId} failed: ${(err as Error).message}`);
    }
  }

  // ---------- Ambulance ----------

  async newEmergency(r: { id: number; pickup: string; destination: string }) {
    const ambulances = await this.prisma.provider.findMany({
      where: { type: 'ambulance', verification: 'approved', online: true },
      select: { userId: true },
    });
    await Promise.all(
      ambulances.map((a) => this.send(a.userId, 'new_emergency', 'New emergency nearby', `${r.pickup} → ${r.destination}`, { requestId: String(r.id) })),
    );
  }

  offerReceived(r: { id: number; requesterId: number }, provider: ProviderRow, amount: number) {
    return this.send(r.requesterId, 'offer_received', `${provider.businessName} can help`, `Their price is ${naira(amount)}. Tap to accept or counter.`, {
      requestId: String(r.id),
    });
  }

  counterReceived(r: { id: number; destination: string }, provider: ProviderRow, amount: number) {
    return this.send(provider.userId, 'counter_received', 'Patient sent a counter-offer', `They offered ${naira(amount)} for the trip to ${r.destination}.`, {
      requestId: String(r.id),
    });
  }

  async priceAgreed(r: RequestRow) {
    const price = naira(num(r.agreedPrice));
    await this.send(r.requesterId, 'ambulance_assigned', 'Ambulance on the way', `${r.provider?.businessName} accepted ${price}.`, { requestId: String(r.id) });
    await this.send(r.provider?.userId, 'trip_assigned', 'Trip confirmed - head to pickup', `${r.pickup}. Agreed fare ${price}.`, { requestId: String(r.id) });
  }

  tripStarted(r: { id: number; requesterId: number; destination: string }) {
    return this.send(r.requesterId, 'trip_started', 'On the way to hospital', `Heading to ${r.destination}.`, { requestId: String(r.id) });
  }

  async tripCompleted(r: RequestRow, earned: number) {
    await this.send(r.requesterId, 'trip_completed', 'Trip completed', `You've arrived at ${r.destination}. Get well soon.`, { requestId: String(r.id) });
    await this.send(r.provider?.userId, 'earning', 'Trip completed', `${naira(earned)} added to your earnings.`, { requestId: String(r.id) });
  }

  async requestCancelled(r: { id: number; requesterId: number; pickup: string; providerId: number | null }, byAdmin = false) {
    const offers = await this.prisma.emergencyRequestOffer.findMany({ where: { emergencyRequestId: r.id }, include: { provider: true } });
    const userIds = new Set(offers.map((o) => o.provider.userId));
    if (r.providerId) {
      const p = await this.prisma.provider.findUnique({ where: { id: r.providerId } });
      if (p) userIds.add(p.userId);
    }
    for (const id of userIds) {
      await this.send(id, 'request_cancelled', 'Request cancelled', `The emergency at ${r.pickup} was cancelled.`, { requestId: String(r.id) });
    }
    if (byAdmin) {
      await this.send(r.requesterId, 'request_cancelled', 'Request cancelled by Lifeline', 'Any payment has been refunded. Call 112 if you still need help.', {
        requestId: String(r.id),
      });
    }
  }

  // ---------- Supplies ----------

  newOrder(o: OrderRow) {
    const qty = o.items.reduce((n, i) => n + i.qty, 0);
    return this.send(o.supplier?.userId, 'new_order', 'New order', `${o.requester?.name} ordered ${qty} items (${naira(num(o.subtotal))}).`, { orderId: String(o.id) });
  }

  async orderAccepted(o: OrderRow) {
    await this.send(o.requesterId, 'order_accepted', 'Order accepted', `${o.supplier?.businessName} is preparing your order.`, { orderId: String(o.id) });
    const riders = await this.prisma.provider.findMany({
      where: { type: 'dispatcher', verification: 'approved', online: true },
      select: { userId: true },
    });
    await Promise.all(
      riders.map((r) =>
        this.send(r.userId, 'delivery_available', 'Delivery available', `Pick up at ${o.supplier?.businessName}. Earn ${naira(num(o.deliveryFee))}.`, {
          orderId: String(o.id),
        }),
      ),
    );
  }

  orderDeclined(o: OrderRow) {
    return this.send(o.requesterId, 'order_declined', 'Order declined', `${o.supplier?.businessName} couldn't fill your order. Any payment has been refunded.`, {
      orderId: String(o.id),
    });
  }

  async riderAssigned(o: OrderRow) {
    const rider = o.dispatcher?.businessName;
    await this.send(o.requesterId, 'rider_assigned', 'Rider assigned', `${rider} will deliver your order.`, { orderId: String(o.id) });
    await this.send(o.supplier?.userId, 'rider_assigned', 'Rider on the way', `${rider} is coming to collect order #${o.id}.`, { orderId: String(o.id) });
  }

  orderPickedUp(o: OrderRow) {
    return this.send(o.requesterId, 'order_picked_up', 'Out for delivery', `${o.dispatcher?.businessName} has your order.`, { orderId: String(o.id) });
  }

  async orderDelivered(o: OrderRow, supplierEarned: number) {
    await this.send(o.requesterId, 'order_delivered', 'Order delivered', 'Your medical supplies have arrived.', { orderId: String(o.id) });
    await this.send(o.supplier?.userId, 'earning', 'Order delivered', `${naira(supplierEarned)} added to your earnings.`, { orderId: String(o.id) });
    await this.send(o.dispatcher?.userId, 'earning', 'Delivery completed', `${naira(num(o.deliveryFee))} added to your earnings.`, { orderId: String(o.id) });
  }

  async orderCancelled(o: OrderRow, byAdmin = false) {
    await this.send(o.supplier?.userId, 'order_cancelled', 'Order cancelled', `Order #${o.id} was cancelled.`, { orderId: String(o.id) });
    await this.send(o.dispatcher?.userId, 'order_cancelled', 'Delivery cancelled', `Order #${o.id} was cancelled.`, { orderId: String(o.id) });
    if (byAdmin) await this.send(o.requesterId, 'order_cancelled', 'Order cancelled by Lifeline', 'Any payment has been refunded.', { orderId: String(o.id) });
  }

  // ---------- Accounts ----------

  providerReviewed(p: ProviderRow) {
    if (p.verification === 'approved') {
      return this.send(p.userId, 'provider_approved', "You're verified!", 'Your Lifeline account is approved. Go online to start receiving requests.');
    }
    if (p.verification === 'rejected') {
      return this.send(p.userId, 'provider_rejected', 'Application needs changes', p.rejectionReason ?? 'Please update your details and resubmit.');
    }
  }

  withdrawalProcessed(w: { status: string; amount: Prisma.Decimal; bank: string; provider: ProviderRow }) {
    const paid = w.status === 'paid';
    return this.send(
      w.provider.userId,
      `withdrawal_${w.status}`,
      paid ? 'Withdrawal paid' : 'Withdrawal declined',
      paid
        ? `${naira(num(w.amount))} sent to your ${w.bank} account.`
        : `Your withdrawal of ${naira(num(w.amount))} was declined. The money is back in your balance.`,
    );
  }
}
