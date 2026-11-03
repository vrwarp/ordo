import {
  DEFAULT_LYRIC_STYLE,
  KEY_GREEN,
  type Look,
  nearColor,
  newId,
  parseLyrics,
  rgbaCss,
  type SlideRule,
  songFromParsed,
} from '@ordo/domain';
import { drawSlide2D } from '@ordo/renderer';
import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import {
  BoxEditor,
  Check,
  ColorField,
  Field,
  Select,
  TextField,
  TransitionEditor,
} from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
import { BackgroundPicker } from '../editor/BackgroundPicker.tsx';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

const SAMPLE = songFromParsed(
  parseLyrics(
    'Verse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n\nChorus\nMy chains are gone\nI have been set free',
  ),
  {
    linesPerSlide: 2,
  },
);

function LookPreview({ look }: { look: Look }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.fillStyle = rgbaCss(look.clearColor);
    ctx.fillRect(0, 0, c.width, c.height);
    if (look.layers.background.visible) {
      const g = ctx.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, '#1e3a8a');
      g.addColorStop(1, '#581c87');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    const s0 = SAMPLE.sections[0]!.slides[0]!;
    const s1 = SAMPLE.sections[1]!.slides[0]!;
    drawSlide2D(ctx, s0, { scale: c.width / 1920, look, isSong: true, nextSlide: s1 });
  }, [look]);
  return (
    <canvas
      ref={ref}
      width={480}
      height={270}
      style={{ width: 480, maxWidth: '100%', borderRadius: 6, border: '1px solid var(--line)' }}
    />
  );
}

