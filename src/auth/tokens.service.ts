import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Opaque bearer tokens in the form "<id>|<secret>". Only a hash of the
 * secret is stored, so a database leak doesn't leak working tokens.
 */
@Injectable()
export class TokensService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: number, name: string): Promise<string> {
    const secret = randomBytes(30).toString('base64url');
    const row = await this.prisma.accessToken.create({ data: { userId, name, tokenHash: sha256(secret) } });
    return `${row.id}|${secret}`;
  }

  /** Returns the token row (with its user) or null. */
  async resolve(bearer: string) {
    const [idPart, secret] = bearer.split('|');
    const id = Number(idPart);
    if (!id || !secret) return null;
    const row = await this.prisma.accessToken.findUnique({ where: { id }, include: { user: { include: { provider: true } } } });
    if (!row || row.tokenHash !== sha256(secret)) return null;
    // Cheap "last used" stamp, at most once a minute
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
      this.prisma.accessToken.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    }
    return row;
  }

  async revoke(tokenId: number) {
    await this.prisma.accessToken.deleteMany({ where: { id: tokenId } });
  }

  async revokeAll(userId: number) {
    await this.prisma.accessToken.deleteMany({ where: { userId } });
  }
}
