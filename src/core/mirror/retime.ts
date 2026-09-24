/**
 * A layer's RETIME (Speed % / Frame Number) read from the document MIRROR
 * (B4) — the mirror twins of `retimeCommands`' reads (`retimeBarInfo`,
 * `retimedSourceSeconds`, `retimedSpeedAt`, `sourceFrameAt`, `retimeSummary`,
 * `fitSpeedFactor`) for the Inspector's Speed section. Pure: they take a
 * mirror reader and never touch the engine.
 *
 * The integral itself is `animation/retime.ts`'s, unchanged: it takes a
 * `RetimeEngine` (isAnimated / sample / tracksFor), and `mirrorRetimeEngine`
 * is one built from the mirror's keyframes — so the Inspector evaluates the
 * exact curve the renderer does, with no per-sample query.
 *
 * Axes. The mirror's keyframe times are COMPOSITION flicks. The retime maths
 * works on the axes the legacy tracks were stored on:
 *   - `timeSpeed` keys live on the layer's clip axis, u = comp t + offsetSec
 *     (retime.ts, and retimeCommands' own `k.t - off`), so the speed track is
 *     rebuilt at u = comp seconds + offsetSec (exact at 100 % time stretch —
 *     the only stretch a retimed clip bar uses);
 *   - `timeRemap` keys live on the chain axis, which is comp time when no
 *     ancestor remap is animated, so the remap track is rebuilt at comp seconds.
 * Values are the API's, which for both are the stored units (percent; chain
 * seconds).
 *
 *   mirrorRetimeBar(m, id)                    the clip bar (`RetimeBarInfo`) from `layer.timing` + the source item
 *   mirrorRetimeEngine(m, id, bar)            a `RetimeEngine` over the mirror's retime keys
 *   mirrorSpeedPercentAt(m, id, t, bar)       the speed curve's value (percent) at comp seconds `t`
 *   mirrorRetimedSourceSeconds(m, id, t, bar) source seconds shown at comp seconds `t`
 *   mirrorRetimedSpeedAt(m, id, t, bar)       the playback-speed slope at `t` (1 = 100 %)
 *   mirrorSourceFrameAt(m, id, t, bar)        the source frame shown at `t`
 *   mirrorRetimeSummary(m, id, bar)           the footage budget (`RetimeSummary`)
 *   mirrorFitSpeedFactor(m, id, bar)          Fit to Footage's factor, or null
 */

import {
  flicksToSeconds,
  type CompSettings,
  type ItemInfo,
  type Keyframe as ApiKeyframe,
  type LayerInfo,
  type Rational,
} from '@motion/engine-api';
import { sampleTrack, type EasingKind, type Keyframe as TsKeyframe, type PropertyTrack } from '@motion/animation';
import {
  REMAP_PROP,
  SPEED_PROP,
  retimedChainTime,
  speedAdvance,
  type RetimeEngine,
  type RetimeMode,
} from '@core/animation/retime';
import type { RetimeBarInfo, RetimeSummary } from '@core/animation/retimeCommands';
import { numbersOfValue } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface RetimeMirrorRead {
  layer(id: string): LayerInfo | undefined;
  keyframes(layer: string, path: string): readonly ApiKeyframe[];
  comp(id: string): { readonly settings: CompSettings } | undefined;
  item(id: string): ItemInfo | undefined;
}

/** The API paths of the two retime tracks. */
export const SPEED_PATH = 'layer/timeSpeed';
export const REMAP_PATH = 'timeRemap';

function rateOf(r: Rational | undefined): number | null {
  return r && r.num > 0 && r.den > 0 ? r.num / r.den : null;
}

/** The layer's retime mode (`LayerTiming.retime`), 'normal' when it is gone. */
export function mirrorRetimeMode(m: Pick<RetimeMirrorRead, 'layer'>, id: string): RetimeMode {
  return m.layer(id)?.timing.retime ?? 'normal';
}

/**
 * The clip bar the retime is measured on (the twin of `retimeBarInfo`), from
 * `layer.timing`: in/out points, the clip offset (`sourceIn − start` =
 * −startTime), the bounded source length (`sourceDuration`, else the footage
 * item's duration) and the footage's own rate (conform first). Null when the
 * layer is gone.
 */
