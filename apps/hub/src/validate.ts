import type { z } from 'zod';
import { badRequest } from './errors.ts';

export function validate<S extends z.ZodType>(schema: S, data: unknown, what = 'body'): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || what}: ${i.message}`)
      .join('; ');
    throw badRequest(`Invalid ${what}: ${msg}`, 'invalid');
  }
  return r.data;
}
