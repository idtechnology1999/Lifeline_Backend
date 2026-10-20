import { Body, Controller, ForbiddenException, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { OtpService } from './otp.service.js';
import { TokensService } from './tokens.service.js';
import { Auth, CurrentUser, type AuthUser, type AuthedRequest } from './guards.js';
import { fieldError } from '../common/http.js';
import { presentUser } from '../common/presenters.js';

class SendOtpDto {
  @IsString() @MinLength(7) @MaxLength(20) phone: string;
  @IsIn(['login', 'signup']) purpose: 'login' | 'signup';
}

class VerifyOtpDto {
  @IsString() @MaxLength(20) phone: string;
  @Matches(/^\d{6}$/, { message: 'The code must be 6 digits.' }) code: string;
  @IsIn(['login', 'signup']) purpose: 'login' | 'signup';
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(190) email?: string;
  @IsOptional() @IsIn(['requester', 'provider']) role?: 'requester' | 'provider';
  @IsOptional() @IsString() @MaxLength(80) city?: string;
}

class UpdateMeDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(190) email?: string | null;
  @IsOptional() @IsString() @MaxLength(80) city?: string | null;
}

class AdminLoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}

class DeviceDto {
  @IsString() @Length(10, 4096) token: string;
  @IsIn(['android', 'ios', 'web']) platform: string;
}

const ip = (req: Request) => req.ip ?? 'unknown';

@Controller()
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokensService,
    private readonly redis: RedisService,
  ) {}

  /** Login endpoints: stop OTP spam and password guessing. */
  private async throttle(req: Request, key: string) {
    await this.redis.hit(`otp:${ip(req)}|${key}`, 5, 60);
    await this.redis.hit(`otp:${ip(req)}`, 20, 60);
  }

  @Post('auth/otp/send')
  @HttpCode(200)
  async sendOtp(@Body() dto: SendOtpDto, @Req() req: Request) {
    await this.throttle(req, dto.phone);
    const phone = OtpService.normalizePhone(dto.phone);
    const user = await this.prisma.user.findUnique({ where: { phone } });

    if (dto.purpose === 'login' && (!user || user.role === 'admin')) {
      fieldError('phone', 'No Lifeline account uses this number. Sign up instead.');
    }
    if (dto.purpose === 'signup' && user) {
      fieldError('phone', 'This number already has an account. Log in instead.');
    }

    const code = await this.otp.send(phone, dto.purpose);
    return {
      message: 'Verification code sent.',
      phone,
      expiresIn: 600,
      // Lets you test without an SMS gateway; never sent in production
      ...(process.env.APP_DEBUG === 'true' && { debugCode: code }),
    };
  }

  @Post('auth/otp/verify')
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.throttle(req, dto.phone);
    if (dto.purpose === 'signup' && !dto.name) fieldError('name', 'The name field is required when purpose is signup.');
    if (dto.email && (await this.prisma.user.findUnique({ where: { email: dto.email } }))) {
      fieldError('email', 'The email has already been taken.');
    }

    const phone = OtpService.normalizePhone(dto.phone);
    if (!(await this.otp.verify(phone, dto.purpose, dto.code))) fieldError('code', 'That code is wrong or has expired.');

    const user =
      dto.purpose === 'signup'
        ? ((await this.prisma.user.findUnique({ where: { phone }, include: { provider: true } })) ??
          (await this.prisma.user.create({
            data: {
              phone,
              name: dto.name!,
              email: dto.email ?? null,
              city: dto.city ?? null,
              role: dto.role ?? 'requester',
              phoneVerifiedAt: new Date(),
            },
            include: { provider: true },
          })))
        : await this.prisma.user.findUnique({ where: { phone }, include: { provider: true } });

    if (!user) fieldError('phone', 'No Lifeline account uses this number. Sign up instead.');
    if (user.accountStatus === 'suspended') throw new ForbiddenException('This account has been suspended. Contact Lifeline support.');

    const token = await this.tokens.issue(user.id, 'mobile');
    res.status(dto.purpose === 'signup' ? 201 : 200);
    return { token, user: presentUser(user) };
  }

  @Post('admin/auth/login')
  @HttpCode(200)
  async adminLogin(@Body() dto: AdminLoginDto, @Req() req: Request) {
    await this.throttle(req, dto.email);
    const user = await this.prisma.user.findFirst({ where: { email: dto.email, role: 'admin' } });
    if (!user?.passwordHash || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      fieldError('email', 'These credentials do not match an admin account.');
    }
    if (user.accountStatus === 'suspended') throw new ForbiddenException('This admin account has been suspended.');
    return { token: await this.tokens.issue(user.id, 'admin'), user: presentUser(user) };
  }

  @Get('me')
  @Auth()
  me(@CurrentUser() user: AuthUser) {
    return { data: presentUser(user) };
  }

  @Patch('me')
  @Auth()
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    if (dto.email) {
      const taken = await this.prisma.user.findFirst({ where: { email: dto.email, NOT: { id: user.id } } });
      if (taken) fieldError('email', 'The email has already been taken.');
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.email !== undefined && { email: dto.email || null }),
        ...(dto.city !== undefined && { city: dto.city || null }),
      },
      include: { provider: true },
    });
    return { data: presentUser(updated) };
  }

  @Post('auth/logout')
  @HttpCode(200)
  @Auth()
  async logout(@Req() req: AuthedRequest) {
    await this.tokens.revoke(req.tokenId);
    return { message: 'Logged out.' };
  }

  /** Register this phone for push notifications (FCM token). */
  @Post('devices')
  @HttpCode(200)
  @Auth()
  async registerDevice(@CurrentUser() user: AuthUser, @Body() dto: DeviceDto) {
    await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: { token: dto.token, platform: dto.platform, userId: user.id },
      update: { userId: user.id, platform: dto.platform },
    });
    return { message: 'Device registered.' };
  }
}
