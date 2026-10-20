import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  private readonly logger = new Logger('OTP');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalise Nigerian numbers so "0803 123 4567", "+234-803-123-4567",
   * "+234 0803..." and "2348031234567" all become "+2348031234567".
   */
  static normalizePhone(phone: string): string {
    let digits = phone.replace(/\D+/g, '');
    if (digits.startsWith('2340') && digits.length === 14) digits = '234' + digits.slice(4);
    if (digits.startsWith('234')) return '+' + digits;
    if (digits.startsWith('0') && digits.length === 11) return '+234' + digits.slice(1);
    return '+' + digits;
  }

  /** Create a fresh code (invalidating older ones) and deliver it. Returns the plain code. */
  async send(phone: string, purpose: string): Promise<string> {
    await this.prisma.otpCode.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } });
    const code = String(randomInt(100000, 1000000));
    await this.prisma.otpCode.create({
      data: {
        phone,
        purpose,
        codeHash: await bcrypt.hash(code, 8),
        expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000),
      },
    });
    this.deliver(phone, `Your Lifeline code is ${code}. It expires in ${TTL_MINUTES} minutes.`);
    return code;
  }

  async verify(phone: string, purpose: string, code: string): Promise<boolean> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { id: 'desc' },
    });
    if (!otp || otp.attempts >= MAX_ATTEMPTS) return false;
    if (!(await bcrypt.compare(code, otp.codeHash))) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      return false;
    }
    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    return true;
  }

  /** TODO: send through an SMS gateway (e.g. Termii). Until then it's only logged. */
  private deliver(phone: string, message: string) {
    this.logger.log(`to ${phone}: ${message}`);
  }
}
