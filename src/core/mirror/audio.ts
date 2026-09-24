/**
 * A layer's SOUND over the document MIRROR (B4, docs/B4_MIRROR.md) — what the
 * Audio section, the Media section's audio rows, the audio dialogs (ducking,
 * gate, silence removal, drivers) and their write helpers (audioEdits.ts)
 * read. Pure: every reader takes a `MirrorAudioRead` (the app passes the
 * document mirror) and never touches the engine.
 *
 *   staticLevelDb(m, id)            `audio/levels`' static value (dB; the legacy percent is migrated by the engine)
 *   hasOwnBar(m, id)                whether the layer is timed by its own timeline bar
 *   audioClipTimings(m, id)         the bar as the audio code has always seen it (comp start, source in / out)
 *   unbarredTiming(m, id)           a bar-less layer's `audio/clipStart|clipIn|clipOut`
 *   audibleSpan(m, id)              the comp-time span the layer sounds over
 *   planFadeKeysIn(m, id, …)        a fade's two keys (the twin of audioFades `planFadeKeys`)
 *   duckingOf / gateOf / audioDriversOf   the remembered records (`audio/ducking|gate|drivers`), normalised
 *   soundLayers(m) / pairedSoundLayers(m, id)   layers with a sound source; the ones sharing this one's file
 *   driverRangeOf(settings)         the bake range: the work area, else the whole comp
 *
 * ── Bars ──────────────────────────────────────────────────────────────
 * The engine API models one bar per layer (`LayerInfo.timing`; a split makes a
 * new layer). A GROUP's members are bar-less by design (TimelineController
 * `governingClipsFor`: "only a group's members are clip-less") — they sound
 * from their Audio component's own Start / In / Out, the `audio/clip*` fields.
 * `timing` is comp-time flicks; the source offset of the bar's head is
 * `inPoint − startTime` (what `Clip.sourceIn` was), in comp seconds like the
 * legacy `readAudioClipTimings` (neither applies the stretch).
 */

import { flicksToSeconds, type CompSettings, type ItemInfo, type LayerInfo, type PropertyInfo } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { planFade, type FadeSide } from '@core/audio/audioFades';
import { readDucking, type DuckingRecord } from '@core/audio/ducking';
import { readGate, type GateParams } from '@core/audio/audioGate';
import { readAudioDrivers, type AudioDriver } from '@core/audio/audioDriver';
import type { AudioClipTiming } from '@core/audio/audioScene';
import { uiKindOf } from './layerKinds';
import { numbersOfValue, plainValue } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorAudioRead {
  layer(id: string): LayerInfo | undefined;
  property(layer: string, path: string): PropertyInfo | undefined;
  item(id: string): ItemInfo | undefined;
  layerIds(): readonly string[];
}

export const AUDIO_LEVELS_PATH = 'audio/levels';
export const AUDIO_PAN_PATH = 'audio/pan';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A property's static value as one number (API units), or undefined when the layer has no such property. */
function staticNumber(m: Pick<MirrorAudioRead, 'property'>, id: string, path: string): number | undefined {
  return num(numbersOfValue(m.property(id, path)?.value)[0]);
}

/**
 * The layer's static level in dB — what a fade ends at and what a duck or gate
 * is written relative to (the twin of audioFades / ducking `staticLevelDbOf`).
 * The static value is the stored one even while the level is keyed (the tree
 * is read without a time), and an unstored dB level is the legacy percent,
 * migrated by the engine. 0 when the layer has no level.
 */
export function staticLevelDb(m: Pick<MirrorAudioRead, 'property'>, id: string): number {
  return staticNumber(m, id, AUDIO_LEVELS_PATH) ?? 0;
}

/** The static pan (−100…100, 0 = centred), 0 when the layer has none. */
export function staticPan(m: Pick<MirrorAudioRead, 'property'>, id: string): number {
  return staticNumber(m, id, AUDIO_PAN_PATH) ?? 0;
}

/** Whether the layer is timed by its own bar (false for a plain group's members — see the header). */
export function hasOwnBar(m: Pick<MirrorAudioRead, 'layer'>, id: string): boolean {
  const layer = m.layer(id);
  if (!layer) return false;
  const parent = layer.parent ? m.layer(layer.parent) : undefined;
  return parent?.kind !== 'group';
}

