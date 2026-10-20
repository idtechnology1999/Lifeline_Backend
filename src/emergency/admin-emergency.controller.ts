import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { Auth } from '../auth/guards.js';
import { EmergencyService } from './emergency.service.js';
import { fieldError, pageParams, paginate } from '../common/http.js';
import { presentRequest, requestInclude } from '../common/presenters.js';

class AssignDto {
  @Type(() => Number) @IsInt() providerId: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(240) etaMinutes?: number;
}

@Controller('admin/emergency-requests')
@Auth('admin')
export class AdminEmergencyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emergencies: EmergencyService,
  ) {}

  @Get()
  async index(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const where = {
      ...(query.status && { status: { in: query.status.split(',') } }),
      ...(query.severity && { severity: query.severity }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.emergencyRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.emergencyRequest.count({ where }),
    ]);
    return paginate(rows.map((r) => presentRequest(r)), total, page, perPage);
  }

  /** Dispatch control: hand a request straight to an ambulance at the estimated price. */
  @Post(':id/assign')
  @HttpCode(200)
  async assign(@Param('id', ParseIntPipe) id: number, @Body() dto: AssignDto) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Not found.');
    const provider = await this.prisma.provider.findUnique({ where: { id: dto.providerId }, include: { user: true } });
    if (!provider) fieldError('providerId', 'The selected provider id is invalid.');
    if (provider.type !== 'ambulance' || provider.verification !== 'approved' || provider.user.accountStatus === 'suspended') {
      fieldError('providerId', 'Pick an approved, active ambulance provider.');
    }
    const offer = await this.prisma.emergencyRequestOffer.upsert({
      where: { emergencyRequestId_providerId: { emergencyRequestId: id, providerId: provider.id } },
      create: { emergencyRequestId: id, providerId: provider.id, amount: r.estimatedPrice, etaMinutes: dto.etaMinutes ?? 10, lastBy: 'provider', status: 'open' },
      update: { amount: r.estimatedPrice, etaMinutes: dto.etaMinutes ?? 10, lastBy: 'provider', status: 'open' },
    });
    await this.emergencies.acceptOffer(id, offer.id);
    return { data: await this.emergencies.present(id) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id', ParseIntPipe) id: number) {
    const r = await this.prisma.emergencyRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Not found.');
    if (['completed', 'cancelled'].includes(r.status)) throw new ConflictException('This request is already closed.');
    await this.emergencies.cancel(id, true);
    return { data: await this.emergencies.present(id) };
  }
}
