/**
 * Layer ▸ Transform commands that had no command at all: Reset, Flip
 * Horizontal / Vertical, Auto-Orient…, and AE's numpad nudges (Numpad +/-
 * rotate, Alt+Numpad +/- scale, Shift for ×10).
 *
 * The numpad chords are `Numpad+` / `Numpad-` — `chordFromEvent` names the
 * numpad keys by `code`, so the main keyboard's + and - (timeline and viewport
 * zoom) are different chords and keep working.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { activeCompSize } from '@core/scene/activeComp';
import {
  flipLayersEdit,
  nudgeRotationEdit,
  nudgeScaleEdit,
  numpadStep,
} from '@core/scene/layerTransformOps';

export interface LayerTransformCommandDeps {
  /** Opens the Auto-Orient dialog. Injected: core cannot import the layout layer. */
  openAutoOrient?: (ids: ReadonlyArray<string>) => void;
  /**
   * Reset Transform through the engine — the timeline's own Reset
   * (layout/Timeline/resetEdits.ts `resetTransformEdit`). Injected for the
   * same reason.
   */
  resetTransform?: (ids: ReadonlyArray<string>, comp: { width: number; height: number }) => Promise<void>;
}

const hasSelection = (): boolean => useSelectionStore.getState().ids.length > 0;
const selection = (): string[] => [...useSelectionStore.getState().ids];

export function buildLayerTransformCommands(deps: LayerTransformCommandDeps = {}): ReadonlyArray<Command> {
  const numpad: Command[] = [];
  for (const shift of [false, true]) {
    for (const direction of [1, -1] as const) {
      const key = direction > 0 ? 'Numpad+' : 'Numpad-';
      const step = numpadStep(direction, shift);
      const suffix = `${direction > 0 ? 'Plus' : 'Minus'}${shift ? '10' : '1'}`;
      numpad.push({
        id: asCommandId(`layer.numpadRotate${suffix}`),
        label: `Rotate ${step > 0 ? '+' : ''}${step}°`,
        description: 'Rotate the selected layers (AE: Numpad +/-, Shift ×10)',
        icon: 'rotate-cw',
        shortcut: { key, ...(shift ? { shift: true } : {}) },
        enabled: hasSelection,
        execute: () => { void nudgeRotationEdit(selection(), step); },
      });
      numpad.push({
        id: asCommandId(`layer.numpadScale${suffix}`),
        label: `Scale ${step > 0 ? '+' : ''}${step}%`,
        description: 'Scale the selected layers (AE: Alt+Numpad +/-, Shift ×10)',
        icon: 'maximize',
        shortcut: { key, alt: true, ...(shift ? { shift: true } : {}) },
        enabled: hasSelection,
        execute: () => { void nudgeScaleEdit(selection(), step); },
      });
    }
  }

  return [
    {
      id: asCommandId('layer.resetTransform'),
      label: 'Reset Transform',
      description: 'Anchor, position, scale, rotation and opacity back to their defaults; removes their keyframes',
      icon: 'undo',
      enabled: hasSelection,
      execute: () => {
        if (deps.resetTransform) void deps.resetTransform(selection(), activeCompSize());
        else useUIStore.getState().notify({ level: 'info', message: 'Reset Transform needs the editor UI.', durationMs: 3000 });
      },
    },
    {
      id: asCommandId('layer.flipHorizontal'),
      label: 'Flip Horizontal',
      description: 'Mirror the selected layers around their anchor point (keyframes included)',
      icon: 'scale',
      enabled: hasSelection,
      execute: () => { void flipLayersEdit(selection(), 'horizontal'); },
    },
    {
      id: asCommandId('layer.flipVertical'),
      label: 'Flip Vertical',
      description: 'Mirror the selected layers vertically around their anchor point (keyframes included)',
      icon: 'scale',
      enabled: hasSelection,
      execute: () => { void flipLayersEdit(selection(), 'vertical'); },
    },
    {
      id: asCommandId('layer.autoOrient'),
      label: 'Auto-Orient…',
      description: 'Off, Orient Along Path, or Orient Towards Camera',
      icon: 'rotate',
      shortcut: { key: 'o', meta: true, alt: true },
      enabled: hasSelection,
      execute: () => {
        const ids = selection();
        if (deps.openAutoOrient) deps.openAutoOrient(ids);
        else useUIStore.getState().notify({ level: 'info', message: 'Auto-Orient needs the editor UI.', durationMs: 3000 });
      },
    },
    ...numpad,
  ];
}
