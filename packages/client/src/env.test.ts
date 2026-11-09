import { describe, expect, it } from 'vitest';
import { roleUrl } from './env.ts';

describe('roleUrl', () => {
  it('resolves output and stage URLs with path mode on root', () => {
    const out = roleUrl('output', {
      domain: '',
      hostIndex: 1,
      outputId: 'out-1',
      token: 'tok-1',
      origin: 'http://localhost:8765',
    });
    expect(out).toBe('http://localhost:8765/output/?output=out-1&token=tok-1&out=1');

    const stage = roleUrl('stage', {
      domain: '',
      hostIndex: 0,
      outputId: 'stage-1',
      token: 'tok-2',
      origin: 'http://localhost:8765',
    });
    expect(stage).toBe('http://localhost:8765/stage/?output=stage-1&token=tok-2');
  });

  it('resolves path mode with subpath repository (e.g. GitHub Pages /ordo)', () => {
    const out = roleUrl('output', {
      domain: '',
      hostIndex: 1,
      outputId: 'out-1',
      token: 'tok-1',
      origin: 'https://example.github.io/ordo',
    });
    expect(out).toBe('https://example.github.io/ordo/output/?output=out-1&token=tok-1&out=1');
  });

  it('resolves domain mode with role subdomains', () => {
    const out = roleUrl('output', {
      domain: 'venue.ordo.church',
      hostIndex: 2,
      outputId: 'out-2',
      token: 'tok-3',
    });
    expect(out).toContain('out2.venue.ordo.church');
    expect(out).toContain('output=out-2');

    const stage = roleUrl('stage', {
      domain: 'venue.ordo.church',
      hostIndex: 0,
      outputId: 'st-1',
      token: 'tok-4',
    });
    expect(stage).toContain('stage.venue.ordo.church');
  });
});
