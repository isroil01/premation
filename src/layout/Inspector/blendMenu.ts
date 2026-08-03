/**
 * The blend-mode picker menu, built once for every surface that shows one.
 *
 * `BLEND_MODES` carries a `group` per mode, documented as "load bearing for the
 * picker's section headers" and ordered to match AE's own menu. Nothing read it.
 * Both pickers — the inspector's Compositing section and the timeline's Mode
 * column — flat-mapped the table and dropped the grouping on the floor, so a
 * contract with a stated purpose had zero enforcement and zero readers, and the
 * AE ordering it exists to preserve was invisible to the user.
 *
 * Building the menu in one place fixes both halves: the headers appear, and the
 * two pickers can no longer drift from each other.
 */

import type { DropdownItem } from '@components/Dropdown';
import { BLEND_MODES, type LayerBlendMode } from '@core/effects/blendMode';

/**
 * `BLEND_MODES` bucketed into contiguous runs of the same group, in table
 * order. Runs, not a keyed map: the table's order IS the menu's order, and
 * bucketing by key would silently reorder the sections.
 */
export function blendModeSections(): Array<{ group: string; modes: LayerBlendMode[] }> {
  const out: Array<{ group: string; modes: LayerBlendMode[] }> = [];
  for (const { mode, group } of BLEND_MODES) {
    const last = out[out.length - 1];
    if (last && last.group === group) last.modes.push(mode);
    else out.push({ group, modes: [mode] });
  }
  return out;
}

/** Label for a mode, falling back the way both pickers already did. */
export function blendModeLabel(mode: LayerBlendMode | undefined): string {
  return BLEND_MODES.find((b) => b.mode === mode)?.label ?? 'Normal';
}

/**
 * Dropdown items for the blend picker, with an AE section header above each
 * group. `Normal` is its own group of one, so it gets no header — a heading
 * over a single item reads as noise rather than structure.
 */
export function blendDropdownItems(
  current: LayerBlendMode | undefined,
  onPick: (mode: LayerBlendMode) => void,
): DropdownItem[] {
  const items: DropdownItem[] = [];
  for (const section of blendModeSections()) {
    if (section.modes.length > 1) items.push({ type: 'label', label: section.group });
    for (const mode of section.modes) {
      items.push({
        type: 'item',
        id: mode,
        label: blendModeLabel(mode),
        icon: mode === current ? 'check' : undefined,
        onSelect: () => onPick(mode),
      });
    }
  }
  return items;
}
