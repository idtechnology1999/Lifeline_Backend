import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { RedisService } from '../redis/redis.service.js';
import { LiveService } from '../realtime/live.service.js';
import { FilesService, fileUrl, type UploadedFile } from '../files/files.service.js';
import { ApprovedProvider, Auth, CurrentUser, type AuthUser, type AuthedRequest } from '../auth/guards.js';
import { fieldError } from '../common/http.js';
import { location, presentProvider, providerInclude } from '../common/presenters.js';
import type { Prisma } from '../generated/prisma/client.js';

const TYPES = ['ambulance', 'supplier', 'dispatcher'];
const DOCUMENT_KINDS = ['id', 'license', 'registration', 'insurance', 'photo', 'other'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class VehicleDto {
  @IsOptional() @IsString() @MaxLength(40) kind?: string | null;
  @IsOptional() @IsString() @MaxLength(20) plate?: string | null;
}

class HoursDto {
  @IsOptional() @Matches(HHMM, { message: 'The time must be in HH:MM format.' }) start?: string | null;
  @IsOptional() @Matches(HHMM, { message: 'The time must be in HH:MM format.' }) end?: string | null;
}

class ProfileDto {
  @IsOptional() @IsIn(TYPES) type?: string;
  @IsOptional() @IsString() @MaxLength(150) businessName?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(190) email?: string | null;
  @IsOptional() @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @IsString() @MaxLength(255) address?: string | null;
  @IsOptional() @ValidateNested() @Type(() => VehicleDto) vehicle?: VehicleDto | null;
  @IsOptional() @IsIn(['24/7', 'scheduled']) availability?: string;
  @IsOptional() @ValidateNested() @Type(() => HoursDto) hours?: HoursDto | null;
  @IsOptional() @IsObject() details?: Record<string, unknown> | null;
}

class OnlineDto {
  @IsBoolean() online: boolean;
}

class LocationDto {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng: number;
}

class DocumentDto {
  @IsString() @MaxLength(120) name: string;
  @IsIn(DOCUMENT_KINDS) kind: string;
}

/** Map the camelCase request body onto columns (only the keys that were sent). */
function toColumns(dto: ProfileDto, body: Record<string, unknown>) {
  const data: Prisma.ProviderUncheckedUpdateInput = {};
  for (const key of ['type', 'businessName', 'contactName', 'phone', 'email', 'city', 'address', 'availability'] as const) {
    if (key in body) (data as Record<string, unknown>)[key] = dto[key] ?? null;
  }
  if ('details' in body) data.details = (dto.details ?? undefined) as Prisma.InputJsonValue | undefined;
  if ('vehicle' in body) {
    data.vehicleKind = dto.vehicle?.kind ?? null;
    data.vehiclePlate = dto.vehicle?.plate ?? null;
  }
  if ('hours' in body) {
    data.hoursStart = dto.hours?.start ?? null;
    data.hoursEnd = dto.hours?.end ?? null;
  }
  return data;
}

/** The provider registration wizard and profile, shared by all three provider types. */
@Controller('provider')
@Auth('provider')
export class ProviderProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly redis: RedisService,
    private readonly live: LiveService,
    private readonly files: FilesService,
  ) {}

  private provider(user: AuthUser) {
    if (!user.provider) throw new NotFoundException('Complete provider registration first.');
    return user.provider;
  }

  private async present(id: number) {
    return presentProvider(await this.prisma.provider.findUniqueOrThrow({ where: { id }, include: providerInclude }));
  }

  @Get()
  async show(@CurrentUser() user: AuthUser) {
    return { data: user.provider ? await this.present(user.provider.id) : null };
  }

  /** Final "Submit For Verification" of the wizard. */
  @Post()
  @HttpCode(201)
  async store(@CurrentUser() user: AuthUser, @Body() dto: ProfileDto, @Req() req: AuthedRequest) {
    if (user.provider) throw new ConflictException('You have already registered as a provider. Update your profile instead.');
    if (!dto.type) fieldError('type', 'The type field is required.');
    if (!dto.businessName) fieldError('businessName', 'The business name field is required.');
    if (!dto.contactName) fieldError('contactName', 'The contact name field is required.');
    if (dto.availability === 'scheduled' && !dto.hours) fieldError('hours', 'The hours field is required when availability is scheduled.');

    const { autoApproveProviders } = await this.settings.platform();
    const provider = await this.prisma.provider.create({
      data: {
        ...(toColumns(dto, req.body) as Prisma.ProviderUncheckedCreateInput),
        userId: user.id,
        type: dto.type,
        businessName: dto.businessName,
        contactName: dto.contactName,
        phone: dto.phone ?? user.phone ?? '',
        email: dto.email ?? user.email,
        verification: autoApproveProviders ? 'approved' : 'pending',
        submittedAt: new Date(),
      },
    });
    return { data: await this.present(provider.id) };
  }

  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() dto: ProfileDto, @Req() req: AuthedRequest) {
    const provider = this.provider(user);
    if ('type' in req.body) fieldError('type', 'The type field is prohibited.');
    if (dto.availability === 'scheduled' && !('hours' in req.body) && !provider.hoursStart) {
      fieldError('hours', 'The hours field is required when availability is scheduled.');
    }

    const data = toColumns(dto, req.body);
    // Editing a rejected application sends it back for review
    if (provider.verification === 'rejected') {
      Object.assign(data, { verification: 'pending', rejectionReason: null, submittedAt: new Date() });
    }
    await this.prisma.provider.update({ where: { id: provider.id }, data });
    return { data: await this.present(provider.id) };
  }

  @Patch('status')
  @ApprovedProvider()
  async setOnline(@CurrentUser() user: AuthUser, @Body() dto: OnlineDto) {
    const provider = this.provider(user);
    if (dto.online && provider.verification !== 'approved') throw new ForbiddenException('You can go online once your account is verified.');
    const updated = await this.prisma.provider.update({ where: { id: provider.id }, data: { online: dto.online }, include: { user: true } });
    return { data: presentProvider(updated) };
  }

  /** The provider app reports its GPS position while online or on a job. */
  @Post('location')
  @HttpCode(200)
  async updateLocation(@CurrentUser() user: AuthUser, @Body() dto: LocationDto) {
    const provider = this.provider(user);
    await this.redis.hit(`location:${user.id}`, 120, 60);
    // A database trigger keeps the PostGIS `location` point in step
    await this.prisma.provider.update({
      where: { id: provider.id },
      data: { latitude: dto.lat, longitude: dto.lng, locationUpdatedAt: new Date() },
    });
    void this.live.providerMoved(provider.id, dto.lat, dto.lng);
    return { data: location({ latitude: dto.lat, longitude: dto.lng, locationUpdatedAt: new Date() }) };
  }

  @Post('documents')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(@CurrentUser() user: AuthUser, @Body() dto: DocumentDto, @UploadedFileParam() file?: UploadedFile) {
    const provider = this.provider(user);
    const stored = await this.files.store(file, 'document', user.id);
    const doc = await this.prisma.providerDocument.create({
      data: { providerId: provider.id, fileId: stored.id, name: dto.name, kind: dto.kind },
    });
    return { data: { id: String(doc.id), name: doc.name, kind: doc.kind, url: fileUrl(stored) } };
  }

  @Delete('documents/:id')
  async deleteDocument(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const provider = this.provider(user);
    const doc = await this.prisma.providerDocument.findUnique({ where: { id } });
    if (!doc || doc.providerId !== provider.id) throw new NotFoundException('Not found.');
    // Deleting the stored file cascades to the document row
    await this.files.remove(doc.fileId);
    return { message: 'Document removed.' };
  }
}
