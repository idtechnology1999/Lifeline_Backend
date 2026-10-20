import { Controller, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { pageParams, paginate } from '../common/http.js';
import { presentProduct, productInclude } from '../common/presenters.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Products from approved, active suppliers that can actually be ordered. */
export const buyable: Prisma.ProductWhereInput = {
  available: true,
  stock: { gt: 0 },
  supplier: { verification: 'approved', user: { accountStatus: 'active' } },
};

/** Public: patients browse as guests and log in to buy. */
@Controller()
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Get('products')
  async products(@Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 30, 100);
    const where: Prisma.ProductWhereInput = {
      ...buyable,
      ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
      ...(query.category && { category: query.category }),
      ...(query.supplierId && { supplierId: Number(query.supplierId) || -1 }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: productInclude, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(rows.map(presentProduct), total, page, perPage);
  }

  @Get('products/:id')
  async product(@Param('id', ParseIntPipe) id: number) {
    const p = await this.prisma.product.findFirst({ where: { id, ...buyable }, include: productInclude });
    if (!p) throw new NotFoundException('Not found.');
    return { data: presentProduct(p) };
  }

  @Get('pricing')
  async pricing() {
    const s = await this.settings.platform();
    return { baseRates: s.baseRates, perKmRate: s.perKmRate, deliveryBaseFee: s.deliveryBaseFee, plans: s.plans };
  }
}
