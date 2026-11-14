import { API_PREFIX, type ApiError } from '@ordo/protocol';

export class ApiFailure extends Error {
  public status: number;
  public code: string;
  /**
   * The other fields of the hub's error body (`{ error: { code, message, ...details } }`), when there are
   * any: a save refused with 409 carries the stored presentation's `rev` and `current` (the version that
   * won, design/27 §11 item 17); a 429 its `retryAfterS`. Hub data, read defensively.
   */
  public details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The error body's fields other than `code` and `message`; undefined when there are none or no body. */
function detailsOf(err: ApiError | undefined): Record<string, unknown> | undefined {
  const e = err?.error as (Record<string, unknown> & ApiError['error']) | undefined;
  if (!e || typeof e !== 'object') return undefined;
  const { code: _code, message: _message, ...rest } = e;
  return Object.keys(rest).length ? rest : undefined;
}

let authToken: string | undefined;
/** Output and stage windows authenticate every request with their token. */
export function setApiToken(token: string | undefined): void {
  authToken = token;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set('x-ordo-token', authToken);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(API_PREFIX + path, { ...init, headers, body, credentials: 'same-origin' });
  if (!res.ok) {
    let err: ApiError | undefined;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* not json */
    }
    throw new ApiFailure(
      res.status,
      err?.error?.code ?? 'http_' + res.status,
      err?.error?.message ?? res.statusText,
      detailsOf(err),
    );
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.blob()) as Promise<T>;
}

export function fileUrl(hash: string): string {
  return `${API_PREFIX}/files/${hash}${authToken ? `?token=${encodeURIComponent(authToken)}` : ''}`;
}

/** Upload with progress through XHR (fetch has no upload progress). */
export function upload<T>(path: string, form: FormData, onProgress?: (frac: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_PREFIX + path);
    xhr.withCredentials = true;
    if (authToken) xhr.setRequestHeader('x-ordo-token', authToken);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let json: unknown;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        json = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json as T);
      else {
        const e = json as ApiError | undefined;
        reject(
          new ApiFailure(
            xhr.status,
            e?.error?.code ?? 'upload_failed',
            e?.error?.message ?? xhr.statusText,
            detailsOf(e),
          ),
        );
      }
    };
    xhr.onerror = () => reject(new ApiFailure(0, 'network', 'Network error'));
    xhr.send(form);
  });
}
