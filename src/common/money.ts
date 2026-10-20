import { randomBytes } from 'node:crypto';

/** Prisma Decimal / string / number -> number of naira (2dp). */
type Numeric = number | string | { toFixed(digits?: number): string } | null | undefined;

export function num(value: Numeric): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(typeof value === 'object' ? value.toFixed() : value) * 100) / 100;
}

export function numOrNull(value: Numeric): number | null {
  return value === null || value === undefined ? null : num(value);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "LL-8F2KQ..." style references. */
export function reference(prefix = 'LL'): string {
  return `${prefix}-${randomBytes(9).toString('base64url').toUpperCase().slice(0, 12)}`;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
