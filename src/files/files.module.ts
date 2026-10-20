import { Controller, Get, Global, Module, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { FilesService } from './files.service.js';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Streams a stored file. Private files need a valid ?expires&sig from FilesService.url(). */
  @Get(':id')
  async download(@Param('id') id: string, @Query('expires') expires: string, @Query('sig') sig: string, @Res() res: Response) {
    const { file, absolute } = await this.files.resolveForDownload(id, expires, sig);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${file.originalName.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', file.purpose === 'product_image' ? 'public, max-age=86400' : 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(absolute);
  }
}

@Global()
@Module({ controllers: [FilesController], providers: [FilesService], exports: [FilesService] })
export class FilesModule {}
