/**
 * Layer ▸ Mask (AE parity 5.4): New Mask, the Mode submenu, Inverted, Remove
 * Mask / Remove All Masks, Smart Mask Interpolation… and Track Mask…, over the
 * engine. They act on every mask of the selected layers (AE acts on the masks
 * selected in the timeline; a layer's mask list here is its selection). Each
 * menu action is ONE engine entry; Smart Mask Interpolation and Track Mask
 * open where their controls live (Properties ▸ Masks / ▸ Track Motion).
 */

import { asCommandId } from '@app-types/common';
import type { Command as EngineCommand } from '@motion/engine-api';
import type { Command } from '@core/commands/Command';
import { secondsToFlicks } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { paths, ref, values } from '@core/engine/propRefs';
import { rectangleMask, type MaskMode } from '@core/effects/mask';
import { maskToBezier } from '@core/engine/props';
import { mirrorMasksAt } from '@core/mirror/masks';
import { uiKindOf } from '@core/mirror/layerKinds';
import { SIZE } from '@core/scene/layerKindSize';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useLayoutStore } from '@stores/layoutStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { hasMasksSection } from '@layout/Inspector/MasksSection';

export const MASK_MODE_ITEMS: ReadonlyArray<{ mode: MaskMode; label: string }> = [
  { mode: 'none', label: 'None' },
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
  { mode: 'lighten', label: 'Lighten' },
  { mode: 'darken', label: 'Darken' },
  { mode: 'difference', label: 'Difference' },
];

/** The selected layers that can carry masks. */
export function maskLayers(): string[] {
  return useSelectionStore.getState().ids.filter((id) => hasMasksSection(id));
}

/** Every mask of the selected layers at the playhead: [layer, maskId]. */
export function selectedMasks(): Array<{ layer: string; mask: string; inverted: boolean }> {
  const m = documentMirror();
  const t = secondsToFlicks(getTime());
  return maskLayers().flatMap((layer) => mirrorMasksAt(m, layer, t).map((mk) => ({ layer, mask: mk.id, inverted: !!mk.inverted })));
}

/** Open a Properties section by its id (persisted open state), then the panel. */
function revealSection(id: string): void {
  const prefs = usePreferenceStore.getState();
  prefs.set('inspectorSections', { ...prefs.inspectorSections, [id]: true });
  useLayoutStore.getState().openPanel('properties');
}

export function buildMaskCommands(): ReadonlyArray<Command> {
  const hasLayer = (): boolean => maskLayers().length > 0;
  const hasMask = (): boolean => selectedMasks().length > 0;
  const modeCmds: Command[] = MASK_MODE_ITEMS.map(({ mode, label }) => ({
    id: asCommandId(`mask.mode.${mode}`),
    label: `Mask Mode: ${label}`,
    description: `Set every mask of the selected layers to ${label}`,
    icon: 'mask-square',
    enabled: hasMask,
    execute: () => {
      const cmds: EngineCommand[] = selectedMasks().map(({ layer, mask }) => ({
        type: 'setProperty', prop: ref(layer, paths.mask(mask, 'mode')), value: values.choice(mode),
      }));
      if (cmds.length > 0) void edit('Mask Mode', cmds);
    },
  }));
  return [
    {
      id: asCommandId('mask.new'),
      label: 'New Mask',
      description: 'A rectangle mask the size of each selected layer (AE: Layer ▸ Mask ▸ New Mask)',
      icon: 'mask-square',
      shortcut: { key: 'n', meta: true, shift: true },
      enabled: hasLayer,
      execute: () => {
        const cmds: EngineCommand[] = maskLayers().map((layer) => {
          const kind = uiKindOf(documentMirror().layer(layer)) ?? 'shape';
          const k = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
          const mask = rectangleMask(SIZE[k].w, SIZE[k].h);
          return { type: 'addMask', layer, path: maskToBezier(mask), mode: mask.mode, inverted: false };
        });
        if (cmds.length > 0) void edit('New Mask', cmds);
      },
    },
    ...modeCmds,
    {
      id: asCommandId('mask.invert'),
      label: 'Inverted',
      description: 'Invert every mask of the selected layers (toggle)',
      icon: 'mask-square',
      shortcut: { key: 'i', meta: true, shift: true },
      enabled: hasMask,
      execute: () => {
        const masks = selectedMasks();
        // All inverted → un-invert; otherwise invert them all (one direction per action).
        const to = !masks.every((x) => x.inverted);
        const cmds: EngineCommand[] = masks.map(({ layer, mask }) => ({
          type: 'setProperty', prop: ref(layer, paths.mask(mask, 'inverted')), value: values.bool(to),
        }));
        if (cmds.length > 0) void edit(to ? 'Invert Mask' : 'Uninvert Mask', cmds);
      },
    },
    {
      id: asCommandId('mask.removeAll'),
      label: 'Remove All Masks',
      description: 'Delete every mask of the selected layers',
      icon: 'trash',
      enabled: hasMask,
      execute: () => {
        const groups = selectedMasks().map(({ layer, mask }) => ref(layer, paths.maskGroup(mask)));
        if (groups.length > 0) void edit('Remove All Masks', { type: 'removePropertyGroups', groups });
      },
    },
    {
      id: asCommandId('mask.removeLast'),
      label: 'Remove Mask',
      description: 'Delete the last mask of each selected layer',
      icon: 'trash',
      enabled: hasMask,
      execute: () => {
        const m = documentMirror();
        const t = secondsToFlicks(getTime());
        const groups = maskLayers().flatMap((layer) => {
          const ms = mirrorMasksAt(m, layer, t);
          const last = ms[ms.length - 1];
          return last ? [ref(layer, paths.maskGroup(last.id))] : [];
        });
        if (groups.length > 0) void edit('Remove Mask', { type: 'removePropertyGroups', groups });
      },
    },
    {
      id: asCommandId('mask.smartInterpolation'),
      label: 'Smart Mask Interpolation…',
      description: 'In-between mask shapes between two mask path keyframes (Properties ▸ Masks)',
      icon: 'keyframe',
      enabled: hasMask,
      execute: () => revealSection('masks'),
    },
    {
      id: asCommandId('mask.track'),
      label: 'Track Mask…',
      description: 'Track the selected layer’s masks through the footage (Properties ▸ Track Motion, Track mask)',
      icon: 'crosshair',
      enabled: hasMask,
      execute: () => revealSection('trackMotion'),
    },
  ];
}
