/**
 * Layer ▸ Time commands (Time-Reverse Layer, Freeze Frame, Freeze On Last
 * Frame, Time Stretch…, Enable Time Remapping, the retime modes, the speed
 * presets, Frame Blend) over the engine (B4 round 7).
 *
 * Targets and state come off the document mirror (`LayerInfo.kind`,
 * `LayerInfo.timing`: stretch sign, freeze, time remap, retime mode); every
 * action is ONE engine batch of the layer-time commands (`timeReverseLayers`,
 * `freezeFrame` / `unfreezeLayers`, `setTimeRemap`, `setRetime`,
 * `timeStretchLayers`, `setLayerSwitches {frameBlend}`), or the speed preset's
 * keyframe commands (`retimeEdits.speedPresetCommands`).
 */

import { asCommandId } from '@app-types/common';
import type { Command as EngineCommand, FrameBlend, LayerInfo } from '@motion/engine-api';
import type { Command } from '@core/commands/Command';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { SPEED_PRESETS } from '@core/animation/retimeCommands';
import { customPrompt } from '@components/Modal';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { speedPresetCommands } from '@layout/Inspector/retimeEdits';

function layerOf(id: string): LayerInfo | undefined {
  return documentMirror().layer(id);
}

/** Layers whose source has a time axis to retime: footage, audio, precomps. */
export function isRetimable(id: string): boolean {
  const k = layerOf(id)?.kind;
  return k === 'video' || k === 'audio' || k === 'precomp';
}

/** Reverse, Freeze, Time Remap, retime and Frame Blend: footage-like layers only. */
export function timeTargets(): string[] {
  return useSelectionStore.getState().ids.filter(isRetimable);
}

/** Time Stretch: every selected layer, as in After Effects. */
export function stretchTargets(): string[] {
  return useSelectionStore.getState().ids.filter((id) => layerOf(id) !== undefined);
}

function notify(message: string): void {
  useUIStore.getState().notify({ level: 'info', message, durationMs: 3500 });
}

/** Reverse every forward target when any is forward, else un-reverse them all. One entry. */
export function toggleReverseEdit(ids: ReadonlyArray<string>): Promise<unknown> {
  const forward = ids.filter((id) => (layerOf(id)?.timing.stretch ?? 1) >= 0);
  const flip = forward.length > 0 ? forward : [...ids];
  return flip.length > 0 ? edit('Time-Reverse Layer', { type: 'timeReverseLayers', layers: flip }) : Promise.resolve();
}

/** Freeze every live target on the frame at `seconds`, or unfreeze them all when none is live. One entry. */
export function toggleFreezeEdit(ids: ReadonlyArray<string>, seconds: number): Promise<unknown> {
  const live = ids.filter((id) => layerOf(id)?.timing.freeze === undefined);
  if (live.length === 0) return ids.length > 0 ? edit('Unfreeze Frame', { type: 'unfreezeLayers', layers: [...ids] } as EngineCommand) : Promise.resolve();
  return edit('Freeze Frame', live.map((layer): EngineCommand => ({ type: 'freezeFrame', layer, time: compTime(seconds), lastFrame: false })));
}

/** Time remap on for every target without it (when any lacks it), else off for all. One entry. */
export function toggleTimeRemapEdit(ids: ReadonlyArray<string>): Promise<unknown> {
  const off = ids.filter((id) => layerOf(id)?.timing.timeRemapEnabled !== true);
  const enable = off.length > 0;
  const cmds = (enable ? off : [...ids]).map((layer): EngineCommand => ({ type: 'setTimeRemap', layer, enabled: enable }));
  return cmds.length > 0 ? edit(enable ? 'Enable Time Remap' : 'Remove Time Remap', cmds) : Promise.resolve();
}

const API_BLEND: Readonly<Record<'none' | 'mix' | 'pixelMotion', FrameBlend>> = { none: 'off', mix: 'frameMix', pixelMotion: 'pixelMotion' };

