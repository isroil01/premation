/**
 * The native Electron menu is generated from `APP_MENU`, so it cannot drift
 * from the in-app one — and every command id it would send back to the
 * renderer is one the renderer registers.
 */

import { APP_MENU } from './menuModel';
import {
  buildNativeMenuTemplate,
  isNativeMenuActionId,
  registryLookup,
  runNativeMenuAction,
  templateCommandIds,
  toAccelerator,
  NATIVE_MENU_ACTION_PREFIX,
} from './nativeMenuTemplate';
import { getCommandRegistry } from '@core/commands/Command';
import { buildStaticCommands } from '@providers/Providers';
import { buildTimelineEditModeCommands } from '@layout/Timeline/timelineEditMode';
import { buildTimelineFitCommands } from '@layout/Timeline/timelineFitCommands';
import { buildPreviewCacheCommands } from '@layout/Timeline/previewCacheCommands';
import { buildTranscriptCommands } from '@layout/Transcript/transcriptCommands';
import { buildHelpCommands } from '@layout/Help/helpCommands';
import { buildExportPanelCommands } from '@layout/Export/exportPanelCommands';
import { buildAssetCommands } from '@layout/Assets/assetCommands';
import { buildEffectMenuCommands } from './effectMenu';
import { buildTimelineExpandCommands } from '@layout/Timeline/expandCollapse';
import { buildTimelineSnapCommands } from '@layout/Timeline/snapCommands';
import { buildViewportCommands } from '@layout/Workspace/viewportCommands';
import { buildLayerSettingsCommands } from '@layout/Composition/layerSettingsCommands';
import { buildTextToolCommands } from '@layout/Text/textToolCommands';
import { buildTextCommands } from '@layout/Inspector/textCommands';
import { buildParagraphTextCommands } from '@layout/Inspector/paragraphTextCommands';
import { buildPaintCommands } from '@layout/Paint/paintCommands';
import { registerPowerTourCommand } from '@stores/onboardingStore';
import { readSource } from '@/__testHelpers__/readSource';

describe('toAccelerator', () => {
  it('spells modifier chords the way Electron reads them', () => {
    expect(toAccelerator({ key: 's', ctrl: true }, 'other')).toBe('Ctrl+S');
    expect(toAccelerator({ key: 's', ctrl: true, shift: true }, 'other')).toBe('Ctrl+Shift+S');
    expect(toAccelerator({ key: 'F9' }, 'other')).toBe('F9');
    expect(toAccelerator({ key: 'F9', meta: true, shift: true }, 'darwin')).toBe('Cmd+Shift+F9');
    expect(toAccelerator({ key: 'ArrowUp', alt: true }, 'other')).toBe('Alt+Up');
  });

  it('spells the primary modifier CmdOrCtrl off macOS rather than dropping the chord', () => {
    // `meta` is the app's primary modifier; runtime `resolveChord` already
    // turns it into ctrl off-mac, and a raw chord must still reach the menu.
    expect(toAccelerator({ key: 's', meta: true }, 'other')).toBe('CmdOrCtrl+S');
    expect(toAccelerator({ key: 'F9', meta: true, shift: true }, 'other')).toBe('CmdOrCtrl+Shift+F9');
  });

  it('never claims a bare key or Tab', () => {
    // A native accelerator fires inside text fields; these must stay in the
    // renderer where `enabled()` can yield them.
    expect(toAccelerator({ key: 'v' }, 'other')).toBeUndefined();
    expect(toAccelerator({ key: 'Tab' }, 'other')).toBeUndefined();
    expect(toAccelerator({ key: 'Tab', shift: true }, 'other')).toBeUndefined();
  });
});

