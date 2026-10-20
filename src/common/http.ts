import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  UnprocessableEntityException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * The apps expect Laravel-style errors:
 *   422 { message, errors: { field: ["..."] } } for invalid input
 *   4xx/5xx { message } for everything else
 */
export class FieldErrors extends UnprocessableEntityException {
  constructor(errors: Record<string, string[]>) {
    const first = Object.values(errors)[0]?.[0] ?? 'The given data was invalid.';
    super({ message: first, errors });
  }
}

/** Throw a 422 for one field, like Laravel's ValidationException::withMessages. */
export function fieldError(field: string, message: string): never {
  throw new FieldErrors({ [field]: [message] });
}

function flatten(errors: ValidationError[], prefix = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of errors) {
    const key = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) out[key] = Object.values(e.constraints);
    if (e.children?.length) Object.assign(out, flatten(e.children, key));
  }
  return out;
}

export const validationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  exceptionFactory: (errors) => new FieldErrors(flatten(errors)),
});

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('API');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body && 'errors' in body) {
        res.status(status).json(body);
        return;
      }
      const raw = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      const message = Array.isArray(raw) ? raw[0] : (raw ?? exception.message);
      // Malformed JSON etc. come through as 400s
      res.status(exception instanceof BadRequestException && status === 400 ? 400 : status).json({ message });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Server error. Please try again.' });
  }
}

export interface Page<T> {
  data: T[];
  links: { first: string | null; last: string | null; prev: string | null; next: string | null };
  meta: { current_page: number; last_page: number; per_page: number; total: number };
}

/** Read ?page & ?per_page the way the apps send them. */
export function pageParams(query: Record<string, unknown>, defaultPerPage: number, maxPerPage: number) {
  const perPage = Math.min(Math.max(Number(query.per_page) || defaultPerPage, 1), maxPerPage);
  const page = Math.max(Number(query.page) || 1, 1);
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

export function paginate<T>(data: T[], total: number, page: number, perPage: number): Page<T> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  return {
    data,
    links: { first: null, last: null, prev: null, next: null },
    meta: { current_page: page, last_page: lastPage, per_page: perPage, total },
  };
}
