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
  if (opts.domain) {
    const host = kind === 'stage' ? `stage.${opts.domain}` : `out${opts.hostIndex}.${opts.domain}`;
    return `${location.protocol}//${host}${location.port ? ':' + location.port : ''}/?${q}`;
  }
  const origin = opts.origin ?? location.origin;
  return kind === 'stage' ? `${origin}/stage/?${q}` : `${origin}/output/?${q}&out=${opts.hostIndex}`;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Origin of the operator window for a role window (used to verify fallback-bus messages). */
export function operatorOrigin(env: AppEnv = appEnv()): string {
  if (!env.domain) return location.origin;
  return `${location.protocol}//op.${env.domain}${location.port ? ':' + location.port : ''}`;
}