export interface LayerTimeCommandDeps {
  /** Opens the Time Stretch dialog (the layout layer's). */
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
      // AE's chord for Time-Reverse LAYER (Time-Reverse Keyframes has none).
      shortcut: { key: 'r', meta: true, alt: true },
      enabled,
      execute: () => { void toggleReverseEdit(timeTargets()); },
    },
    {
      id: asCommandId('time.freezeFrame'),
      label: 'Freeze Frame',
      description: 'Hold the selected footage on the frame under the playhead (toggle)',
      icon: 'clock',
      enabled,
      execute: () => { void toggleFreezeEdit(timeTargets(), getTime()); },
    },
    {
      id: asCommandId('time.freezeOnLastFrame'),
      label: 'Freeze On Last Frame',
      description: 'Time-remap the selected footage to hold its last frame to the end of the composition',
      icon: 'clock',
      enabled,
      execute: () => {
        const ids = timeTargets();
        if (ids.length === 0) return;
        void edit('Freeze On Last Frame', ids.map((layer): EngineCommand => ({ type: 'freezeFrame', layer, lastFrame: true })));
      },
    },
    {
      id: asCommandId('time.timeStretch'),
      label: 'Time Stretch…',
      description: 'Stretch the selected layers, holding the in-point, out-point or current frame in place (footage changes speed; other layers stretch their keyframes)',
      icon: 'clock',
      enabled: () => stretchTargets().length > 0,
      execute: async () => {
        const ids = stretchTargets();
        if (ids.length === 0) return;
        if (deps.openTimeStretch) { deps.openTimeStretch(ids); return; }
        // Headless (no dialog host): the one-field prompt.
        const t = layerOf(ids[0]!)?.timing;
        const current = Math.round(((t?.bakedStretch ?? t?.stretch) ?? 1) * 100);
        const raw = await customPrompt('Time Stretch', 'Stretch factor (% of original duration — 200 = half speed, 50 = double speed)', String(current));
        if (raw === null) return;
        const pct = Number(raw);
        const footage = ids.some(isRetimable);
        if (!Number.isFinite(pct) || pct === 0 || (footage && pct < 0)) {
          notify(footage ? 'Enter a percentage above 0.' : 'Enter a percentage other than 0.');
          return;
        }
        await edit('Time Stretch', { type: 'timeStretchLayers', layers: ids, stretch: pct / 100, hold: 'inPoint' });
      },
    },
    {
      id: asCommandId('time.enableTimeRemap'),
      label: 'Enable Time Remapping',
      description: 'Keyframe the source time of the selected footage (toggle)',
      icon: 'clock',
      enabled,
      execute: () => { void toggleTimeRemapEdit(timeTargets()); },
    },
    ...([
      ['speed', 'Retime: Speed %', 'Keyframe playback speed as a percentage — ramps and velocity edits'],
      ['frames', 'Retime: Frame Number', 'Keyframe which source frame shows at each moment'],
      ['normal', 'Retime: Normal Speed', 'Remove speed and frame retiming from the selected layers'],
    ] as ReadonlyArray<['speed' | 'frames' | 'normal', string, string]>).map(([mode, label, description]) => ({
      id: asCommandId(`time.retime.${mode}`),
      label,
      description,
      icon: 'clock',
      enabled,
      execute: () => {
        const ids = timeTargets();
        if (ids.length === 0) return;
        const converted = mode === 'speed' && ids.some((id) => layerOf(id)?.timing.retime === 'frames');
        void edit(label, ids.map((layer): EngineCommand => ({ type: 'setRetime', layer, mode }))).then((r) => {
          if (r.ok && converted) notify('Converted to Speed %. The frames at your old keys are kept; check the curve between them.');
        });
      },
    })),
    ...SPEED_PRESETS.map((p) => ({
      id: asCommandId(`time.speedPreset.${p.id}`),
      label: `Speed Preset: ${p.label}`,
      description: `${p.hint} — across each selected clip`,
      icon: 'clock',
      enabled,
      execute: () => {
        const plans = timeTargets().map((id) => speedPresetCommands(id, p.id)).filter((x) => x !== null);
        if (plans.length === 0) {
          notify('The selected layers have no clip bar to shape a preset across.');
          return;
        }
        void edit(plans[0]!.label, plans.flatMap((x) => x.commands));
      },
    })),
    ...([
      ['none', 'Frame Blend: Off'],
      ['mix', 'Frame Blend: Frame Mix'],
      ['pixelMotion', 'Frame Blend: Pixel Motion'],
    ] as ReadonlyArray<['none' | 'mix' | 'pixelMotion', string]>).map(([mode, label]) => ({
      id: asCommandId(`time.frameBlend.${mode}`),
      label,
      description: 'Frame blending for slowed or stretched footage',
      icon: 'clock',
      enabled,
      execute: () => {
        const ids = timeTargets();
        if (ids.length > 0) void edit('Frame Blending', { type: 'setLayerSwitches', layers: ids, patch: { frameBlend: API_BLEND[mode] } });
      },
    })),
  ];
}
