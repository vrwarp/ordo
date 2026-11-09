/** Where am I? Role and output identity derived from hostname and query string. */
export type AppEnv = {
  /** e.g. pres.example.synology.me, or '' in path/dev mode */
  domain: string;
  token?: string;
  outputId?: string;
  hostIndex?: number;
};

const ROLE_LABEL = /^(op|hub|stage|out\d+)$/;

export function appEnv(loc: Location = location): AppEnv {
  const q = new URLSearchParams(loc.search);
  const labels = loc.hostname.split('.');
  const first = labels[0] ?? '';
  const domain = ROLE_LABEL.test(first) && labels.length >= 2 ? labels.slice(1).join('.') : '';
  const outMatch = /^out(\d+)$/.exec(first);
  const hostIndex = outMatch ? Number(outMatch[1]) : q.get('out') ? Number(q.get('out')) : undefined;
  return {
    domain,
    token: q.get('token') ?? undefined,
    outputId: q.get('output') ?? undefined,
    hostIndex,
  };
}

/**
 * URL of an output or stage window. With a domain, each role has its own origin (process isolation);
 * without one (dev, tests on localhost) roles are served under paths of the current origin.
 */
export function roleUrl(
  kind: 'output' | 'stage',
  opts: { domain: string; hostIndex: number; outputId: string; token: string; origin?: string },
): string {
  const q = `output=${encodeURIComponent(opts.outputId)}&token=${encodeURIComponent(opts.token)}`;
  const loc = typeof location !== 'undefined' ? location : undefined;
  if (opts.domain) {
    const proto = loc?.protocol ?? 'https:';
    const port = loc?.port ? `:${loc.port}` : '';
    const host = kind === 'stage' ? `stage.${opts.domain}` : `out${opts.hostIndex}.${opts.domain}`;
    return `${proto}//${host}${port}/?${q}`;
  }
  // Path mode: the windows live under the operator app's own directory (`/` on a hub, `/ordo/` on GitHub
  // Pages), so they are resolved against it rather than the origin root.
  let baseHref: string;
  if (opts.origin) {
    baseHref = opts.origin.endsWith('/') ? opts.origin : `${opts.origin}/`;
  } else if (loc) {
    let path = loc.pathname;
    if (!path.endsWith('/')) {
      if (/\/[^/]+\.[^/]+$/.test(path)) {
        path = path.replace(/\/[^/]+\.[^/]+$/, '/');
      } else {
        path = `${path}/`;
      }
    }
    baseHref = `${loc.origin}${path}`;
  } else {
    baseHref = 'http://localhost:8765/';
  }
  return kind === 'stage'
    ? new URL(`stage/?${q}`, baseHref).href
    : new URL(`output/?${q}&out=${opts.hostIndex}`, baseHref).href;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Origin of the operator window for a role window (used to verify fallback-bus messages). */
export function operatorOrigin(env: AppEnv = appEnv()): string {
  if (!env.domain) return location.origin;
  return `${location.protocol}//op.${env.domain}${location.port ? ':' + location.port : ''}`;
}
