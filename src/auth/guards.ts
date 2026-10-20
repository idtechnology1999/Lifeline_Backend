import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokensService } from './tokens.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export type AuthUser = Prisma.UserGetPayload<{ include: { provider: true } }>;
export type Role = 'requester' | 'provider' | 'admin';
export type ProviderType = 'ambulance' | 'supplier' | 'dispatcher';

export interface AuthedRequest extends Request {
  user: AuthUser;
  tokenId: number;
}

/** Requires a valid bearer token. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokensService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const token = bearer ? await this.tokens.resolve(bearer) : null;
    if (!token) throw new UnauthorizedException('Unauthenticated.');
    req.user = token.user;
    req.tokenId = token.id;
    return true;
  }
}

const ROLES = 'roles';
const PROVIDER_TYPE = 'providerType';

/** Allows only these roles, and blocks suspended accounts. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles) return true;
    const { user } = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!roles.includes(user.role as Role)) throw new ForbiddenException('This account cannot access this resource.');
    if (user.accountStatus === 'suspended') {
      throw new ForbiddenException('This account has been suspended. Contact Lifeline support.');
    }
    return true;
  }
}

/** Requires an approved provider profile (optionally of one type). */
@Injectable()
export class ApprovedProviderGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const type = this.reflector.getAllAndOverride<ProviderType | null | undefined>(PROVIDER_TYPE, [ctx.getHandler(), ctx.getClass()]);
    if (type === undefined) return true;
    const { user } = ctx.switchToHttp().getRequest<AuthedRequest>();
    const provider = user.provider;
    if (!provider) throw new ForbiddenException('Complete provider registration first.');
    if (type && provider.type !== type) throw new ForbiddenException(`Only ${type} providers can access this resource.`);
    if (provider.verification !== 'approved') throw new ForbiddenException('Your provider account is still awaiting verification.');
    return true;
  }
}

/** Signed in with one of these roles. */
export const Auth = (...roles: Role[]) =>
  applyDecorators(SetMetadata(ROLES, roles.length ? roles : undefined), UseGuards(AuthGuard, RolesGuard, ApprovedProviderGuard));

/** An approved provider (of `type`, or any type when null). Use after @Auth('provider'). */
export const ApprovedProvider = (type: ProviderType | null = null) => SetMetadata(PROVIDER_TYPE, type);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

/** The signed-in user's provider profile (guaranteed by the provider guards). */
export const CurrentProvider = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user.provider;
});
