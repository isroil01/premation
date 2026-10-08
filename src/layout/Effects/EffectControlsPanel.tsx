/**
 * Effect Controls — the left-sidebar editor for effects already on the
 * selected layer, designed authentically after Adobe After Effects.
 *
 * Its ≡ menu carries what acts on the layer's whole STACK — Copy Stack, Paste
 * Effects, Save Stack as Preset… (2026-10). Those used to be a row of chips in
 * the Effects & Presets browser, which is the library you add FROM; they now
 * sit beside the stack they act on, as After Effects keeps them.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTreeGroups } from '@hooks/useMirror';
import { mirrorPathOps } from '@core/mirror/layerFacts';
import { jsonField } from '@core/mirror/layerFields';
import { effectClipboardSize } from '@core/effects/effectClipboard';
import { PathOpControls } from '@layout/Inspector/PathOpControls';
import { ClonerSection } from '@layout/Inspector/ClonerSection';
import { PhysicsSection } from '@layout/Inspector/PhysicsSection';
import { useDockPanelHeader } from '@components/DockPanel';
import type { DropdownItem } from '@components/Dropdown';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import { customPrompt } from '@components/Modal/Dialogs';
import { EffectStack } from './EffectStack';
import { copyEffectsEdit, pasteEffectsEdit, saveEffectPresetEdit, setLayerEffectsEnabledEdit } from './effectEdits';
import { notifyEffectPresetsChanged } from './EffectsPanel';
import styles from './EffectsPanel.module.css';

const isObject = (v: unknown): boolean => !!v && typeof v === 'object';

/** The root groups of the layer's property tree the body reads: path operators, cloner / physics records. */
const CONTROLS_ROOTS: readonly string[] = ['contents', 'layer'];

/*
  The effect clipboard is module state (effectClipboard.ts) with no change
  event, and more than this menu fills it: an effect's own Copy (its header's
  right-click, EffectStack) does too. So the menu re-reads the clipboard's
  size on the user's next gesture — a pointer press or a key, which is what
  opening the ≡ menu takes — and after its own Copy Stack lands.
  useSyncExternalStore compares the number, so a gesture that changed nothing
  renders nothing.
*/
const clipboardListeners = new Set<() => void>();
function subscribeClipboard(listener: () => void): () => void {
  clipboardListeners.add(listener);
  window.addEventListener('pointerdown', listener, true);
  window.addEventListener('keydown', listener, true);
  return () => {
    clipboardListeners.delete(listener);
    window.removeEventListener('pointerdown', listener, true);
    window.removeEventListener('keydown', listener, true);
  };
}
function clipboardChanged(): void {
  for (const listener of [...clipboardListeners]) listener();
}

/** Ask for a name, then save the layer's whole stack as an effect preset (the Effects & Presets browser lists it). */
async function saveStackAsPreset(layerId: string): Promise<void> {
  const name = await customPrompt(
    'Save Effect Preset',
    'Name this effect stack so you can apply it to other layers.',
    '',
    { placeholder: 'My preset', confirmLabel: 'Save' },
  );
  if (name?.trim() && await saveEffectPresetEdit(layerId, name.trim())) notifyEffectPresetsChanged();
}

/**
 * The ≡ rows for the stack of `layerId` (null: no layer to act on). Enabled as
 * the browser's chips were: Copy Stack and Save need an effect on the layer,
 * Paste needs a layer and something copied.
 */
export function effectStackMenuRows(layerId: string | null, effectCount: number, clipboardCount: number): DropdownItem[] {
  return [
    {
      type: 'item',
      id: 'fx-copy-stack',
      label: 'Copy Stack',
      icon: 'copy',
      disabled: !layerId || effectCount === 0,
      onSelect: () => { if (layerId) void copyEffectsEdit(layerId).then(clipboardChanged); },
    },
    {
      type: 'item',
      id: 'fx-paste',
      label: clipboardCount > 0 ? `Paste ${clipboardCount} Effect${clipboardCount === 1 ? '' : 's'}` : 'Paste Effects',
      icon: 'plus',
      disabled: !layerId || clipboardCount === 0,
      onSelect: () => { if (layerId) void pasteEffectsEdit([layerId]); },
    },
    {
      type: 'item',
      id: 'fx-save-preset',
      label: 'Save Stack as Preset…',
      icon: 'star',
      disabled: !layerId || effectCount === 0,
      onSelect: () => { if (layerId) void saveStackAsPreset(layerId); },
    },
  ];
}

/**
 * What Effect Controls lists for one layer: its applied effects, then the path
 * operators, Cloner and Physics attached from Effects ▸ Shape / Simulation.
 *
 * Shared with the Properties panel's Effects section, so the stack has ONE
 * implementation whichever surface draws it. `empty` is the host's own
 * nothing-here line.
 */
