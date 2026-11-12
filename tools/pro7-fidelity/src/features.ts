import { parseRtf } from '@ordo/importers';
import { decodeAs } from '@ordo/importers/proto.ts';
import type { Pro7FeatureTag, SlideDiagnosticSource } from './types.ts';

function actionKind(a: Record<string, unknown>): string {
  if (typeof a.type === 'string' && a.type !== 'ACTION_TYPE_UNKNOWN') return a.type;
  if (a.slide) return 'ACTION_TYPE_PRESENTATION_SLIDE';
  if (a.media) return 'ACTION_TYPE_MEDIA';
  if (a.macro) return 'ACTION_TYPE_MACRO';
  if (a.timer) return 'ACTION_TYPE_TIMER';
  if (a.stage) return 'ACTION_TYPE_STAGE_LAYOUT';
  if (a.audienceLook) return 'ACTION_TYPE_AUDIENCE_LOOK';
  if (a.clear) return 'ACTION_TYPE_CLEAR';
  if (a.prop) return 'ACTION_TYPE_PROP';
  if (a.message) return 'ACTION_TYPE_MESSAGE';
  return 'ACTION_TYPE_UNKNOWN';
}

function mediaElementKind(
  m: Record<string, unknown>,
): 'image' | 'video' | 'audio' | 'liveVideo' | 'webContent' | 'unknown' {
  const el = ((m.element ?? m) as Record<string, unknown>) ?? {};
  for (const k of ['image', 'video', 'audio', 'liveVideo', 'webContent'] as const) {
    if (el[k]) return k;
  }
  if (m.element) {
    const mel = m as Record<string, unknown>;
    for (const k of ['image', 'video', 'audio', 'liveVideo'] as const) {
      if (mel[k]) return k;
    }
  }
  return 'unknown';
}

function uuidOf(u: unknown): string | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const s = (u as { string?: unknown }).string;
  return typeof s === 'string' && s ? s.toUpperCase() : undefined;
}

export function sanitizeForJson(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    const u8 = val instanceof Uint8Array ? val : new Uint8Array(val);
    return {
      byteLength: u8.length,
      utf8Preview: new TextDecoder('latin1').decode(u8.subarray(0, 1200)),
    };
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeForJson);
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = sanitizeForJson(v);
    }
    return out;
  }
  return val;
}

