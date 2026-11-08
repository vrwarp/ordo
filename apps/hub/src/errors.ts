/** An error that maps to an HTTP status and the `{ error: { code, message } }` body. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, 'unauthorized', message);
export const conflict = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(409, 'conflict', message, extra);
export const locked = (message = 'Locked while live') => new HttpError(423, 'locked', message);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
