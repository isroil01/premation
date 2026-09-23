/**
 * Layer ▸ Time — the footage verbs as COMMANDS: Time-Reverse Layer, Freeze
 * Frame at playhead, Freeze On Last Frame, Time Stretch…, Enable/Remove Time
 * Remapping, and the frame-blend modes.
 *
 * Every one of these already existed as a switch somewhere — the Compositing
 * section's Time group, the viewport's right-click Video submenu — but the
 * application menu's Time entry listed two speed ramps and nothing else, so
 * the menu (and the command palette that reads it) said the editor could not
 * reverse or freeze footage. After Effects keeps all of these under
 * Layer ▸ Time; so does this. The writes go through the same
 * `updateNodeLayerTime` / time-remap track the switches use, so the two
 * surfaces cannot disagree.
 *
 * ── TIME STRETCH AND THE CLIP BAR ──────────────────────────────────────────
 * Stretch used to change the playback rate and nothing else: the bar kept its
 * length, so a 200 % layer ran out of bar half-way through its footage, and
 * there was no way to say WHICH moment should stay put. AE's dialog asks for
 * a Hold in Place point (in-point, current frame, out-point); the bar scales
 * about that frame and the source frame showing there is unchanged. See
 * `stretchClipGeometry` for the derivation — clip bars are FRAMES, the stretch
 * is applied on top of the clip map in SOURCE seconds, anchored at the
 * keyframe span start, exactly as `compToKeyframeTime` composes them.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { defaultAnimation } from '@motion/animation';
import { customPrompt } from '@components/Modal';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isPrecomp } from '@core/scene/precomp';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getNodeLayerTime, updateNodeLayerTime, type FrameBlend } from '@core/scene/layerTime';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { runAnimEdit } from './animationCommands';
import { runAsOneHistoryEntrySync } from '@core/composition/compositeEdit';
import { hasRetime, RETIME_PROPS, type RetimeMode } from './retime';
import { SPEED_PRESETS, applySpeedPreset, setRetimeMode } from './retimeCommands';
import {
  clampStretch,
  clampSignedStretch,
  holdFrameFor,
  stretchClipGeometry,
  bakeStretchGeometry,
  retimeLayerKeyframes,
  readBakedStretch,
  writeBakedStretch,
  type ClipGeometry,
  type StretchHold,
} from './timeStretch';

// The Time Stretch maths moved to ./timeStretch (the engine's timeStretchLayers
// runs it too); every name stays importable from here.
export {
  clampStretch,
  clampSignedStretch,
  holdFrameFor,
  stretchClipGeometry,
  bakeStretchGeometry,
  retimeKeys,
  retimeLayerKeyframes,
  readBakedStretch,
  type ClipGeometry,
  type StretchBake,
  type StretchHold,
} from './timeStretch';

/** Same prop names PrecompControl writes — one track, two surfaces. */
const REMAP = 'timeRemap';

function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

/** Layers whose source has a time axis to retime: footage, audio, precomps. */
function retimable(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = readNodeKind(node);
  return kind === 'video' || kind === 'audio' || isPrecomp(node);
}

/** For the dialog and the inspector: footage stretches its playback rate, everything else bakes. */
export function isRetimableLayer(nodeId: string): boolean {
  return retimable(nodeId);
}

/**
 * What Time Stretch applies to: EVERY layer, as in After Effects. A solid,
 * shape, text, null, camera or light has no source to resample, so the stretch
 * scales its bar and its keyframes instead (`bakeLayerStretch`). Only the comp
 * root — no parent — is not a layer.
 */
function stretchable(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && node.parent !== null && node.parent !== undefined;
}

/** Reverse, Freeze, Time Remap and Frame Blend: footage-like layers only. */
export function timeTargets(): string[] {
  return useSelectionStore.getState().ids.filter(retimable);
}

/** Time Stretch: any selected layer. */
export function stretchTargets(): string[] {
  return useSelectionStore.getState().ids.filter(stretchable);
}

function notify(message: string): void {
  useUIStore.getState().notify({ level: 'info', message, durationMs: 3500 });
}

/** Reverse (or un-reverse) every selected footage layer. */
export function toggleReverse(ids: ReadonlyArray<string>): void {
  const anyForward = ids.some((id) => !getNodeLayerTime(id).reverse);
  for (const id of ids) updateNodeLayerTime(id, { reverse: anyForward });
}

