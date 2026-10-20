import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { LiveService } from '../realtime/live.service.js';
import { ApprovedProvider, Auth, CurrentProvider } from '../auth/guards.js';
import { EmergencyService, OPEN_STATUSES } from './emergency.service.js';
import { pageParams, paginate } from '../common/http.js';
import { presentRequest, requestInclude } from '../common/presenters.js';
import { num } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';

type Provider = Prisma.ProviderGetPayload<object>;

class OfferDto {
  @Type(() => Number) @IsNumber() @Min(500) amount: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(240) etaMinutes?: number;
}

/** The ambulance driver's side of an emergency request. */
@Controller('provider/emergency-requests')
@Auth('provider')
@ApprovedProvider('ambulance')
export class ProviderEmergencyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly live: LiveService,
    private readonly emergencies: EmergencyService,
  ) {}

  private mine(provider: Provider) {
    return { offers: { where: { providerId: provider.id }, include: { provider: true } } } as const;
  }

  /**
   * ?scope=open (default): requests still looking for an ambulance that this
   * provider hasn't declined, nearest first when we know where both are.
   * ?scope=mine: requests assigned to this provider.
   */
  @Get()
  async index(@CurrentProvider() provider: Provider, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 100);
    const where: Prisma.EmergencyRequestWhereInput =
      query.scope === 'mine'
        ? { providerId: provider.id, ...(query.status && { status: query.status }) }
        : { status: { in: OPEN_STATUSES }, offers: { none: { providerId: provider.id, status: 'rejected' } } };

    const [rows, total] = await Promise.all([
      this.prisma.emergencyRequest.findMany({ where, include: { ...requestInclude, ...this.mine(provider) }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.emergencyRequest.count({ where }),
    ]);

    let list = rows.map((r) => ({ ...presentRequest(r), distanceKm: null as number | null }));
    if (query.scope !== 'mine' && provider.latitude !== null && list.length) {
      // PostGIS: metres from this ambulance to each patient's pickup point
      const ids = rows.filter((r) => r.pickupLat !== null).map((r) => r.id);
      if (ids.length) {
        const distances = await this.prisma.$queryRaw<{ id: number; metres: number }[]>`
          SELECT r.id, ST_Distance(p.location, ST_SetSRID(ST_MakePoint(r.pickup_lng, r.pickup_lat), 4326)::geography) AS metres
          FROM emergency_requests r, providers p
          WHERE p.id = ${provider.id} AND p.location IS NOT NULL AND r.id = ANY(${ids})`;
        const byId = new Map(distances.map((d) => [d.id, Math.round(Number(d.metres) / 100) / 10]));
        list = list.map((r) => ({ ...r, distanceKm: byId.get(Number(r.id)) ?? null }));
        list.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      }
    }
    return paginate(list, total, page, perPage);
  }

  @Get(':id')
  async show(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r || (!OPEN_STATUSES.includes(r.status) && r.providerId !== provider.id)) throw new NotFoundException('Not found.');
    return { data: await this.emergencies.present(id, { providerId: provider.id }) };
  }

  /** Make or update this provider's price for the request. */
  @Post(':id/offer')
  @HttpCode(200)
  async offer(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number, @Body() dto: OfferDto) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Not found.');
    if (!OPEN_STATUSES.includes(r.status)) throw new ConflictException('This request is no longer open for offers.');

    await this.prisma.$transaction([
      this.prisma.emergencyRequestOffer.upsert({
        where: { emergencyRequestId_providerId: { emergencyRequestId: id, providerId: provider.id } },
        create: { emergencyRequestId: id, providerId: provider.id, amount: dto.amount, etaMinutes: dto.etaMinutes ?? null, lastBy: 'provider', status: 'open' },
        update: { amount: dto.amount, etaMinutes: dto.etaMinutes ?? null, lastBy: 'provider', status: 'open' },
      }),
      this.prisma.emergencyRequest.update({ where: { id }, data: { status: 'negotiating' } }),
    ]);
    await this.notifier.offerReceived(r, provider, dto.amount);
    void this.live.request(id);
    return { data: await this.emergencies.present(id, { providerId: provider.id }) };
  }

  /** Accept the patient's counter-offer. */
  @Post(':id/accept-counter')
  @HttpCode(200)
  async acceptCounter(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const offer = await this.prisma.emergencyRequestOffer.findFirst({ where: { emergencyRequestId: id, providerId: provider.id, status: 'open' } });
    if (!offer || offer.lastBy !== 'requester') throw new ConflictException('There is no counter-offer from the requester to accept.');
    await this.emergencies.acceptOffer(id, offer.id);
    return { data: await this.emergencies.present(id, { providerId: provider.id }) };
  }

  @Post(':id/decline')
  @HttpCode(200)
  async decline(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Not found.');
    if (!OPEN_STATUSES.includes(r.status)) throw new ConflictException('This request is no longer open.');
    await this.prisma.emergencyRequestOffer.upsert({
      where: { emergencyRequestId_providerId: { emergencyRequestId: id, providerId: provider.id } },
      create: { emergencyRequestId: id, providerId: provider.id, amount: r.estimatedPrice, lastBy: 'provider', status: 'rejected' },
      update: { status: 'rejected' },
    });
    void this.live.request(id);
    return { data: await this.emergencies.present(id, { providerId: provider.id }) };
  }

  /** Patient picked up; heading to the destination. */
  @Post(':id/start-trip')
  @HttpCode(200)
  async startTrip(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const r = await this.assigned(provider, id);
    if (r.status !== 'en_route') throw new ConflictException('The trip can only start once you are en route to the patient.');
    await this.prisma.emergencyRequest.update({ where: { id }, data: { status: 'on_trip' } });
    await this.notifier.tripStarted(r);
    void this.live.request(id);
    return { data: await this.emergencies.present(id, { providerId: provider.id }) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const r = await this.assigned(provider, id);
    if (r.status !== 'on_trip') throw new ConflictException('Only a trip in progress can be completed.');

    const earned = await this.payments.afterCommission(num(r.agreedPrice));
    await this.prisma.$transaction([
      this.prisma.emergencyRequest.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } }),
      this.prisma.provider.update({ where: { id: provider.id }, data: { completedJobs: { increment: 1 }, earnings: { increment: earned } } }),
    ]);
    await this.notifier.tripCompleted({ ...r, provider }, earned);
    void this.live.request(id);
    return { data: await this.emergencies.present(id, { providerId: provider.id }) };
  }

  private async assigned(provider: Provider, id: number) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r || r.providerId !== provider.id) throw new NotFoundException('Not found.');
    return r;
  }
}
