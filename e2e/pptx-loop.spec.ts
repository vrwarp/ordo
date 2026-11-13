import { mkdirSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { editorState, openEditor, save, stored } from './editorhelpers.ts';
import { PORT } from './helpers.ts';
import { hubApi } from './linkhelpers.ts';
import { apiJson, importPptx, liveEvent, type OutputRec, roleWindow } from './pptxlive.ts';
import { LYRIC_LOOP, lyricLoopDeck } from './pptxdecks.ts';

/**
 * A worship lyric deck saved as a looping PowerPoint show, every slide timed, imports as an announcement loop
 * (design/27 §8, the loop census of 2026-11-13). A loop shows standby on the Stage and nothing on the
 * Bottom-Third Stream, so the import report says so in plain words and treats it as slides in one tap: then
 * the Stage shows its words like any slide deck's.
 */

const OUT = 'test-results/pptx-loop';

test('a lyric deck that PowerPoint loops: the report explains it and "Treat as slides" brings its words back', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const a = await hubApi(PORT);
  const job = await importPptx(a, lyricLoopDeck(OUT));
  const id = job.result!.presentationId;
  const p = await stored(a, id);
  const imported = p as unknown as { kind: string; source?: { log?: string } };
  expect(imported.kind).toBe('loop');
  expect(imported.source?.log).toMatch(/PowerPoint plays this deck as a loop with every slide timed/);

  // The import report, in the Presentation panel: what a loop does on the screens, and the switch.
  await openEditor(page, PORT, id);
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  const report = page.getByRole('region', { name: 'Imported from PowerPoint' });
  await expect(report).toBeVisible();
  const loop = report.locator('[data-loop]');
  await expect(loop).toContainText('PowerPoint plays this deck as a loop');
  await expect(loop).toContainText(
    'the Stage shows “Service Starting Soon” and the Bottom-Third Stream shows nothing',
  );
  await loop.getByRole('button', { name: 'Treat as slides' }).click();
  await expect
    .poll(async () => ((await editorState(page)).draft as unknown as { kind?: string } | undefined)?.kind)
    .toBe('slides');
  await expect(report.locator('[data-loop]')).toHaveCount(0);
  await save(page);
  const after = (await stored(a, id)) as unknown as { kind: string; loop?: unknown };
  expect(after.kind).toBe('slides');
  expect(after.loop).toBeUndefined();

  // Live: the Stage shows the lyric, where a loop showed standby.
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: `Loop ${Date.now()}`, items: [{ id: 'grace', kind: 'presentation', presentationId: id }] },
  });
  const live = await apiJson<{ state: { mode: string } }>(a, 'live');
  if (live.state.mode === 'live') await liveEvent(a, { k: 'endService', at: Date.now() });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const stage = await roleWindow(context, PORT, outs.find((o) => o.kind === 'stage')!, {
    width: 1280,
    height: 720,
  });
  await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
  await stage.bringToFront();
  await expect(stage.locator('.current')).toContainText(LYRIC_LOOP[0]!, { timeout: 30_000 });
  await expect(stage.locator('body')).not.toContainText('Service Starting Soon');
  await liveEvent(a, { k: 'endService', at: Date.now() });
});