/** The layer's bar as `readAudioClipTimings` reported it (comp seconds; one bar), or [] with no bar of its own. */
export function audioClipTimings(m: Pick<MirrorAudioRead, 'layer'>, id: string): Array<AudioClipTiming & { id: string }> {
  const layer = m.layer(id);
  if (!layer || !hasOwnBar(m, id)) return [];
  const t = layer.timing;
  const inSec = flicksToSeconds(t.inPoint - t.startTime);
  return [{
    id,
    startSec: flicksToSeconds(t.inPoint),
    inSec,
    outSec: inSec + flicksToSeconds(t.outPoint - t.inPoint),
  }];
}

/** The source's length in seconds (its footage item), 0 when unknown. */
export function sourceSeconds(m: Pick<MirrorAudioRead, 'layer' | 'item'>, id: string): number {
  const src = m.layer(id)?.source;
  const item = src ? m.item(src) : undefined;
  return item ? flicksToSeconds(item.duration) : 0;
}

/**
 * A bar-less layer's own Start / In / Out (`audio/clipStart|clipIn|clipOut`,
 * source seconds). An Out of 0 is an unset one (the field's default) and reads
 * as the source's length, as the Audio component's `__out` always did.
 */
export function unbarredTiming(m: Pick<MirrorAudioRead, 'layer' | 'item' | 'property'>, id: string): AudioClipTiming {
  const out = staticNumber(m, id, 'audio/clipOut') ?? 0;
  return {
    startSec: staticNumber(m, id, 'audio/clipStart') ?? 0,
    inSec: staticNumber(m, id, 'audio/clipIn') ?? 0,
    outSec: out > 0 ? out : sourceSeconds(m, id),
  };
}

/** The comp-time span over which the layer is audible (the twin of audioFades `audibleSpan`). */
export function audibleSpan(m: Pick<MirrorAudioRead, 'layer' | 'item' | 'property'>, id: string): { startSec: number; endSec: number } | null {
  if (!m.layer(id)) return null;
  const timings = audioClipTimings(m, id);
  if (timings.length > 0) {
    const t = timings[0]!;
    const end = t.startSec + (t.outSec - t.inSec);
    return end > t.startSec ? { startSec: t.startSec, endSec: end } : null;
  }
  // No bar: the Audio component's own props are what the engine reads — only
  // a layer that HAS them (an audio layer) has a span.
  if (!m.property(id, 'audio/clipStart')) return null;
  const t = unbarredTiming(m, id);
  const end = t.startSec + (t.outSec - t.inSec);
  return end > t.startSec ? { startSec: t.startSec, endSec: end } : null;
}

/**
 * A fade as DATA (the twin of audioFades `planFadeKeys`): its two keys at
 * COMPOSITION seconds. `toLayerTime` is the layer's keyframe axis
 * (compToKeyframeTime) — a retime that maps both ends onto one layer time is a
 * step, not a fade, and yields nothing.
 */
export function planFadeKeysIn(
  m: Pick<MirrorAudioRead, 'layer' | 'item' | 'property'>,
  id: string,
  side: FadeSide,
  durationSec: number,
  toLayerTime: (compSec: number) => number,
): Array<{ seconds: number; value: number }> {
  const span = audibleSpan(m, id);
  if (!span) return [];
  const keys = planFade(span, side, durationSec, staticLevelDb(m, id), (t) => t);
  if (keys.length !== 2) return [];
  if (toLayerTime(keys[0]!.t) === toLayerTime(keys[1]!.t)) return [];
  return keys.map((k) => ({ seconds: k.t, value: k.value as number }));
}

// ── Remembered records (json fields, normalised by their own readers) ──

/** A record's reader takes a node; the mirror hands it the field's json on the component it lives on. */
const onComponent = (type: string, key: string, raw: unknown): SceneNode =>
  ({ components: [{ id: '', type, props: { [key]: raw } }] }) as unknown as SceneNode;

function jsonOf(m: Pick<MirrorAudioRead, 'property'>, id: string, path: string): unknown {
  const v = m.property(id, path)?.value;
  return v?.kind === 'json' ? plainValue(v) : undefined;
}

