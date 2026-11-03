import { describe, expect, it } from 'vitest';
import type { Output } from '@ordo/domain';
import {
  matchScreen,
  placementUpdates,
  planLaunch,
  type ScreenInfo,
  windowFeatures,
} from '../src/lib/screens.ts';

const primary: ScreenInfo = {
  label: 'Dell U2720',
  left: 0,
  top: 0,
  width: 2560,
  height: 1440,
  isPrimary: true,
};
const proj: ScreenInfo = { label: 'EPSON PJ', left: 2560, top: 0, width: 1920, height: 1080 };
const tv: ScreenInfo = { label: 'SAMSUNG', left: 4480, top: 0, width: 1920, height: 1080 };
const tv2: ScreenInfo = { label: 'SAMSUNG', left: 6400, top: 0, width: 1920, height: 1080 };

function out(id: string, screen?: Output['screen'], enabled = true): Output {
  return {
    id,
    name: id,
    kind: 'output',
    hostIndex: 1,
    lookId: 'look-main',
    enabled,
    audioMaster: false,
    screen,
  };
}

describe('screen matching', () => {
  it('matches by label first', () => {
    expect(
      matchScreen({ label: 'EPSON PJ', left: 0, top: 0, width: 1, height: 1 }, [primary, proj])?.by,
    ).toBe('label');
  });
  it('disambiguates duplicate labels by position', () => {
    const m = matchScreen({ label: 'SAMSUNG', left: 6400, top: 0, width: 1920, height: 1080 }, [tv, tv2]);
    expect(m?.screen).toBe(tv2);
  });
  it('falls back to position when the label changed', () => {
    const m = matchScreen({ label: 'old name', left: 2560, top: 0, width: 1920, height: 1080 }, [
      primary,
      proj,
    ]);
    expect(m).toEqual({ screen: proj, by: 'position' });
  });
  it('returns null when nothing matches', () => {
    expect(matchScreen({ label: 'gone', left: 9999, top: 0, width: 1, height: 1 }, [primary])).toBeNull();
    expect(matchScreen(undefined, [primary])).toBeNull();
  });
  it('plans every enabled output, never reusing a screen, unmatched on primary', () => {
    const outputs = [
      out('a', { label: 'SAMSUNG', left: 4480, top: 0, width: 1920, height: 1080 }),
      out('b', { label: 'SAMSUNG', left: 6400, top: 0, width: 1920, height: 1080 }),
      out('c', { label: 'missing', left: 1, top: 1, width: 1, height: 1 }),
      out('d', undefined, false),
    ];
    const plan = planLaunch(outputs, [primary, proj, tv, tv2]);
    expect(plan.map((p) => [p.output.id, p.screen.left, p.matched])).toEqual([
      ['a', 4480, 'label'],
      ['b', 6400, 'label'],
      ['c', 0, null],
    ]);
  });
  it('reports placements to save back', () => {
    const outputs = [out('a', { label: 'old', left: 2560, top: 0, width: 1920, height: 1080 })];
    const upd = placementUpdates(planLaunch(outputs, [primary, proj]));
    expect(upd[0]?.screen?.label).toBe('EPSON PJ');
    expect(windowFeatures(proj)).toBe('popup,fullscreen,left=2560,top=0,width=1920,height=1080');
  });
});
