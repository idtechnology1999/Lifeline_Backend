import { Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { fieldError } from '../common/http.js';

export type FilePurpose = 'document' | 'product_image' | 'prescription' | 'avatar';

/** Files anyone may view (the product catalog is public). */
const PUBLIC_PURPOSES: FilePurpose[] = ['product_image'];
const LINK_TTL_SECONDS = 60 * 60;

const ALLOWED: Record<FilePurpose, { mimes: string[]; maxBytes: number }> = {
  document: { mimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 5 * 1024 * 1024 },
  prescription: { mimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 5 * 1024 * 1024 },
  product_image: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024 },
  avatar: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 2 * 1024 * 1024 },
};

const secret = () => process.env.APP_KEY ?? 'dev-only-secret';

function sign(id: string, expires: number) {
  return createHmac('sha256', secret()).update(`${id}:${expires}`).digest('base64url');
}

/** URL the apps can open. Private files get an expiring signature. */
export function fileUrl(file: { id: string; purpose: string }): string {
  const base = `${process.env.APP_URL ?? 'http://127.0.0.1:8000'}/api/v1/files/${file.id}`;
  if (PUBLIC_PURPOSES.includes(file.purpose as FilePurpose)) return base;
  const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  return `${base}?expires=${expires}&sig=${sign(file.id, expires)}`;
}

/** The stored-file id inside one of our file URLs, or null for foreign URLs. */
export function fileIdFromUrl(url: string): string | null {
  return url.match(/\/files\/([0-9a-f-]{36})(?:\?|$)/i)?.[1] ?? null;
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Stores uploads on the server's private disk (STORAGE_DIR, outside any web
 * root). The database keeps only metadata. Files are served through
 * GET /api/v1/files/:id with a short-lived signature, except public ones.
 */
@Injectable()
export class FilesService {
  readonly root = resolve(process.env.STORAGE_DIR ?? './storage');

  constructor(private readonly prisma: PrismaService) {}

  async store(file: UploadedFile | undefined, purpose: FilePurpose, ownerId: number | null, field = 'file') {
    if (!file) fieldError(field, `The ${field} field is required.`);
    const rules = ALLOWED[purpose];
    if (!rules.mimes.includes(file.mimetype)) {
      fieldError(field, `The ${field} must be a file of type: ${rules.mimes.map((m) => m.split('/')[1]).join(', ')}.`);
    }
    if (file.size > rules.maxBytes) fieldError(field, `The ${field} may not be greater than ${rules.maxBytes / 1024} kilobytes.`);

    const id = randomUUID();
    const ext = extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || this.extFor(file.mimetype);
    const relative = join(purpose, String(ownerId ?? 'system'), `${id}${ext}`);
    const absolute = this.absolute(relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.buffer);

    return this.prisma.storedFile.create({
      data: { id, ownerId, purpose, originalName: file.originalname.slice(0, 200), mimeType: file.mimetype, size: file.size, path: relative },
    });
  }

  async remove(fileId: string) {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file) return;
    await this.prisma.storedFile.delete({ where: { id: fileId } });
    await unlink(this.absolute(file.path)).catch(() => {});
  }

  /** Check a request for a file and return where it is on disk. */
  async resolveForDownload(id: string, expires?: string, sig?: string) {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('File not found.');
    if (!PUBLIC_PURPOSES.includes(file.purpose as FilePurpose)) {
      const exp = Number(expires);
      const expected = sign(id, exp);
      const valid =
        !!sig && exp * 1000 > Date.now() && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!valid) throw new NotFoundException('This link has expired. Refresh the page to get a new one.');
    }
    return { file, absolute: this.absolute(file.path) };
  }

  private absolute(relative: string) {
    const full = resolve(this.root, relative);
    // Never escape the storage root
    if (!full.startsWith(this.root + sep)) throw new NotFoundException('File not found.');
    return full;
  }

  private extFor(mime: string) {
    return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[mime] ?? '';
  }
}