export function extractDeckSlideSources(
  proBytes: Uint8Array,
  opts?: { exportCompat?: boolean },
): SlideDiagnosticSource[] {
  const doc = decodeAs('rv.data.Presentation', proBytes);
  const exportCompat = opts?.exportCompat ?? false;

  const cuesById = new Map<string, Record<string, unknown>>();
  for (const c of (doc.cues ?? []) as Record<string, unknown>[]) {
    const id = uuidOf(c.uuid);
    if (id) cuesById.set(id, c);
  }

  const used = new Set<string>();
  const orderedCues: Record<string, unknown>[] = [];

  for (const cg of (doc.cueGroups ?? []) as Record<string, unknown>[]) {
    for (const cid of (cg.cueIdentifiers ?? []) as Record<string, unknown>[]) {
      const id = uuidOf(cid);
      if (!id) continue;
      const cue = cuesById.get(id);
      if (!cue) continue;
      if (used.has(id)) continue;
      used.add(id);
      orderedCues.push(cue);
    }
  }

  for (const [id, cue] of cuesById) {
    if (used.has(id)) continue;
    orderedCues.push(cue);
  }

  const sources: SlideDiagnosticSource[] = [];
  let slideNumber = 0;
  let runningVideoBg = false;
  let runningBg = false;

  for (const cue of orderedCues) {
    if (cue.isEnabled === false) continue;

    let baseSlide: Record<string, unknown> | undefined;
    let hasMediaAction = false;
    let cueVideo = false;
    let clears = false;
    const mediaActions: Record<string, unknown>[] = [];

    for (const a of (cue.actions ?? []) as Record<string, unknown>[]) {
      if (a.isEnabled === false) continue;
      const kind = actionKind(a);
      if (kind === 'ACTION_TYPE_CLEAR') {
        const target =
          ((a.clear as Record<string, unknown> | undefined)?.targetLayer as string | undefined) ??
          'CLEAR_TARGET_LAYER_ALL';
        if (target === 'CLEAR_TARGET_LAYER_ALL' || target === 'CLEAR_TARGET_LAYER_BACKGROUND') {
          clears = true;
        }
      } else if (kind === 'ACTION_TYPE_CLEAR_GROUP') {
        const name = String(
          (
            (a.clearGroup as Record<string, unknown> | undefined)?.identification as
              | Record<string, unknown>
              | undefined
          )?.parameterName ?? '',
        );
        if (/\b(all|background|media)\b/i.test(name)) clears = true;
      }

      if (kind === 'ACTION_TYPE_PRESENTATION_SLIDE') {
        const ps = (a.slide as Record<string, unknown> | undefined)?.presentation as
          | Record<string, unknown>
          | undefined;
        if (ps?.baseSlide && !baseSlide) {
          baseSlide = ps.baseSlide as Record<string, unknown>;
        }
        continue;
      }

      if (
        kind === 'ACTION_TYPE_MEDIA' ||
        kind === 'ACTION_TYPE_BACKGROUND_MEDIA' ||
        kind === 'ACTION_TYPE_FOREGROUND_MEDIA'
      ) {
        const m = a.media as Record<string, unknown> | undefined;
        if (!m) continue;
        const mk = mediaElementKind(m);
        if (mk === 'audio' || mk === 'liveVideo' || mk === 'webContent') {
          continue;
        }
        hasMediaAction = true;
        if (mk === 'video') cueVideo = true;
        mediaActions.push(a);
      }
    }

    if (!baseSlide && !hasMediaAction) {
      continue;
    }

    if (hasMediaAction) {
      runningBg = true;
      runningVideoBg = cueVideo;
    } else if (clears) {
      runningBg = false;
      runningVideoBg = false;
    }

    slideNumber++;

    const tags = new Set<Pro7FeatureTag>();

    const docName = typeof doc.name === 'string' ? doc.name.trim() : '';
    if (!docName || docName.toLowerCase() === 'untitled') {
      tags.add('untitledDoc');
    }

    const docBg = doc.background as Record<string, unknown> | undefined;
    if (docBg?.isEnabled && (docBg.color || docBg.gradient)) {
      tags.add('docBackground');
    }

    if (baseSlide?.drawsBackgroundColor) {
      tags.add('drawsBgColor');
    }

    const isVideoBg = cueVideo || (!exportCompat && runningVideoBg);
    if (isVideoBg) {
      tags.add('videoBg');
    }

    const hasActiveBg = exportCompat ? hasMediaAction : hasMediaAction || runningBg;
    if (!hasActiveBg && !baseSlide?.drawsBackgroundColor && !docBg?.isEnabled) {
      tags.add('transparentPlate');
    }

    if (docBg?.isEnabled && docBg.gradient) {
      tags.add('gradientFill');
    }

    for (const se of (baseSlide?.elements ?? []) as Record<string, unknown>[]) {
      const el = ((se.element ?? se) as Record<string, unknown>) ?? {};
      if (el.hidden) continue;

      const fill = el.fill as Record<string, unknown> | undefined;
      if (fill?.enable && fill.gradient) {
        tags.add('gradientFill');
      }

      const tlm = el.textLineMask as Record<string, unknown> | undefined;
      if (tlm?.enabled) {
        tags.add('textLineMask');
      }

      const shadow = el.shadow as Record<string, unknown> | undefined;
      if (shadow?.enable) {
        tags.add('elShadow');
      }

      const feather = el.feather as Record<string, unknown> | undefined;
      if (feather?.enable) {
        tags.add('elFeather');
      }

      const stroke = el.stroke as Record<string, unknown> | undefined;
      if (stroke?.enable) {
        tags.add('strokeBorder');
      }

      const path = el.path as Record<string, unknown> | undefined;
      const shape = path?.shape as Record<string, unknown> | undefined;
      const shapeType = shape?.type as string | number | undefined;
      if (shapeType && shapeType !== 'TYPE_RECTANGLE' && shapeType !== 1) {
        tags.add('nonRectShape');
      }
      if (
        shapeType === 'TYPE_CUSTOM' ||
        shapeType === 8 ||
        (!shapeType && ((path?.points as unknown[] | undefined)?.length ?? 0) > 0)
      ) {
        tags.add('customPath');
      }

      if (fill?.media) {
        tags.add('mediaFill');
        const media = fill.media as Record<string, unknown>;
        const drawing = ((media.image as Record<string, unknown> | undefined)?.drawing ??
          (media.video as Record<string, unknown> | undefined)?.drawing ??
          media.drawing) as Record<string, unknown> | undefined;
        if (drawing) {
          const insets = drawing.cropInsets as Record<string, number> | undefined;
          const nonZeroInsets = insets && (insets.left || insets.right || insets.top || insets.bottom);
          if (drawing.cropEnable || nonZeroInsets) {
            tags.add('mediaCrop');
          }
          const cib = drawing.customImageBounds as { size?: { width?: number; height?: number } } | undefined;
          if (cib?.size && ((cib.size.width ?? 0) > 0 || (cib.size.height ?? 0) > 0)) {
            tags.add('customImageBounds');
          }
        }
      }

      const text = el.text as Record<string, unknown> | undefined;
      if (text) {
        const textShadow = text.shadow as Record<string, unknown> | undefined;
        if (textShadow?.enable) {
          tags.add('textShadow');
        }

        const sb = text.scaleBehavior as string | number | undefined;
        if (sb && sb !== 'SCALE_BEHAVIOR_NONE' && sb !== 0) {
          tags.add('textScaleToFit');
        }

        const margins = text.margins as Record<string, number> | undefined;
        if (margins && (margins.left || margins.right || margins.top || margins.bottom)) {
          tags.add('textMargins');
        }

        const rtfData = text.rtfData as Uint8Array | undefined;
        if (rtfData && rtfData.length > 0) {
          const parsed = parseRtf(rtfData);
          const hasVisibleText = /[^\s\u200b-\u200d\ufeff]/.test(parsed.text);
          if (!hasVisibleText && (fill?.enable || stroke?.enable || shadow?.enable)) {
            tags.add('emptyRtfShape');
          }
          if (hasVisibleText && parsed.styleRuns > 1) {
            tags.add('rtfMixedRuns');
          }

          const rtfStr = new TextDecoder('latin1').decode(rtfData);
          const paraStyle = (text.attributes as Record<string, unknown> | undefined)?.paragraphStyle as
            | Record<string, unknown>
            | undefined;
          const tl = paraStyle?.textList as Record<string, unknown> | undefined;
          const hasTextList =
            !!tl?.isEnabled || ((paraStyle?.textLists as unknown[] | undefined)?.length ?? 0) > 0;
          if (
            hasTextList ||
            rtfStr.includes('\\pntext') ||
            rtfStr.includes('\\listtext') ||
            /[•\u2022\u2023\u25E6\u2043\u2219]/.test(parsed.text)
          ) {
            tags.add('rtfBullets');
          }

          const strokeWidth = (text.attributes as Record<string, unknown> | undefined)?.strokeWidth;
          const hasAttrStroke = typeof strokeWidth === 'number' && strokeWidth !== 0;
          if (
            hasAttrStroke ||
            rtfStr.includes('\\outl') ||
            (typeof parsed.strokeWidth === 'number' && parsed.strokeWidth !== 0)
          ) {
            tags.add('rtfOutline');
          }
        }
      }
    }

    const pro7SlideJson: Record<string, unknown> = {
      docName: doc.name,
      docBackground: sanitizeForJson(doc.background),
      cueName: cue.name,
      cueUuid: uuidOf(cue.uuid),
      completionTime: cue.completionTime,
      mediaActions: sanitizeForJson(mediaActions),
      baseSlide: sanitizeForJson(baseSlide),
    };

    sources.push({
      slideNumber,
      cueUuid: uuidOf(cue.uuid),
      cueName: typeof cue.name === 'string' ? cue.name : undefined,
      features: [...tags],
      pro7SlideJson,
    });
  }

  return sources;
}