describe('buildNativeMenuTemplate over APP_MENU', () => {
  const registry = getCommandRegistry();
  beforeAll(() => {
    registry.clear();
    // Everything Providers registers at boot, plus the families whose builders
    // live beside the panel that owns them and are installed on mount.
    for (const cmd of [
      ...buildStaticCommands(),
      ...buildTimelineEditModeCommands(),
      ...buildTimelineFitCommands(),
      ...buildPreviewCacheCommands(),
      ...buildTranscriptCommands(),
      ...buildHelpCommands(),
      ...buildExportPanelCommands(),
      ...buildAssetCommands(),
      ...buildTimelineExpandCommands(),
      ...buildTimelineSnapCommands(),
      ...buildViewportCommands(),
      ...buildLayerSettingsCommands(),
      ...buildTextToolCommands(),
      ...buildTextCommands(),
      ...buildParagraphTextCommands(),
      ...buildPaintCommands(),
      // Effect ▸ <folder> ▸ <effect> — one command per registry entry.
      ...buildEffectMenuCommands(),
    ]) registry.register(cmd);
    // Registers itself rather than returning a Command — the tour's execute
    // closes over the store, so there is no build-only form of it.
    registerPowerTourCommand();
  });
  afterAll(() => registry.clear());

  const build = () =>
    buildNativeMenuTemplate(APP_MENU, {
      lookup: registryLookup(registry),
      resolveChord: (cmd) => cmd.shortcut,
      platform: 'other',
    });

  it('keeps every group and label of the in-app menu', () => {
    const template = build();
    expect(template.map((g) => g.label)).toEqual(APP_MENU.map((g) => g.label));
    const file = template.find((g) => g.id === 'file')!;
    // The label the hand-written native menu had drifted from.
    expect(file.items.map((i) => i.label)).toContain('Save As…');
    expect(file.items.map((i) => i.label)).not.toContain('Save to Computer…');
  });

  it('carries the submenu tree, not a flattened subset', () => {
    const layer = build().find((g) => g.id === 'layer')!;
    const create = layer.items.find((i) => i.label === 'New')!;
    expect(create.submenu?.some((i) => i.label === '3D Primitive' && (i.submenu?.length ?? 0) >= 8)).toBe(true);
  });

  it('names only command ids the renderer registers (or can register in another edition)', () => {
    // Registered above, named literally in Providers (edition-gated
    // registrations), or a `BuiltinCommands` constant Providers registers by
    // name (Undo/Redo are registered inline, after the static set).
    const providers = readSource('providers/Providers.tsx');
    const builtins = readSource('core/commands/Command.ts');
    const registered = new Set(registry.all().map((c) => c.id as unknown as string));
    const unknown = templateCommandIds(build())
      .filter((id) => !isNativeMenuActionId(id))
      .filter((id) => !registered.has(id) && !providers.includes(`'${id}'`) && !builtins.includes(`'${id}'`));
    expect(unknown).toEqual([]);
  });

  it('puts accelerators only on modifier / function-key chords', () => {
    const accels = new Map<string, string>();
    const walk = (items: ReadonlyArray<{ commandId?: string; accelerator?: string; submenu?: unknown[] }>): void => {
      for (const it of items) {
        if (it.commandId && it.accelerator) accels.set(it.commandId, it.accelerator);
        if (it.submenu) walk(it.submenu as typeof items);
      }
    };
    for (const g of build()) walk(g.items);
    // Raw `meta` chords (no runtime resolveChord here) spell the primary
    // modifier portably; Electron picks Ctrl on Windows/Linux.
    expect(accels.get('project.save')).toBe('CmdOrCtrl+S');
    expect(accels.get('anim.easyEase')).toBe('F9');
    // Bare-key chords must stay renderer-side, where `enabled()` can yield them
    // to a text field: ` / Shift+` (focus modes) and Tab (Mini-Flowchart).
    expect(accels.has('view.focusMode.viewportTimeline')).toBe(false);
    expect(accels.has('view.focusMode.viewport')).toBe(false);
    expect(accels.has('comp.miniFlowchart')).toBe(false);
    // A modifier, or a function key (Shift+F9 is Easy Ease In — Shift alone
    // is fine on an F-key, never on a letter).
    for (const a of accels.values()) expect(a).toMatch(/^(Ctrl|Cmd|Alt|(Shift\+)?F\d)/);
  });

  it('leaves no leading, trailing or doubled separators', () => {
    const check = (items: ReadonlyArray<{ type?: string; submenu?: unknown[] }>): void => {
      expect(items[0]?.type).not.toBe('separator');
      expect(items[items.length - 1]?.type).not.toBe('separator');
      for (let i = 1; i < items.length; i++) expect(items[i]?.type === 'separator' && items[i - 1]?.type === 'separator').toBe(false);
      for (const it of items) if (it.submenu) check(it.submenu as typeof items);
    };
    for (const g of build()) check(g.items);
  });
});

describe('menu.action ids for onSelect-only entries', () => {
  it('round-trips a path id back to the entry’s onSelect', () => {
    const onSelect = jest.fn();
    const groups = [{
      id: 'window',
      label: 'Window',
      items: [
        { commandId: 'x.first' },
        { separator: true },
        { label: 'Workspace', children: () => [{ label: 'Mine', onSelect, checked: () => true }] },
      ],
    }];
    const template = buildNativeMenuTemplate(groups, { lookup: () => undefined, resolveChord: () => undefined, platform: 'other' });
    const ws = template[0]!.items[2]!;
    const mine = ws.submenu![0]!;
    expect(mine.commandId).toBe(`${NATIVE_MENU_ACTION_PREFIX}window/2/0`);
    expect(mine.checked).toBe(true);
    expect(runNativeMenuAction(groups, mine.commandId!)).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(runNativeMenuAction(groups, `${NATIVE_MENU_ACTION_PREFIX}window/9/0`)).toBe(false);
    expect(runNativeMenuAction(groups, 'x.first')).toBe(false);
  });
});