/** Freeze every selected layer on the frame under the playhead (or unfreeze). */
export function toggleFreeze(ids: ReadonlyArray<string>, compTime: number): void {
  const anyLive = ids.some((id) => !getNodeLayerTime(id).freeze);
  for (const id of ids) {
    updateNodeLayerTime(id, anyLive ? { freeze: true, freezeTime: compTime } : { freeze: false });
  }
}


/** Time stretch as a percentage of the original duration (100 = as shot). */
export function applyStretch(ids: ReadonlyArray<string>, percent: number): void {
  const stretch = clampStretch(percent);
  for (const id of ids) updateNodeLayerTime(id, { stretch });
}

export function setFrameBlend(ids: ReadonlyArray<string>, frameBlend: FrameBlend): void {
  for (const id of ids) updateNodeLayerTime(id, { frameBlend });
}

/** Retimed in either mode — Speed % or Frame Number. */
export function hasTimeRemap(nodeId: string): boolean {
  return hasRetime(defaultAnimation, nodeId);
}

/**
 * Enable time remapping: one keyframe at the playhead holding the current
 * source time (the identity — nothing moves until a second keyframe does),
 * exactly what PrecompControl's switch writes. Remove drops every retime
 * track, Speed % included, so the layer is back to normal playback.
 */
export function toggleTimeRemap(ids: ReadonlyArray<string>, compTime: number): void {
  const anyOff = ids.some((id) => !hasTimeRemap(id));
  runAnimEdit(anyOff ? 'Enable time remap' : 'Remove time remap', () => defaultAnimation.batch(() => {
    for (const id of ids) {
      if (anyOff) {
        if (hasTimeRemap(id)) continue;
        const remapT = compToKeyframeTime(id, compTime, REMAP);
        defaultAnimation.setKeyframe(id, REMAP, remapT, compTime);
      } else {
        for (const prop of RETIME_PROPS) defaultAnimation.removeTrack(id, prop);
      }
    }
  }));
}

/**
 * Stretch `ids` to `percent`, scaling each bar about its Hold in Place frame.
 * The bar geometry is ONE timeline history entry for the whole selection.
 */