/** The ducking remembered on a layer (`audio/ducking`), or null. */
export function duckingOf(m: Pick<MirrorAudioRead, 'property'>, id: string): DuckingRecord | null {
  const raw = jsonOf(m, id, 'audio/ducking');
  return raw == null ? null : readDucking(onComponent('Transform', '__ducking', raw));
}

/** The noise gate remembered on a layer (`audio/gate`), or null. */
export function gateOf(m: Pick<MirrorAudioRead, 'property'>, id: string): GateParams | null {
  const raw = jsonOf(m, id, 'audio/gate');
  return raw == null ? null : readGate(onComponent('Audio', '__gate', raw));
}

/** Every audio driver remembered on a layer (`audio/drivers`), by driven track. */
export function audioDriversOf(m: Pick<MirrorAudioRead, 'property'>, id: string): Record<string, AudioDriver> {
  const raw = jsonOf(m, id, 'audio/drivers');
  return raw == null ? {} : readAudioDrivers(onComponent('Transform', '__audioDriver', raw));
}

// ── Layers with sound ──────────────────────────────────────────────────

export interface SoundLayer {
  id: string;
  name: string;
  /** The footage item (asset) it plays. */
  source: string;
  comp: string;
}

/**
 * Every layer with a sound source, in the mirror's layer order: audio layers
 * and video layers (a video's own track is a legitimate sidechain) with a
 * source item — the twin of silenceRemoval `audioVoices` / ducking
 * `duckableLayers`.
 */
export function soundLayers(m: Pick<MirrorAudioRead, 'layer' | 'layerIds'>): SoundLayer[] {
  return soundLayersIn(m.layerIds().map((id) => m.layer(id)));
}

/** {@link soundLayers} over headers already in hand (a component's `useMirrorLayers`). */
export function soundLayersIn(layers: ReadonlyArray<LayerInfo | undefined>): SoundLayer[] {
  const out: SoundLayer[] = [];
  for (const l of layers) {
    if (!l?.source) continue;
    const kind = uiKindOf(l);
    if (kind !== 'audio' && kind !== 'video') continue;
    out.push({ id: l.id, name: l.name || l.id, source: l.source, comp: l.comp });
  }
  return out;
}

/**
 * Every layer in the same composition playing the same file as `id`, `id`
 * included (the twin of silenceRemoval `pairedAudioNodeIds`: a take and its
 * detached sound are cut together).
 */
export function pairedSoundLayers(m: Pick<MirrorAudioRead, 'layer' | 'layerIds'>, id: string): string[] {
  return pairedSoundLayersIn(m.layerIds().map((l) => m.layer(l)), id);
}

/** {@link pairedSoundLayers} over headers already in hand (every layer of the document). */
export function pairedSoundLayersIn(layers: ReadonlyArray<LayerInfo | undefined>, id: string): string[] {
  const all = soundLayersIn(layers);
  const own = all.find((s) => s.id === id);
  if (!own) return layers.some((l) => l?.id === id) ? [id] : [];
  const out = all.filter((s) => s.source === own.source && s.comp === own.comp).map((s) => s.id);
  return out.length > 0 ? out : [id];
}

// ── Ranges ─────────────────────────────────────────────────────────────

/** Frames per second of a composition's settings (30 when unknown). */
export function settingsFps(settings: Pick<CompSettings, 'frameRate'> | undefined): number {
  const r = settings?.frameRate;
  return r && r.num > 0 ? r.num / (r.den || 1) : 30;
}

/** The bake range of a composition: its work area when one is set, else the whole comp (the twin of audioDriver `driverRange`). */
export function driverRangeOf(settings: Pick<CompSettings, 'frameRate' | 'workArea' | 'duration'> | undefined): { start: number; end: number; fps: number } {
  const fps = settingsFps(settings);
  const wa = settings?.workArea;
  if (wa && wa.duration > 0) {
    const start = flicksToSeconds(wa.start);
    return { start, end: flicksToSeconds(wa.start + wa.duration), fps };
  }
  return { start: 0, end: Math.max(1 / fps, settings ? flicksToSeconds(settings.duration) : 0), fps };
}
