import { Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Auth, CurrentUser, type AuthUser } from '../auth/guards.js';
import { iso } from '../common/money.js';

/** The signed-in user's in-app notification inbox (patients and providers). */
@Controller('notifications')
@Auth()
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  private unread(userId: number) {
    return this.prisma.appNotification.count({ where: { userId, readAt: null } });
  }

  @Get()
  async index(@CurrentUser() user: AuthUser) {
    const items = await this.prisma.appNotification.findMany({ where: { userId: user.id }, orderBy: { id: 'desc' }, take: 50 });
    return {
      data: items.map((n) => ({
        id: String(n.id),
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data ?? {},
        read: n.readAt !== null,
        createdAt: iso(n.createdAt),
      })),
      unreadCount: await this.unread(user.id),
    };
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser) {
    return { unreadCount: await this.unread(user.id) };
  }

  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: AuthUser) {
    await this.prisma.appNotification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { unreadCount: 0 };
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const n = await this.prisma.appNotification.findUnique({ where: { id } });
    if (!n || n.userId !== user.id) throw new NotFoundException('Not found.');
    if (!n.readAt) await this.prisma.appNotification.update({ where: { id }, data: { readAt: new Date() } });
    return { unreadCount: await this.unread(user.id) };
  }
}
