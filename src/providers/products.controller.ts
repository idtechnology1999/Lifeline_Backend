import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { FilesService, fileIdFromUrl, type UploadedFile } from '../files/files.service.js';
import { ApprovedProvider, Auth, CurrentProvider, type AuthedRequest } from '../auth/guards.js';
import { fieldError, pageParams, paginate } from '../common/http.js';
import { presentProduct, productInclude } from '../common/presenters.js';
import type { Prisma } from '../generated/prisma/client.js';

const MAX_IMAGES = 6;
type Provider = Prisma.ProviderGetPayload<object>;

class ProductDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) usageNotes?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) stock?: number;
  @IsOptional() @IsDateString() expiresAt?: string | null;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsBoolean() requiresPrescription?: boolean;
  @IsOptional() @IsString() @MaxLength(16) emoji?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_IMAGES) @IsString({ each: true }) @MaxLength(500, { each: true }) imageUris?: string[];
}

const FIELDS = ['name', 'category', 'description', 'usageNotes', 'price', 'stock', 'available', 'requiresPrescription', 'emoji'] as const;

function toColumns(dto: ProductDto, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const key of FIELDS) if (key in body) data[key] = dto[key] ?? null;
  if ('expiresAt' in body) data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt.slice(0, 10)) : null;
  return data;
}

/** A pharmacy's own inventory. */
@Controller('provider/products')
@Auth('provider')
@ApprovedProvider('supplier')
export class SupplierProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  private async own(provider: Provider, id: number) {
    const p = await this.prisma.product.findUnique({ where: { id }, include: { images: true } });
    if (!p || p.supplierId !== provider.id) throw new NotFoundException('Not found.');
    return p;
  }

  private async present(id: number) {
    return presentProduct(await this.prisma.product.findUniqueOrThrow({ where: { id }, include: productInclude }));
  }

  @Get()
  async index(@CurrentProvider() provider: Provider, @Query() query: Record<string, string>) {
    const { page, perPage, skip, take } = pageParams(query, 50, 200);
    const where: Prisma.ProductWhereInput = {
      supplierId: provider.id,
      ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
      ...(['1', 'true'].includes(query.lowStock) && { stock: { lt: 10 } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: productInclude, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(rows.map(presentProduct), total, page, perPage);
  }

  @Post()
  @HttpCode(201)
  async store(@CurrentProvider() provider: Provider, @Body() dto: ProductDto, @Req() req: AuthedRequest) {
    for (const [key, label] of [['name', 'name'], ['category', 'category'], ['price', 'price'], ['stock', 'stock']] as const) {
      if (dto[key] === undefined || dto[key] === null) fieldError(key, `The ${label} field is required.`);
    }
    const product = await this.prisma.product.create({
      data: { ...(toColumns(dto, req.body) as Prisma.ProductUncheckedCreateInput), supplierId: provider.id },
    });
    if (dto.imageUris) await this.syncImages(product.id, [], dto.imageUris);
    return { data: await this.present(product.id) };
  }

  @Get(':id')
  async show(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    await this.own(provider, id);
    return { data: await this.present(id) };
  }

  @Put(':id')
  replace(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number, @Body() dto: ProductDto, @Req() req: AuthedRequest) {
    return this.update(provider, id, dto, req);
  }

  @Patch(':id')
  async update(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number, @Body() dto: ProductDto, @Req() req: AuthedRequest) {
    const product = await this.own(provider, id);
    await this.prisma.product.update({ where: { id }, data: toColumns(dto, req.body) });
    if (dto.imageUris) await this.syncImages(id, product.images, dto.imageUris);
    return { data: await this.present(id) };
  }

  @Delete(':id')
  async destroy(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number) {
    const product = await this.own(provider, id);
    await this.prisma.product.delete({ where: { id } });
    for (const image of product.images) await this.files.remove(image.fileId);
    return { message: 'Product deleted.' };
  }

  /** Add a photo to a product (multipart `image`). */
  @Post(':id/images')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('image'))
  async uploadImage(@CurrentProvider() provider: Provider, @Param('id', ParseIntPipe) id: number, @UploadedFileParam() image?: UploadedFile) {
    const product = await this.own(provider, id);
    if (product.images.length >= MAX_IMAGES) throw new UnprocessableEntityException(`A product can have up to ${MAX_IMAGES} photos.`);
    const stored = await this.files.store(image, 'product_image', provider.userId, 'image');
    await this.prisma.productImage.create({ data: { productId: id, fileId: stored.id, position: product.images.length } });
    return { data: await this.present(id) };
  }

  /**
   * `imageUris` lists the photos to keep, in order. Photos are uploaded
   * through POST :id/images; links we did not issue are ignored.
   */
  private async syncImages(productId: number, current: { id: number; fileId: string }[], uris: string[]) {
    const keep = uris.map(fileIdFromUrl).filter((id): id is string => !!id && current.some((c) => c.fileId === id));
    for (const image of current) {
      if (!keep.includes(image.fileId)) await this.files.remove(image.fileId);
    }
    for (const [position, fileId] of keep.entries()) {
      await this.prisma.productImage.updateMany({ where: { productId, fileId }, data: { position } });
    }
  }
}