export function applyTimeStretch(
  ids: ReadonlyArray<string>,
  percent: number,
  hold: StretchHold,
  compTime = playhead(),
): Promise<void> {
  // ONE undo entry. The bar lengths live in the engine's clip history and the
  // stretch factor on the scene (the app's snapshot history), so writing each
  // through its own history left two Ctrl+Z presses for one dialog OK — the
  // first undid the bar and left the footage playing at the new rate.
  // A document-level entry captures both domains around the whole edit — and a
  // non-footage stretch adds keyframes to that list. The edit is synchronous,
  // so the SYNC variant: the async one re-enables history recording only a
  // microtask later, and a control edited in the same turn (the inspector's
  // Time Stretch field, then the next field) recorded nothing.
  try {
    runAsOneHistoryEntrySync('Time Stretch', () => applyTimeStretchNow(ids, percent, hold, compTime));
    return Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

function applyTimeStretchNow(
  ids: ReadonlyArray<string>,
  percent: number,
  hold: StretchHold,
  compTime: number,
): void {
  const signed = clampSignedStretch(percent);
  // A layer with no source (solid, shape, text, null, camera, light) has
  // nothing to resample: AE stretches its bar, keyframes and markers. `signed`
  // is the ABSOLUTE value the layer should end at; the bake applies the
  // relative factor from the value it stores. See `bakeLayerStretch`.
  const baked = ids.filter((id) => stretchable(id) && !retimable(id));
  if (baked.length > 0) bakeLayerStretch(baked, signed, hold, compTime);
  // Footage keeps its playback-rate path. A negative factor means "reverse the
  // keyframes", which footage expresses with Time-Reverse Layer instead.
  const footage = signed > 0 ? ids.filter(retimable) : [];
  if (footage.length === 0) return;

  const stretch = clampStretch(signed);
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  const currentFrame = Math.round(compTime * fps);

  type Edit = { layer: ReturnType<typeof c.getLayersForNode>[number]; prev: ClipGeometry; next: ClipGeometry };
  const edits: Edit[] = [];
  const markerMoves: Array<{ id: string; anchor: number; place: (f: number) => number; scale: number }> = [];
  for (const id of footage) {
    const old = getNodeLayerTime(id).stretch;
    if (old === stretch) continue;
    const layers = c.getLayersForNode(id).filter((l) => !l.locked);
    if (layers.length === 0) continue;
    const span = {
      start: Math.min(...layers.map((l) => l.start)),
      end: Math.max(...layers.map((l) => l.start + l.duration)),
    };
    const H = holdFrameFor(span, hold, currentFrame);
    const a = defaultAnimation.timeSpan(id)?.start ?? 0;
    const r = stretch / (old > 0 ? old : 100);
    let shift: number | null = null;
    for (const layer of layers) {
      const prev = { start: layer.clip.start, duration: layer.clip.duration, sourceIn: layer.clip.sourceIn };
      const next = stretchClipGeometry(prev, old, stretch, H, fps, a, layer.clip.sourceDuration !== null);
      // A bar clamped at frame 0 slid right; its markers slide with it.
      shift ??= next.start - (H - (H - prev.start) * r);
      edits.push({ layer, prev, next });
    }
    const s = shift ?? 0;
    markerMoves.push({
      id,
      anchor: c.getLayersForNode(id)[0]?.start ?? 0,
      place: (f) => H + (f - H) * r + s,
      scale: r,
    });
  }

  if (edits.length > 0) {
    // Silently: the caller's single document-level entry is the undo step. A
    // recorded engine command would also sit on the engine's own stack.
    c.timeline.history.silently(() => {
      for (const e of edits) {
        e.layer.clip.start = e.next.start;
        e.layer.clip.duration = e.next.duration;
        e.layer.clip.sourceIn = e.next.sourceIn;
        c.timeline.events.emit('LayerUpdated', { layer: e.layer, changed: 'clip' });
      }
      for (const m of markerMoves) moveLayerMarkers(m.id, m.anchor, m.place, m.scale, false);
    });
  }
  // Footage ONLY: the stored rate is what the renderer time-scales by, and a
  // non-footage layer in the same selection has already been baked.
  for (const id of footage) updateNodeLayerTime(id, { stretch });
}

/** The absolute stretch % the dialog, the inspector and any Stretch column show. */
export function stretchValueOf(nodeId: string): number {
  return retimable(nodeId) ? getNodeLayerTime(nodeId).stretch : readBakedStretch(nodeId);
}

/**
 * Move a layer's markers with its stretched bar.
 *
 * A layer marker's frame is relative to the node's FIRST bar (`getLayerMarkers`
 * reads it through `toAbsoluteTime`), so: to comp frames with the anchor from
 * BEFORE the edit, through `place` (the same comp-frame map the bar took), back
 * with the anchor AFTER it. A span scales by `scale`; reversed, its END lands
 * where its start was mirrored to. Call inside the edit's `history.silently`.
 */
function moveLayerMarkers(
  nodeId: string,
  anchorBefore: number,
  place: (frame: number) => number,
  scale: number,
  reversed: boolean,
): void {
  const c = getTimelineController();
  const layers = c.getLayersForNode(nodeId);
  const anchorAfter = layers[0]?.start ?? anchorBefore;
  for (const layer of layers) {
    const markers = layer.markers.list();
    if (markers.length === 0) continue;
    for (const m of markers) {
      const from = anchorBefore + m.frame;
      const start = reversed ? place(from + m.duration) : place(from);
      m.frame = Math.max(0, Math.round(start) - anchorAfter);
      m.duration = Math.max(0, Math.round(m.duration * Math.abs(scale)));
      c.timeline.events.emit('MarkerUpdated', { marker: m });
    }
    layer.markers.reindex();
  }
}

/**
 * Take each layer from its STORED stretch to `target` (absolute, signed %): the
 * relative factor target / current scales its bar(s), keyframes and markers
 * about its hold frame (a sign change reverses them), then `target` is
 * recorded. 200 → 100 therefore puts a layer back exactly where it started.
 */
function bakeLayerStretch(
  ids: ReadonlyArray<string>,
  target: number,
  hold: StretchHold,
  compTime: number,
): void {
  const c = getTimelineController();
  for (const id of ids) {
    const factor = target / readBakedStretch(id);
    if (!Number.isFinite(factor) || factor === 0 || factor === 1) continue;
    const all = c.getLayersForNode(id);
    const layers = all.filter((l) => !l.locked);
    // No bar, no hold frame to stretch about — and nothing on screen to scale.
    if (layers.length === 0) continue;
    // Markers are stored relative to the node's first bar, as it is NOW.
    const markerAnchor = all[0]?.start ?? 0;
    const fps = c.fpsForNode(id);
    const span = {
      start: Math.min(...layers.map((l) => l.start)),
      end: Math.max(...layers.map((l) => l.start + l.duration)),
    };
    const H = holdFrameFor(span, hold, Math.round(compTime * fps));
    const plan = bakeStretchGeometry(
      layers.map((l) => ({ start: l.clip.start, duration: l.clip.duration, sourceIn: l.clip.sourceIn })),
      factor,
      H,
      fps,
    );
    if (!plan) continue;
    // Silently: `applyTimeStretch`'s document-level entry is the undo step.
    c.timeline.history.silently(() => {
      layers.forEach((layer, i) => {
        const next = plan.bars[i];
        if (!next) return;
        layer.clip.start = next.start;
        layer.clip.duration = next.duration;
        layer.clip.sourceIn = next.sourceIn;
        c.timeline.events.emit('LayerUpdated', { layer, changed: 'clip' });
      });
    });
    c.invalidateLayerIndex();
    // After the index rebuild: a reversal can change which bar is first.
    moveLayerMarkers(id, markerAnchor, plan.place, factor, factor < 0);
    retimeLayerKeyframes(id, plan.keyScale, plan.keyOffset);
    writeBakedStretch(id, target);
  }
}

// ── Freeze On Last Frame ────────────────────────────────────────────────────

/**
 * AE's Freeze On Last Frame, as keyframe times: identity from the layer's
 * in-point to its last frame, then a HOLD on that frame. `span` is in frames,
 * end exclusive, so the last visible frame is `end − 1`.
 */
export function lastFrameHoldKeys(span: { start: number; end: number }, fps: number): { inSec: number; lastSec: number } {
  const lastFrame = Math.max(span.start, span.end - 1);
  return { inSec: span.start / fps, lastSec: lastFrame / fps };
}

/**
 * Enable time remapping with a hold on each layer's last frame and extend the
 * bar to the end of the composition, so the final frame holds from there on.
 */
export function freezeOnLastFrame(ids: ReadonlyArray<string>): number {
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  const compEnd = c.timeline.duration;
  const plans: Array<{ id: string; inSec: number; lastSec: number }> = [];
  const extensions: Array<{ layer: ReturnType<typeof c.getLayersForNode>[number]; prev: number; next: number }> = [];

  for (const id of ids) {
    const layers = c.getLayersForNode(id);
    if (layers.length === 0) continue;
    const first = layers[0]!;
    const last = layers[layers.length - 1]!;
    const { inSec, lastSec } = lastFrameHoldKeys({ start: first.start, end: last.start + last.duration }, fps);
    plans.push({ id, inSec, lastSec });
    const wanted = compEnd - last.clip.start;
    if (!last.locked && wanted > last.clip.duration) {
      extensions.push({ layer: last, prev: last.clip.duration, next: wanted });
    }
  }
  if (plans.length === 0) return 0;

  // Keys are written BEFORE the bar grows: the remap track lives on chain time,
  // which the bar does not move, but reading the times first keeps the plan
  // independent of the extension.
  runAnimEdit('Freeze On Last Frame', () => defaultAnimation.batch(() => {
    for (const { id, inSec, lastSec } of plans) {
      for (const prop of RETIME_PROPS) defaultAnimation.removeTrack(id, prop);
      defaultAnimation.setKeyframe(id, REMAP, compToKeyframeTime(id, inSec, REMAP), inSec, 'linear');
      defaultAnimation.setKeyframe(id, REMAP, compToKeyframeTime(id, lastSec, REMAP), lastSec, 'step');
    }
  }));

  if (extensions.length > 0) {
    const set = (pick: 'prev' | 'next'): void => {
      for (const e of extensions) {
        e.layer.clip.duration = e[pick];
        c.timeline.events.emit('LayerUpdated', { layer: e.layer, changed: 'clip' });
      }
    };
    c.timeline.history.run({ label: 'Freeze On Last Frame', do: () => set('next'), undo: () => set('prev') });
  }
  return plans.length;
}

export interface LayerTimeCommandDeps {
  /** Opens the Time Stretch dialog. Injected: core cannot import the layout layer. */
  openTimeStretch?: (ids: ReadonlyArray<string>) => void;
}

export function buildLayerTimeCommands(deps: LayerTimeCommandDeps = {}): ReadonlyArray<Command> {
  const enabled = (): boolean => timeTargets().length > 0;
  return [
    {
      id: asCommandId('time.reverseLayer'),
      label: 'Time-Reverse Layer',
      description: 'Play the selected footage backwards (toggle)',
      icon: 'clock',
      // AE's chord for Time-Reverse LAYER. It used to sit on Time-Reverse
      // Keyframes, which AE ships with no default shortcut.
      shortcut: { key: 'r', meta: true, alt: true },
      enabled,
      execute: () => toggleReverse(timeTargets()),
    },
    {
      id: asCommandId('time.freezeFrame'),
      label: 'Freeze Frame',
      description: 'Hold the selected footage on the frame under the playhead (toggle)',
      icon: 'clock',
      enabled,
      execute: () => toggleFreeze(timeTargets(), playhead()),
    },
    {
      id: asCommandId('time.freezeOnLastFrame'),
      label: 'Freeze On Last Frame',
      description: 'Time-remap the selected footage to hold its last frame to the end of the composition',
      icon: 'clock',
      enabled,
      execute: () => {
        const n = freezeOnLastFrame(timeTargets());
        if (n === 0) notify('Nothing to freeze — the selected layers have no clip on the timeline.');
      },
    },
    {
      id: asCommandId('time.timeStretch'),
      label: 'Time Stretch…',
      description: 'Stretch the selected layers, holding the in-point, out-point or current frame in place (footage changes speed; other layers stretch their keyframes)',
      icon: 'clock',
      // Every layer, as in AE — not just footage.
      enabled: () => stretchTargets().length > 0,
      execute: async () => {
        const ids = stretchTargets();
        if (ids.length === 0) return;
        if (deps.openTimeStretch) { deps.openTimeStretch(ids); return; }
        // Headless fallback (no dialog host): the old one-field prompt.
        const current = stretchValueOf(ids[0]!);
        const raw = await customPrompt('Time Stretch', 'Stretch factor (% of original duration — 200 = half speed, 50 = double speed)', String(current));
        if (raw === null) return;
        const pct = Number(raw);
        // Negative (reverse) only when no footage is selected — footage reverses with Time-Reverse Layer.
        const footage = ids.some(retimable);
        if (!Number.isFinite(pct) || pct === 0 || (footage && pct < 0)) {
          notify(footage ? 'Enter a percentage above 0.' : 'Enter a percentage other than 0.');
          return;
        }
        await applyTimeStretch(ids, pct, 'in');
      },
    },
    {
      id: asCommandId('time.enableTimeRemap'),
      label: 'Enable Time Remapping',
      description: 'Keyframe the source time of the selected footage (toggle)',
      icon: 'clock',
      enabled,
      execute: () => toggleTimeRemap(timeTargets(), playhead()),
    },
    // The two retime modes Twixtor and AE's Timewarp offer, plus the way back.
    // Switching converts what the layer had (see `retimeCommands.setRetimeMode`).
    ...([
      ['speed', 'Retime: Speed %', 'Keyframe playback speed as a percentage — ramps and velocity edits'],
      ['frames', 'Retime: Frame Number', 'Keyframe which source frame shows at each moment'],
      ['normal', 'Retime: Normal Speed', 'Remove speed and frame retiming from the selected layers'],
    ] as ReadonlyArray<[RetimeMode, string, string]>).map(([mode, label, description]) => ({
      id: asCommandId(`time.retime.${mode}`),
      label,
      description,
      icon: 'clock',
      enabled,
      execute: () => {
        if (setRetimeMode(timeTargets(), mode)) {
          notify('Converted to Speed %. The frames at your old keys are kept; check the curve between them.');
        }
      },
    })),
    ...SPEED_PRESETS.map((p) => ({
      id: asCommandId(`time.speedPreset.${p.id}`),
      label: `Speed Preset: ${p.label}`,
      description: `${p.hint} — across each selected clip`,
      icon: 'clock',
      enabled,
      execute: () => {
        if (applySpeedPreset(timeTargets(), p.id) === 0) notify('The selected layers have no clip bar to shape a preset across.');
      },
    })),
    ...([
      ['none', 'Frame Blend: Off'],
      ['mix', 'Frame Blend: Frame Mix'],
      ['pixelMotion', 'Frame Blend: Pixel Motion'],
    ] as ReadonlyArray<[FrameBlend, string]>).map(([mode, label]) => ({
      id: asCommandId(`time.frameBlend.${mode}`),
      label,
      description: 'Frame blending for slowed or stretched footage',
      icon: 'clock',
      enabled,
      execute: () => setFrameBlend(timeTargets(), mode),
    })),
  ];
}
