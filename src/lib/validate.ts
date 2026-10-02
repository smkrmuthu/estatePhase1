import type { Context } from 'hono';
import { z } from 'zod';
import { invalid } from './errors';

// Parses the JSON body against a schema; a failure becomes one readable 422.
export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join('.');
    throw invalid(field ? `${field}: ${issue.message}` : issue.message, field || undefined);
  }
  return parsed.data;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-02');
export const grams = z.number().int('Weight must be whole grams').positive('Weight must be greater than zero').max(1e12);
export const bags = z.number().int('Bags must be a whole number').min(0, 'Bags cannot be negative').max(1e7);
export const text = (max: number) => z.string().trim().max(max).default('');
export const id = z.string().min(1).max(64);