/** Data-driven look editor (prd/04): layer rules, slide mode, props, clear/key colour, transition. */
export function LooksPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('looks');
  const [selId, setSelId] = useState(draft[0]?.id);
  const look = draft.find((l) => l.id === selId) ?? draft[0];
  const set = (patch: Partial<Look>) =>
    look && setDraft(draft.map((l) => (l.id === look.id ? { ...l, ...patch } : l)));
  const setLayers = (patch: Partial<Look['layers']>) => look && set({ layers: { ...look.layers, ...patch } });
  const keyWarn = useMemo(() => {
    if (!look) return false;
    const r = look.layers.slide;
    const isKey = look.kind === 'stream' || nearColor(look.clearColor, KEY_GREEN, 60);
    if (!isKey || r.mode !== 'lyricOnly') return false;
    return (
      nearColor(r.style.color, look.clearColor, 60) ||
      (!!r.style.outline && nearColor(r.style.outline.color, look.clearColor, 60))
    );
  }, [look]);
  if (!look) return null;
  const rule = look.layers.slide;
  const setRule = (r: SlideRule) => setLayers({ slide: r });
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>Looks</h2>
      <div className="row wrap">
        {draft.map((l) => (
          <button
            key={l.id}
            type="button"
            className={l.id === look.id ? 'on' : ''}
            onClick={() => setSelId(l.id)}
          >
            {l.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const copy = {
              ...structuredClone(look),
              id: newId(),
              name: `${look.name} copy`,
              kind: 'custom' as const,
            };
            setDraft([...draft, copy]);
            setSelId(copy.id);
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="danger"
          disabled={draft.length <= 1}
          onClick={async () => {
            if (
              await confirmDialog(
                'Delete look',
                `Delete “${look.name}”? Outputs using it must be given another look.`,
                'Delete',
                true,
              )
            ) {
              setDraft(draft.filter((l) => l.id !== look.id));
              setSelId(draft[0]?.id);
            }
          }}
        >
          Delete
        </button>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="col grow" style={{ gap: 12, maxWidth: 560 }}>
          <div className="grid2">
            <TextField label="Name" value={look.name} onChange={(name) => set({ name })} />
            <Select
              label="Kind"
              value={look.kind}
              options={['main', 'stage', 'lowerThird', 'stream', 'custom'] as const}
              onChange={(kind) => set({ kind })}
            />
          </div>
          <div className="card col">
            <h4>Layers</h4>
            <Check
              label="Background layer"
              value={look.layers.background.visible}
              onChange={(visible) => setLayers({ background: { visible } })}
            />
            {!look.layers.background.visible && (
              <Field label="Holding slide shown instead (optional)">
                <BackgroundPicker
                  value={look.holdingMediaId}
                  onChange={(holdingMediaId) => set({ holdingMediaId })}
                />
              </Field>
            )}
            <Check
              label="Lower third layer"
              value={look.layers.lowerThird.visible}
              onChange={(visible) => setLayers({ lowerThird: { visible } })}
            />
            <Check
              label="Media layer"
              value={look.layers.media.visible}
              onChange={(visible) => setLayers({ media: { visible } })}
            />
          </div>
          <div className="card col">
            <h4>Slide layer</h4>
            <Select
              value={rule.mode}
              options={[
                { value: 'authored', label: 'Full slide as authored' },
                { value: 'lyricOnly', label: 'Lyric text only, restyled' },
                { value: 'hidden', label: 'Hidden' },
              ]}
              onChange={(mode) =>
                setRule(
                  mode === 'lyricOnly'
                    ? {
                        mode,
                        style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 56 },
                        band: { x: 160, y: 820, w: 1600, h: 220, rotation: 0 },
                        nonSong: 'text',
                      }
                    : { mode },
                )
              }
            />
            {rule.mode === 'lyricOnly' && (
              <>
                <Select
                  label="Non-song slides"
                  value={rule.nonSong}
                  options={[
                    { value: 'text', label: 'Show the first text box' },
                    { value: 'none', label: 'Show nothing' },
                  ]}
                  onChange={(nonSong) => setRule({ ...rule, nonSong })}
                />
                <Field label="Band (where the text goes)">
                  <BoxEditor
                    value={rule.band}
                    rotation={false}
                    onChange={(band) => setRule({ ...rule, band })}
                  />
                </Field>
                <h4>Text style</h4>
                <TextStyleEditor value={rule.style} onChange={(style) => setRule({ ...rule, style })} />
                <Check
                  label="Show the next slide (stage)"
                  value={!!rule.nextSlide}
                  onChange={(on) =>
                    setRule({
                      ...rule,
                      nextSlide: on
                        ? {
                            style: {
                              ...rule.style,
                              fontSizePx: Math.round(rule.style.fontSizePx * 0.6),
                              color: { r: 200, g: 200, b: 200, a: 0.75 },
                            },
                            band: { x: 60, y: 700, w: 1800, h: 260, rotation: 0 },
                          }
                        : undefined,
                    })
                  }
                />
                {rule.nextSlide && (
                  <div className="card col">
                    <BoxEditor
                      value={rule.nextSlide.band}
                      rotation={false}
                      onChange={(band) => setRule({ ...rule, nextSlide: { ...rule.nextSlide!, band } })}
                    />
                    <TextStyleEditor
                      value={rule.nextSlide.style}
                      onChange={(style) => setRule({ ...rule, nextSlide: { ...rule.nextSlide!, style } })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          <div className="card col">
            <h4>Props</h4>
            <div className="grid2">
              {(['logo', 'countdown', 'clock', 'messages', 'elapsed'] as const).map((k) => (
                <Check
                  key={k}
                  label={k[0]!.toUpperCase() + k.slice(1)}
                  value={look.layers.props[k]}
                  onChange={(v) => setLayers({ props: { ...look.layers.props, [k]: v } })}
                />
              ))}
            </div>
          </div>
          <div className="card col">
            <h4>Clear colour and transition</h4>
            <ColorField
              label="Clear colour (black, or the key colour for streaming)"
              value={look.clearColor}
              onChange={(clearColor) => set({ clearColor })}
            />
            <div className="row">
              <button
                type="button"
                className="small"
                onClick={() => set({ clearColor: { r: 0, g: 0, b: 0, a: 1 } })}
              >
                Black
              </button>
              <button type="button" className="small" onClick={() => set({ clearColor: KEY_GREEN })}>
                Key green
              </button>
            </div>
            {keyWarn && (
              <div className="banner">
                The lyric text or outline colour is close to the key colour: OBS will key it out. Pick a
                different text colour.
              </div>
            )}
            <Field label="Transition">
              <TransitionEditor value={look.transition} onChange={(t) => t && set({ transition: t })} />
            </Field>
          </div>
        </div>
        <div className="col" style={{ position: 'sticky', top: 0 }}>
          <h4>Preview</h4>
          <LookPreview look={look} />
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}