export function mirrorRetimeBar(m: Pick<RetimeMirrorRead, 'layer' | 'comp' | 'item'>, id: string): RetimeBarInfo | null {
  const layer = m.layer(id);
  if (!layer) return null;
  const fps = rateOf(m.comp(layer.comp)?.settings.frameRate) ?? 30;
  const { inPoint, outPoint, startTime, sourceDuration } = layer.timing;
  const inSec = flicksToSeconds(inPoint);
  const startSec = flicksToSeconds(startTime);
  const item = layer.source ? m.item(layer.source) : undefined;
  const footage = item?.kind === 'footage' ? item : undefined;
  const fileSec = footage && footage.duration > 0 ? flicksToSeconds(footage.duration) : null;
  return {
    fps,
    inSec,
    outSec: flicksToSeconds(outPoint),
    clip: { offsetSec: -startSec, inSec },
    sourceInSec: inSec - startSec,
    sourceDurationSec: sourceDuration !== undefined ? flicksToSeconds(sourceDuration) : fileSec,
    sourceFps: rateOf(footage?.interpretation?.conformFrameRate) ?? rateOf(footage?.frameRate) ?? fps,
  };
}

// ── The retime tracks, on the legacy axes ──────────────────────────────────

/**
 * Keyed by the mirror's keyframe ARRAY (identity = change test), so the same
 * keys at the same offset hand retime.ts the same array — its integral table
 * is cached on that identity.
 */
const trackCache = new WeakMap<readonly ApiKeyframe[], { offset: number; keys: TsKeyframe[] }>();

function tsKeys(keys: readonly ApiKeyframe[], offset: number): TsKeyframe[] {
  const hit = trackCache.get(keys);
  if (hit && hit.offset === offset) return hit.keys;
  const out = keys
    .map((k): TsKeyframe => {
      const so = k.spatialOut[0];
      const si = k.spatialIn[0];
      return {
        id: k.id,
        t: flicksToSeconds(k.time) + offset,
        value: numbersOfValue(k.value)[0] ?? 0,
        easing: k.easing as EasingKind,
        ...(k.bezier ? { bezier: [k.bezier.x1, k.bezier.y1, k.bezier.x2, k.bezier.y2] as [number, number, number, number] } : {}),
        ...(so !== undefined ? { so } : {}),
        ...(si !== undefined ? { si } : {}),
      };
    })
    .sort((a, b) => a.t - b.t);
  trackCache.set(keys, { offset, keys: out });
  return out;
}

/**
 * A `RetimeEngine` over one layer's retime keys in the mirror: `timeSpeed` on
 * the clip axis (comp seconds + the bar's offset), `timeRemap` on comp seconds.
 */
export function mirrorRetimeEngine(m: Pick<RetimeMirrorRead, 'keyframes'>, id: string, bar: RetimeBarInfo | null): RetimeEngine {
  const offset = bar?.clip.offsetSec ?? 0;
  const tracks = (): PropertyTrack[] => {
    const out: PropertyTrack[] = [];
    const speed = m.keyframes(id, SPEED_PATH);
    if (speed.length > 0) out.push({ nodeId: id, prop: SPEED_PROP, keyframes: tsKeys(speed, offset) });
    const remap = m.keyframes(id, REMAP_PATH);
    if (remap.length > 0) out.push({ nodeId: id, prop: REMAP_PROP, keyframes: tsKeys(remap, 0) });
    return out;
  };
  const track = (nodeId: string, prop: string): PropertyTrack | undefined =>
    nodeId === id ? tracks().find((t) => t.prop === prop) : undefined;
  return {
    isAnimated: (nodeId, prop) => (track(nodeId, prop)?.keyframes.length ?? 0) > 0,
    sample: (nodeId, prop, t) => {
      const tr = track(nodeId, prop);
      return tr ? sampleTrack(tr, t) : undefined;
    },
    tracksFor: (nodeId) => (nodeId === id ? tracks() : []),
  };
}

