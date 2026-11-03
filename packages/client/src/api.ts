import { API_PREFIX, type ApiError } from '@ordo/protocol';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
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
      err?.error.code ?? 'http_' + res.status,
      err?.error.message ?? res.statusText,
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
          new ApiFailure(xhr.status, e?.error.code ?? 'upload_failed', e?.error.message ?? xhr.statusText),
        );
      }
    };
    xhr.onerror = () => reject(new ApiFailure(0, 'network', 'Network error'));
    xhr.send(form);
  });
}
