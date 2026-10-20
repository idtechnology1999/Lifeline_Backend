import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, UnprocessableEntityException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { MAX_FUND, MIN_FUND, WalletService } from '../payments/wallet.service.js';
import { Auth, CurrentUser, type AuthUser } from '../auth/guards.js';
import { presentUser } from '../common/presenters.js';
import { iso, num } from '../common/money.js';

const MAX_ITEMS = 10;

class FundDto {
  @Type(() => Number) @IsNumber() @Min(MIN_FUND) @Max(MAX_FUND) amount: number;
  @IsIn(['card', 'transfer']) method: string;
}

class SubscribeDto {
  @IsIn(['basic', 'family', 'annual']) plan: 'basic' | 'family' | 'annual';
  @IsIn(['card', 'transfer', 'wallet']) method: string;
}

class ContactDto {
  @IsString() @MaxLength(120) name: string;
  @IsString() @MaxLength(60) relation: string;
  @IsString() @MinLength(7) @MaxLength(20) phone: string;
}

class AddressDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string | null;
  @IsString() @MaxLength(255) address: string;
}

/** A patient's wallet, subscription, emergency contacts and saved addresses. */
@Controller()
@Auth('requester')
export class RequesterController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly payments: PaymentService,
    private readonly wallet: WalletService,
  ) {}

  // ---------- Wallet ----------

  @Get('wallet')
  async showWallet(@CurrentUser() user: AuthUser) {
    const [fresh, entries] = await Promise.all([
      // Read from the database: refunds may have changed it since the request began
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      this.prisma.walletEntry.findMany({ where: { userId: user.id }, orderBy: { id: 'desc' }, take: 50 }),
    ]);
    return {
      data: {
        balance: num(fresh.walletBalance),
        entries: entries.map((e) => ({
          id: String(e.id),
          type: e.type,
          amount: num(e.amount),
          balanceAfter: num(e.balanceAfter),
          description: e.description,
          method: e.method,
          reference: e.reference,
          createdAt: iso(e.createdAt),
        })),
      },
    };
  }

  @Post('wallet/fund')
  @HttpCode(200)
  async fund(@CurrentUser() user: AuthUser, @Body() dto: FundDto) {
    await this.wallet.fund(user.id, dto.amount, dto.method);
    return this.showWallet(user);
  }

  // ---------- Subscription ----------

  @Post('subscription')
  @HttpCode(200)
  async subscribe(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    if (user.plan === dto.plan) throw new ConflictException('You are already on this plan.');
    const price = (await this.settings.platform()).plans[dto.plan];
    await this.prisma.$transaction(async (tx) => {
      // Subscriptions go entirely to Lifeline, so commission is the whole amount
      await this.payments.charge({ payerId: user.id, kind: 'subscription', amount: price, commission: price, method: dto.method, tx });
      await tx.user.update({ where: { id: user.id }, data: { plan: dto.plan } });
    });
    return { data: presentUser(await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } })) };
  }

  @Delete('subscription')
  async unsubscribe(@CurrentUser() user: AuthUser) {
    return { data: presentUser(await this.prisma.user.update({ where: { id: user.id }, data: { plan: 'none' } })) };
  }

  // ---------- Emergency contacts ----------

  @Get('me/contacts')
  async contacts(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.emergencyContact.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    return { data: rows.map(contact) };
  }

  @Post('me/contacts')
  @HttpCode(201)
  async addContact(@CurrentUser() user: AuthUser, @Body() dto: ContactDto) {
    ensureRoom(await this.prisma.emergencyContact.count({ where: { userId: user.id } }));
    const c = await this.prisma.emergencyContact.create({ data: { userId: user.id, name: dto.name, relation: dto.relation, phone: dto.phone } });
    return { data: contact(c) };
  }

  @Delete('me/contacts/:id')
  async deleteContact(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const { count } = await this.prisma.emergencyContact.deleteMany({ where: { id, userId: user.id } });
    if (!count) throw new NotFoundException('Not found.');
    return { message: 'Contact removed.' };
  }

  // ---------- Saved addresses ----------

  @Get('me/addresses')
  async addresses(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.savedAddress.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    return { data: rows.map(address) };
  }

  @Post('me/addresses')
  @HttpCode(201)
  async addAddress(@CurrentUser() user: AuthUser, @Body() dto: AddressDto) {
    ensureRoom(await this.prisma.savedAddress.count({ where: { userId: user.id } }));
    const a = await this.prisma.savedAddress.create({ data: { userId: user.id, label: dto.label ?? null, address: dto.address } });
    return { data: address(a) };
  }

  @Delete('me/addresses/:id')
  async deleteAddress(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const { count } = await this.prisma.savedAddress.deleteMany({ where: { id, userId: user.id } });
    if (!count) throw new NotFoundException('Not found.');
    return { message: 'Address removed.' };
  }
}

function ensureRoom(count: number) {
  if (count >= MAX_ITEMS) throw new UnprocessableEntityException(`You can save up to ${MAX_ITEMS}. Remove one first.`);
}

const contact = (c: { id: number; name: string; relation: string; phone: string }) => ({
  id: String(c.id),
  name: c.name,
  relation: c.relation,
  phone: c.phone,
});

const address = (a: { id: number; label: string | null; address: string }) => ({ id: String(a.id), label: a.label, address: a.address });
