import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { NotifierService } from '../notifications/notifier.service.js';
import { LiveService } from '../realtime/live.service.js';
import { Auth, CurrentUser, type AuthUser } from '../auth/guards.js';
import { ACTIVE_STATUSES, AMBULANCE_TYPES, EmergencyService, OPEN_STATUSES, SEVERITIES } from './emergency.service.js';
import { pageParams, paginate } from '../common/http.js';
import { presentRequest, requestInclude } from '../common/presenters.js';
import { num } from '../common/money.js';

class CreateRequestDto {
  @IsIn(SEVERITIES) severity: string;
  @IsIn(AMBULANCE_TYPES) ambulanceType: 'bls' | 'als' | 'erv';
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(120, { each: true }) symptoms: string[];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsString() @MaxLength(255) pickup: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) pickupLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) pickupLng?: number;
  @IsString() @MaxLength(255) destination: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) destinationLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) destinationLng?: number;
}

class AmountDto {
  @Type(() => Number) @IsNumber() @Min(500) amount: number;
}

class PayDto {
  @IsIn(['card', 'transfer', 'wallet']) method: string;
}

@Controller('emergency-requests')
@Auth('requester')
export class RequesterEmergencyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly payments: PaymentService,
    private readonly notifier: NotifierService,
    private readonly live: LiveService,
    private readonly emergencies: EmergencyService,
  ) {}

  private async own(user: AuthUser, id: number) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r || r.requesterId !== user.id) throw new NotFoundException('Not found.');
    return r;
  }

  @Get()
  async index(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 20, 100);
    const where = { requesterId: user.id, ...(query.status && { status: query.status }) };
    const [rows, total] = await Promise.all([
      this.prisma.emergencyRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.emergencyRequest.count({ where }),
    ]);
    return paginate(rows.map((r) => presentRequest(r)), total, page, perPage);
  }

  @Post()
  @HttpCode(201)
  async store(@CurrentUser() user: AuthUser, @Body() dto: CreateRequestDto) {
    await this.settings.abortIfMaintenance();
    const active = await this.prisma.emergencyRequest.count({ where: { requesterId: user.id, status: { in: ACTIVE_STATUSES } } });
    if (active) throw new ConflictException('You already have an active ambulance request.');

    const { baseRates } = await this.settings.platform();
    const r = await this.prisma.emergencyRequest.create({
      data: {
        requesterId: user.id,
        severity: dto.severity,
        ambulanceType: dto.ambulanceType,
        symptoms: dto.symptoms,
        notes: dto.notes ?? null,
        pickup: dto.pickup,
        pickupLat: dto.pickupLat ?? null,
        pickupLng: dto.pickupLng ?? null,
        destination: dto.destination,
        destinationLat: dto.destinationLat ?? null,
        destinationLng: dto.destinationLng ?? null,
        estimatedPrice: baseRates[dto.ambulanceType],
      },
      include: requestInclude,
    });
    await this.notifier.newEmergency(r);
    void this.live.request(r.id);
    return { data: presentRequest(r) };
  }

  @Get(':id')
  async show(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.own(user, id);
    return { data: await this.emergencies.present(id, 'open') };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const r = await this.own(user, id);
    if (['on_trip', 'completed', 'cancelled'].includes(r.status)) throw new ConflictException('This request can no longer be cancelled.');
    await this.emergencies.cancel(id, false);
    return { data: await this.emergencies.present(id) };
  }

  /** Patient answers a provider's offer with their own price. */
  @Post(':id/offers/:offerId/counter')
  @HttpCode(200)
  async counter(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('offerId', ParseIntPipe) offerId: number,
    @Body() dto: AmountDto,
  ) {
    const r = await this.own(user, id);
    const offer = await this.prisma.emergencyRequestOffer.findUnique({ where: { id: offerId }, include: { provider: true } });
    if (!offer || offer.emergencyRequestId !== id) throw new NotFoundException('Not found.');
    if (!OPEN_STATUSES.includes(r.status) || offer.status !== 'open') throw new ConflictException('This offer is no longer open.');

    await this.prisma.emergencyRequestOffer.update({ where: { id: offerId }, data: { amount: dto.amount, lastBy: 'requester' } });
    await this.notifier.counterReceived(r, offer.provider, dto.amount);
    void this.live.request(id);
    return { data: await this.emergencies.present(id, 'open') };
  }

  @Post(':id/offers/:offerId/accept')
  @HttpCode(200)
  async accept(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('offerId', ParseIntPipe) offerId: number) {
    await this.own(user, id);
    const offer = await this.prisma.emergencyRequestOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.emergencyRequestId !== id) throw new NotFoundException('Not found.');
    if (offer.lastBy !== 'provider') throw new ConflictException('Wait for the provider to answer your counter-offer.');
    await this.emergencies.acceptOffer(id, offerId);
    return { data: await this.emergencies.present(id) };
  }

  @Post(':id/pay')
  @HttpCode(200)
  async pay(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PayDto) {
    const r = await this.own(user, id);
    if (!r.agreedPrice || r.status === 'cancelled') throw new ConflictException('Agree a price with a provider before paying.');
    if (r.paidAt) throw new ConflictException('This request has already been paid for.');

    const amount = num(r.agreedPrice);
    const provider = r.providerId ? await this.prisma.provider.findUnique({ where: { id: r.providerId } }) : null;
    await this.prisma.$transaction(async (tx) => {
      await this.payments.charge({
        payerId: user.id,
        kind: 'ambulance',
        amount,
        commission: await this.payments.commissionOn(amount),
        method: dto.method,
        payeeProviderId: r.providerId,
        payeeName: provider?.businessName,
        payable: { type: 'emergency_request', id },
        tx,
      });
      await tx.emergencyRequest.update({ where: { id }, data: { paidAt: new Date() } });
    });
    void this.live.request(id);
    return { data: await this.emergencies.present(id) };
  }
}