/**
 * The speed curve's value (percent) at comp seconds `t`, undefined with no
 * speed keys. Sampled at the comp FRAME `t` falls on, as the key axis maps it
 * (`compToKeyframeTime` rounds to the bar's frame before the clip map).
 */
export function mirrorSpeedPercentAt(m: Pick<RetimeMirrorRead, 'keyframes'>, id: string, t: number, bar: RetimeBarInfo | null): number | undefined {
  const fps = bar?.fps ?? 30;
  return mirrorRetimeEngine(m, id, bar).sample(id, SPEED_PROP, Math.round(t * fps) / fps + (bar?.clip.offsetSec ?? 0));
}

/** Source seconds the layer shows at comp seconds `t` (the twin of `retimedSourceSeconds`). */
export function mirrorRetimedSourceSeconds(m: Pick<RetimeMirrorRead, 'keyframes'>, id: string, t: number, bar: RetimeBarInfo | null): number {
  const off = bar?.clip.offsetSec ?? 0;
  const chain = retimedChainTime(mirrorRetimeEngine(m, id, bar), id, t, bar?.clip ?? null);
  return (chain ?? t) + off;
}

/** Speed multiplier at comp seconds `t`, as the slope of the source curve (1 = 100 %; the twin of `retimedSpeedAt`). */
export function mirrorRetimedSpeedAt(m: Pick<RetimeMirrorRead, 'keyframes'>, id: string, t: number, bar: RetimeBarInfo | null): number {
  const dt = 1 / 240;
  return (mirrorRetimedSourceSeconds(m, id, t + dt, bar) - mirrorRetimedSourceSeconds(m, id, t, bar)) / dt;
}

/** Source frame (in the footage's own rate) shown at comp seconds `t` (the twin of `sourceFrameAt`). */
export function mirrorSourceFrameAt(m: Pick<RetimeMirrorRead, 'keyframes'>, id: string, t: number, bar: RetimeBarInfo | null): number {
  return Math.round(mirrorRetimedSourceSeconds(m, id, t, bar) * (bar?.sourceFps ?? 30));
}

/** The footage budget (the twin of `retimeSummary`), or null with no bar. */
export function mirrorRetimeSummary(m: RetimeMirrorRead, id: string, bar: RetimeBarInfo | null = mirrorRetimeBar(m, id)): RetimeSummary | null {
  if (!bar) return null;
  const mode = mirrorRetimeMode(m, id);
  const end = bar.sourceDurationSec;
  const start = mirrorRetimedSourceSeconds(m, id, bar.inSec, bar);
  const last = mirrorRetimedSourceSeconds(m, id, bar.outSec, bar);
  let runsOutAtSec: number | null = null;
  if (end !== null) {
    const step = 1 / bar.fps;
    for (let t = bar.inSec; t < bar.outSec; t += step) {
      const s = mirrorRetimedSourceSeconds(m, id, t, bar);
      if (s > end + 1e-6 || s < -1e-6) { runsOutAtSec = t; break; }
    }
  }
  return {
    mode,
    usedSec: last - start,
    availableSec: end !== null ? end - bar.sourceInSec : null,
    runsOutAtSec,
    outputSec: bar.outSec - bar.inSec,
  };
}

/**
 * The factor Fit to Footage scales every speed key by (the twin of
 * `fitSpeedFactor`), or null when there is nothing to fit (no bar, unknown
 * file length, no source advance).
 */
export function mirrorFitSpeedFactor(m: RetimeMirrorRead, id: string, bar: RetimeBarInfo | null = mirrorRetimeBar(m, id)): number | null {
  if (!bar || bar.sourceDurationSec === null) return null;
  const uIn = bar.inSec + bar.clip.offsetSec;
  const uOut = bar.outSec + bar.clip.offsetSec;
  const used = speedAdvance(mirrorRetimeEngine(m, id, bar), id, uIn, uOut);
  const available = bar.sourceDurationSec - bar.sourceInSec - 1 / bar.sourceFps;
  if (!(used > 1e-6) || !(available > 0)) return null;
  return available / used;
}
