/**
 * The Effect menu — every effect, filed the way After Effects files them.
 *
 * It used to be eight hand-picked rows (Fast Box Blur … Sepia) over a registry
 * of two hundred: the menu a user opens to find out what effects EXIST listed
 * 4% of them. Now it is generated from `EFFECT_DEFS`, one submenu per browser
 * folder (`EFFECT_CATEGORY`, the same names the Effects panel shows), sorted by
 * name inside each — so a new effect is on the menu the moment it is filed in
 * a category, which the type system already forces.
 *
 * COMMANDS, not `onSelect` rows. Each built-in effect gets `effect.add.<type>`:
 * the registry then supplies what it supplies everywhere else — the greyed-out
 * state with nothing selected, a user-assignable shortcut in Customize, the
 * native (Alt / macOS) menu for free — and the translation key derives from
 * the command id like every other item's (`menu.effect.add.<type>`), so it
 * survives a rewording. Plugin effects are user data: they arrive after the
 * build, have no registration to point at, and follow the runtime-entry rule
 * (an `onSelect`, never translated), exactly as saved workspaces do.
 *
 * Applies to EVERY selected layer as one undo step — AE's rule, and the rule
 * Quick Apply and the panel's Add Effect menu already follow.
 *
 * The menu cap (`menuSubmenus.test.ts`, 14 top-level entries) is why the
 * folders are submenus rather than ruled sections: ten folders fit; two
 * hundred rows do not.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { EFFECT_DEFS, addEffect, type EffectDef, type EffectType } from '@core/effects/effects';
import { pluginEffectDefs, PLUGIN_EFFECT_CATEGORY } from '@core/effects/pluginEffectDefs';
import { EFFECT_CATEGORY, EFFECT_CATEGORY_ORDER } from '@layout/Effects/effectCategory';
import { revealEffectsInProperties } from '@layout/Effects/revealEffectControls';
import { batchHistory } from '@stores/historyStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { MenuItemModel } from './menuModel';

export function effectCommandId(type: string): string {
  return `effect.add.${type}`;
}

/** `menu.sub.effect.<slug>` — a submenu parent's key is explicit (see `menuI18n.ts`). */
const CATEGORY_LABEL_KEY: Record<string, string> = {
  'Blur & Sharpen': 'menu.sub.effect.blurSharpen',
  'Color Correction': 'menu.sub.effect.colorCorrection',
  Stylize: 'menu.sub.effect.stylize',
  Generate: 'menu.sub.effect.generate',
  Distort: 'menu.sub.effect.distort',
  Perspective: 'menu.sub.effect.perspective',
  Channel: 'menu.sub.effect.channel',
  Keying: 'menu.sub.effect.keying',
  Time: 'menu.sub.effect.time',
  Transition: 'menu.sub.effect.transition',
};

function byLabel(a: EffectDef, b: EffectDef): number {
  return a.label.localeCompare(b.label, 'en');
}

/** Add `type` to every selected layer: one undo step, then show its controls. */
export function applyEffectToSelection(type: EffectType, label: string): void {
  const ids = [...useSelectionStore.getState().ids];
  if (ids.length === 0) return;
  batchHistory(`fx:add:${type}`, () => {
    for (const id of ids) addEffect(id, type);
  });
  revealEffectsInProperties();
  useUIStore.getState().notify({
    level: 'success',
    message: ids.length === 1 ? `Added ${label}` : `Added ${label} to ${ids.length} layers`,
    durationMs: 2400,
  });
}

const hasSelection = (): boolean => useSelectionStore.getState().ids.length > 0;

/** One command per built-in effect. */
export function buildEffectMenuCommands(): Command[] {
  return EFFECT_DEFS.map((d) => ({
    id: asCommandId(effectCommandId(d.type)),
    label: `Effect: ${d.label}`,
    description: `Add ${d.label} (${EFFECT_CATEGORY[d.type]}) to the selected layers.`,
    icon: 'sparkles',
    enabled: hasSelection,
    execute: () => applyEffectToSelection(d.type, d.label),
  }));
}

/** The Effect group's items: a submenu per folder, then installed plugins' effects. */
export function buildEffectMenuItems(): MenuItemModel[] {
  const byCategory = new Map<string, EffectDef[]>();
  for (const d of EFFECT_DEFS) {
    const cat = EFFECT_CATEGORY[d.type];
    const list = byCategory.get(cat);
    if (list) list.push(d);
    else byCategory.set(cat, [d]);
  }
  const items: MenuItemModel[] = [];
  for (const cat of EFFECT_CATEGORY_ORDER) {
    const defs = byCategory.get(cat);
    if (!defs || defs.length === 0) continue;
    items.push({
      label: cat,
      labelKey: CATEGORY_LABEL_KEY[cat],
      children: [...defs].sort(byLabel).map((d) => ({ commandId: effectCommandId(d.type), label: d.label })),
    });
  }
  items.push(
    { separator: true, visible: () => pluginEffectDefs().length > 0 },
    {
      label: PLUGIN_EFFECT_CATEGORY,
      labelKey: 'menu.sub.effect.plugins',
      // Hidden until something is installed — an empty folder is a dead end.
      visible: () => pluginEffectDefs().length > 0,
      // A thunk: plugins start, stop and crash while the app runs.
      children: () =>
        [...pluginEffectDefs()].sort(byLabel).map((d) => ({
          label: d.label,
          onSelect: () => applyEffectToSelection(d.type as EffectType, d.label),
        })),
    },
  );
  return items;
}

let installed = false;

/** Idempotent. Called from `installOverlayCommands` — once per editor window. */
export function installEffectMenuCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildEffectMenuCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam. */
export function resetEffectMenuCommandsForTest(): void {
  installed = false;
}
