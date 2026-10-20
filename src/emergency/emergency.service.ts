import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveService } from '../realtime/live.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { requestInclude, presentRequest } from '../common/presenters.js';

export const OPEN_STATUSES = ['searching', 'negotiating'];
export const ACTIVE_STATUSES = ['searching', 'negotiating', 'en_route', 'on_trip'];
export const SEVERITIES = ['red', 'yellow', 'green', 'black'];
export const AMBULANCE_TYPES = ['bls', 'als', 'erv'];

@Injectable()
export class EmergencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly notifier: NotifierService,
    private readonly payments: PaymentService,
  ) {}

  /** Load a request with what the apps show (and optionally some offers). */
  async present(id: number, offers?: 'open' | { providerId: number }) {
    const r = await this.prisma.emergencyRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
    if (!offers) return presentRequest(r);
    const rows = await this.prisma.emergencyRequestOffer.findMany({
      where: { emergencyRequestId: id, ...(offers === 'open' ? { status: 'open' } : { providerId: offers.providerId }) },
      include: { provider: true },
      orderBy: { id: 'asc' },
    });
    return presentRequest({ ...r, offers: rows });
  }

  /**
   * Close the negotiation on this offer: assign its provider at its price and
   * reject every other offer. Locks the row so two accepts can't race.
   */
  async acceptOffer(requestId: number, offerId: number) {
    await this.prisma.$transaction(async (db) => {
      const [locked] = await db.$queryRaw<{ status: string }[]>`SELECT status FROM emergency_requests WHERE id = ${requestId} FOR UPDATE`;
      const offer = await db.emergencyRequestOffer.findUnique({ where: { id: offerId } });
      if (!locked || !OPEN_STATUSES.includes(locked.status) || offer?.status !== 'open') {
        throw new ConflictException('This request is no longer open for offers.');
      }
      await db.emergencyRequestOffer.update({ where: { id: offerId }, data: { status: 'accepted' } });
      await db.emergencyRequestOffer.updateMany({
        where: { emergencyRequestId: requestId, id: { not: offerId }, status: 'open' },
        data: { status: 'rejected' },
      });
      await db.emergencyRequest.update({
        where: { id: requestId },
        data: { providerId: offer.providerId, agreedPrice: offer.amount, etaMinutes: offer.etaMinutes, status: 'en_route' },
      });
    });

    const updated = await this.prisma.emergencyRequest.findUniqueOrThrow({ where: { id: requestId }, include: { provider: true } });
    await this.notifier.priceAgreed(updated);
    void this.live.request(requestId);
  }

  /** Cancel (patient or admin): rejects open offers and refunds any payment. */
  async cancel(requestId: number, byAdmin: boolean) {
    const r = await this.prisma.$transaction(async (db) => {
      const req = await db.emergencyRequest.update({ where: { id: requestId }, data: { status: 'cancelled' } });
      await db.emergencyRequestOffer.updateMany({ where: { emergencyRequestId: requestId, status: 'open' }, data: { status: 'rejected' } });
      if (req.paidAt) await this.payments.refundFor('emergency_request', requestId, db);
      return req;
    });
    await this.notifier.requestCancelled(r, byAdmin);
    void this.live.request(requestId);
  }
}