export function EffectControlsBody({ nodeId, empty }: { nodeId: string; empty: ReactNode }): JSX.Element {
  // `primary`: the layer Effect Controls is showing — the selection's, or the
  // locked one. Named so here too; clonerExpand.test follows it by that name.
  const primary = nodeId;
  // B4: the layer's header (effect count) and property tree (path operators,
  // `layer/cloner`, `layer/physics`) from the document mirror.
  // Read: the header, the path operators (`contents`) and the cloner / physics records (`layer`) — the
  // stack itself is EffectStack's. A write elsewhere (a drag of Position) must not re-render this.
  const tree = useMirrorTreeGroups(primary, CONTROLS_ROOTS);
  const m = documentMirror();
  const layer = m.layer(primary);
  const count = layer?.effectCount ?? 0;
  const hasPathOps = layer ? mirrorPathOps(tree).length > 0 : false;
  const hasCloner = layer ? isObject(jsonField(m, primary, 'layer/cloner')) : false;
  const hasPhysics = layer ? isObject(jsonField(m, primary, 'layer/physics')) : false;
  if (!layer || !(count > 0 || hasPathOps || hasCloner || hasPhysics)) return <>{empty}</>;
  return (
    <>
      {count > 0 && <EffectStack nodeId={primary} />}
      {hasPathOps && <PathOpControls nodeId={primary} />}
      {hasCloner && <ClonerSection nodeId={primary} />}
      {hasPhysics && <PhysicsSection nodeId={primary} />}
    </>
  );
}

export function EffectControlsPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.primary);

  // Lock (AE's padlock): the panel stays on the layer it was locked to while
  // the selection moves on — so an effect can be tuned while picking other
  // layers as its map/matte source. A locked layer that is deleted unlocks.
  const [lockedId, setLockedId] = useState<string | null>(null);
  // B4: layer headers from the document mirror.
  const lockedLayer = useMirrorLayer(lockedId);
  const locked = lockedId !== null && !!lockedLayer;
  const primary = locked ? lockedId : selected;
  const node = useMirrorLayer(primary);
  const target = primary && node ? primary : null;

  // Master "fx" switch: the layer's own fxEnabled flag — the same switch the
  // timeline's fx column flips — not local state that changed nothing.
  const masterFx = node?.switches.effectsEnabled ?? true;
  const setMasterFx = (on: boolean): void => {
    if (target) void setLayerEffectsEnabledEdit(target, on);
  };
  const setLocked = (on: boolean): void => setLockedId(on && selected ? selected : null);

  // ── The ≡ menu: the stack's verbs ──
  const effectCount = node?.effectCount ?? 0;
  const clipboardCount = useSyncExternalStore(subscribeClipboard, effectClipboardSize);
  // Memoised, and it has to be: the hand-off below is a state update in the
  // DockPanel, which re-renders this panel — a fresh array per render is the
  // v0.8.1 update loop (PropertiesPanel.dockMenu.native.test.tsx).
  const stackMenu = useMemo(
    () => effectStackMenuRows(target, effectCount, clipboardCount),
    [target, effectCount, clipboardCount],
  );
  const setCustomMenuItems = useDockPanelHeader()?.setCustomMenuItems;
  useEffect(() => {
    if (!setCustomMenuItems) return;
    setCustomMenuItems(stackMenu);
    return () => setCustomMenuItems([]);
  }, [setCustomMenuItems, stackMenu]);

  if (!target || !node) {
    return (
      <div className={styles.controlsRoot}>
        <p className={styles.controlsEmpty}>Select a layer to see its effects.</p>
      </div>
    );
  }

  const layerName = node.name?.trim() || `Layer: ${target}`;
  const fxLabel = masterFx ? 'Turn this layer’s effects off' : 'Turn this layer’s effects on';

  return (
    <div className={styles.controlsRoot}>
      {/* ── AE Effect Controls identity row: fx · name · lock ── */}
      <div className={styles.layerHead}>
        <IconButton
          size="sm"
          variant="ghost"
          active={masterFx}
          aria-label={fxLabel}
          aria-pressed={masterFx}
          tooltip={fxLabel}
          onClick={() => setMasterFx(!masterFx)}
        >
          <span className={masterFx ? styles.masterFx : styles.masterFxOff} aria-hidden>fx</span>
        </IconButton>
        <span className={styles.layerName} title={layerName}>{layerName}</span>
        <IconButton
          size="sm"
          variant="ghost"
          active={locked}
          aria-label={locked ? 'Unlock Effect Controls' : 'Lock Effect Controls to this layer'}
          aria-pressed={locked}
          tooltip={locked ? 'Unlock Effect Controls' : 'Lock Effect Controls to this layer'}
          onClick={() => setLocked(!locked)}
        >
          <Icon name={locked ? 'lock' : 'unlock'} size="sm" />
        </IconButton>
      </div>

      <div className={styles.controlsBody}>
        <EffectControlsBody
          nodeId={target}
          empty={<p className={styles.controlsEmpty}>No effects — add one from Effects &amp; Presets.</p>}
        />
      </div>
    </div>
  );
}

export default EffectControlsPanel;
