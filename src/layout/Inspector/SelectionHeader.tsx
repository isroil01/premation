/**
 * SelectionHeader — the first row of the Properties panel: WHAT is selected.
 *
 *   [● label] [kind] Layer name  …………………  Shape layer
 *   [● label] [≡]    3 layers    …………………  2 shapes, 1 text
 *
 * Double-click the name (or focus it and press Enter / F2) to rename. Enter
 * commits, Escape cancels, and the rename goes through `renameLayer`, which
 * follows it through every expression that named the layer in ONE undo entry.
 *
 * ## Why the switches left (2026-09-15)
 *
 * This row used to carry six icon switches (visible, solo, lock, 3D, motion
 * blur, adjustment) and was portalled into the dock header, where together
 * with search and ⋯ they squeezed the panel's title to "PR…": nine unlabelled
 * glyphs duplicating the timeline's own switch columns. The header's job is
 * identity — a readable name and what kind of layer it is.
 *
 * The switches did not go away. `LAYER_SWITCHES`, `applyLayerSwitch` and
 * `layerSwitchMenuItems` are exported and the Properties ⋯ menu lists them as
 * labelled checkboxes, with the same all / none / mixed rule and the same
 * one-undo write across every selected layer.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { batchHistory } from '@stores/historyStore';
import { useUIStore } from '@stores/uiStore';
import { KIND_ICON, readNodeKind } from '@core/scene/sceneDerive';
import { renameLayer } from '@core/scene/renameLayer';
import { findLayerKind } from '@core/plugins/layerKindRegistry';
import { LABEL_COLORS, getNodeLabelColor, setNodeLabelColor } from '@core/scene/labelColor';
import { canBe3D, is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import { getNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { getNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import { enableLayerMotionBlurWithFeedback, disableLayerMotionBlur, setAdjustmentWithFeedback } from '@core/effects/layerSwitchFeedback';
import { useNodesRevision } from '@hooks/useNodeRevision';
import styles from './SelectionHeader.module.css';

// ── Layer switches ─────────────────────────────────────────────────

export type LayerSwitchState = 'all' | 'none' | 'mixed';

export interface LayerSwitchSpec {
  id: string;
  icon: IconName;
  label: string;
  applies: (id: string) => boolean;
  read: (id: string) => boolean;
  write: (id: string, on: boolean) => void;
}

function isRenderable(id: string): boolean {
  const n = defaultSceneGraph.getNode(id);
  if (!n) return false;
  const kind = readNodeKind(n);
  return kind !== 'camera' && kind !== 'light' && kind !== 'audio';
}

export const LAYER_SWITCHES: ReadonlyArray<LayerSwitchSpec> = [
  {
    id: 'visible', icon: 'eye', label: 'Visible',
    applies: () => true,
    read: (id) => defaultSceneGraph.getNode(id)?.visible !== false,
    write: (id, on) => { const n = defaultSceneGraph.getNode(id); if (n) n.visible = on; },
  },
  {
    id: 'solo', icon: 'circle', label: 'Solo',
    applies: () => true,
    read: (id) => defaultSceneGraph.getNode(id)?.solo === true,
    write: (id, on) => { const n = defaultSceneGraph.getNode(id); if (n) n.solo = on; },
  },
  {
    id: 'locked', icon: 'lock', label: 'Lock',
    applies: () => true,
    read: (id) => defaultSceneGraph.getNode(id)?.locked === true,
    write: (id, on) => { const n = defaultSceneGraph.getNode(id); if (n) n.locked = on; },
  },
  {
    id: '3d', icon: '3d', label: '3D layer',
    applies: (id) => { const n = defaultSceneGraph.getNode(id); return !!n && canBe3D(n); },
    read: (id) => { const n = defaultSceneGraph.getNode(id); return !!n && is3DEnabled(n); },
    write: (id, on) => set3DEnabled(id, on),
  },
  {
    id: 'motionBlur', icon: 'motion-blur', label: 'Motion blur',
    applies: isRenderable,
    read: (id) => getNodeMotionBlur(id),
    write: (id, on) => { if (on) enableLayerMotionBlurWithFeedback(id, setNodeMotionBlur); else disableLayerMotionBlur(id, setNodeMotionBlur); },
  },
  {
    id: 'adjustment', icon: 'adjustment', label: 'Adjustment layer',
    applies: isRenderable,
    read: (id) => getNodeAdjustment(id),
    write: (id, on) => setAdjustmentWithFeedback(id, on, setNodeAdjustment),
  },
];

/** The selected layers this switch can be set on — live nodes only. */
function switchTargets(nodeIds: ReadonlyArray<string>, t: LayerSwitchSpec): string[] {
  return nodeIds.filter((id) => !!defaultSceneGraph.getNode(id) && t.applies(id));
}

/** All / none / mixed over the layers the switch applies to. */
export function layerSwitchState(nodeIds: ReadonlyArray<string>, t: LayerSwitchSpec): LayerSwitchState {
  const targets = switchTargets(nodeIds, t);
  const on = targets.filter((id) => t.read(id)).length;
  if (targets.length === 0 || on === 0) return 'none';
  return on === targets.length ? 'all' : 'mixed';
}

/**
 * Flip a switch for the whole selection: all on → all off, otherwise (none or
 * mixed) → all on. ONE undo entry however many layers it writes.
 */
export function applyLayerSwitch(nodeIds: ReadonlyArray<string>, t: LayerSwitchSpec): void {
  const targets = switchTargets(nodeIds, t);
  if (targets.length === 0) return;
  const next = layerSwitchState(targets, t) !== 'all';
  batchHistory(`switch:${t.id}:${targets.join(',')}`, () => {
    for (const id of targets) t.write(id, next);
    bumpScene();
  });
}

/** The switches that apply to at least one selected layer, in display order. */
function applicableSwitches(nodeIds: ReadonlyArray<string>): LayerSwitchSpec[] {
  return LAYER_SWITCHES.filter((t) => switchTargets(nodeIds, t).length > 0);
}

/**
 * Everything the switch menu rows are derived from, as one string. A menu
 * memoised on this changes identity only when a row would actually change —
 * which is what keeps the dock-header hand-off from looping (v0.8.1).
 */
export function layerSwitchSignature(nodeIds: ReadonlyArray<string>): string {
  return applicableSwitches(nodeIds).map((t) => `${t.id}:${layerSwitchState(nodeIds, t)}`).join('|');
}

/**
 * The switches as ⋯-menu checkbox rows. Checked when every layer it applies to
 * is on; a mixed switch shows unchecked, and choosing it turns all of them on.
 */
export function layerSwitchMenuItems(nodeIds: ReadonlyArray<string>): DropdownItem[] {
  return applicableSwitches(nodeIds).map((t): DropdownItem => ({
    type: 'checkbox',
    id: `switch-${t.id}`,
    label: t.label,
    checked: layerSwitchState(nodeIds, t) === 'all',
    onChange: () => applyLayerSwitch(nodeIds, t),
  }));
}

// ── Identity ───────────────────────────────────────────────────────

/** What a single layer is called, in the header's muted right-hand text. */
const KIND_NOUN: Readonly<Record<string, string>> = {
  shape: 'Shape layer',
  text: 'Text layer',
  image: 'Image layer',
  video: 'Video layer',
  svg: 'SVG layer',
  audio: 'Audio layer',
  camera: 'Camera',
  light: 'Light',
  group: 'Group',
  null: 'Null object',
  adjustment: 'Adjustment layer',
  particle: 'Particle layer',
  comp: 'Composition layer',
};

/** [one, many] for the multi-selection breakdown — "2 shapes, 1 text". */
const KIND_COUNT: Readonly<Record<string, readonly [string, string]>> = {
  shape: ['shape', 'shapes'],
  text: ['text', 'text'],
  image: ['image', 'images'],
  video: ['video', 'videos'],
  svg: ['SVG', 'SVGs'],
  audio: ['audio', 'audio'],
  camera: ['camera', 'cameras'],
  light: ['light', 'lights'],
  group: ['group', 'groups'],
  null: ['null', 'nulls'],
  adjustment: ['adjustment', 'adjustments'],
  particle: ['particle layer', 'particle layers'],
  comp: ['comp', 'comps'],
};

function kindNoun(kind: string): string {
  return KIND_NOUN[kind] ?? findLayerKind(kind)?.kind.label ?? 'Layer';
}

function kindIcon(kind: string): IconName {
  return ((KIND_ICON as Record<string, string>)[kind] ?? 'plugin') as IconName;
}

/** "2 shapes, 1 text", kinds in the order they first appear in the selection. */
export function kindBreakdown(nodeIds: ReadonlyArray<string>): string {
  const counts = new Map<string, number>();
  for (const id of nodeIds) {
    const n = defaultSceneGraph.getNode(id);
    if (!n) continue;
    const kind = readNodeKind(n);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, n]) => {
    const [one, many] = KIND_COUNT[kind] ?? ['layer', 'layers'];
    return `${n} ${n === 1 ? one : many}`;
  }).join(', ');
}

function notify(level: 'info' | 'warning', message: string, durationMs: number): void {
  useUIStore.getState().notify({ level, message, durationMs });
}

/**
 * Rename through `renameLayer` — never `node.name = …` — for the reason the
 * Scene panel's rename spells out: expressions resolve layers by NAME, and
 * `renameLayer` repairs them in the same undo entry. The notices mirror that
 * panel's, so a rename reports the same thing wherever it was made.
 */
function commitLayerRename(id: string, name: string): void {
  const result = renameLayer(id, name);
  if (!result.ok) return;
  if (result.repaired.length > 0) {
    const n = result.repaired.length;
    notify('info', n === 1 ? '1 expression updated to follow the new name.' : `${n} expressions updated to follow the new name.`, 4000);
  }
  if (result.captured.length > 0) {
    const n = result.captured.length;
    notify('warning', `${n} expression${n === 1 ? '' : 's'} naming “${name.trim()}” now read this layer instead of the one they read before.`, 10000);
  } else if (result.nameAlreadyInUse) {
    notify('warning', `Another layer is already called “${name.trim()}”. An expression naming it can only reach one of them.`, 6000);
  }
}

function LayerName({ nodeId, name, locked }: { nodeId: string; name: string; locked: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // Set once an edit has been committed or cancelled, so the blur that follows
  // an Enter / Escape (the input unmounting) cannot commit a second time.
  const settled = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // A different layer selected mid-edit abandons the edit rather than renaming
  // the layer that just arrived.
  useEffect(() => {
    settled.current = true;
    setEditing(false);
  }, [nodeId]);

  const begin = (): void => {
    if (locked) {
      notify('info', `“${name}” is locked — unlock it to rename it.`, 3000);
      return;
    }
    settled.current = false;
    setDraft(name);
    setEditing(true);
  };

  const finish = (save: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    if (save) commitLayerRename(nodeId, draft);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={styles.nameInput}
        aria-label="Layer name"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className={styles.name}
      role="button"
      tabIndex={0}
      title={`${name} — double-click to rename`}
      onDoubleClick={begin}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          begin();
        }
      }}
    >
      {name}
    </span>
  );
}

export interface SelectionHeaderProps {
  nodeIds: ReadonlyArray<string>;
  /**
   * Right-hand controls, for a panel rendered OUTSIDE a dock (search, ⋯). In a
   * dock those live in the dock header and this is left empty.
   */
  actions?: ReactNode;
}

function SelectionHeaderInner({ nodeIds = [], actions }: SelectionHeaderProps): JSX.Element | null {
  useNodesRevision(nodeIds);
  const primary = nodeIds[0] ?? null;
  const node = primary ? defaultSceneGraph.getNode(primary) : null;

  if (!primary || !node) return null;

  const current = getNodeLabelColor(primary);
  const colorItems: DropdownItem[] = [
    {
      type: 'item', id: 'default', label: 'Default (by kind)',
      icon: current === undefined ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(nodeIds, undefined),
    },
    { type: 'separator' },
    ...LABEL_COLORS.map((c): DropdownItem => ({
      type: 'item', id: c.id,
      label: (
        <span className={styles.colorItem}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill={c.color} /></svg>
          {c.label}
        </span>
      ),
      icon: current === c.color ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(nodeIds, c.color),
    })),
  ];

  const live = nodeIds.filter((id) => !!defaultSceneGraph.getNode(id));
  const kind = readNodeKind(node);

  return (
    <div className={styles.header} data-selection-header>
      <Dropdown
        items={colorItems}
        placement="bottom-start"
        trigger={
          <button type="button" className={styles.swatchBtn} aria-label="Label colour" title="Label colour">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <circle cx="5" cy="5" r="5" fill={current ?? 'currentColor'} />
            </svg>
          </button>
        }
      />
      {live.length > 1 ? (
        <>
          <Icon name="layers" size="sm" className={styles.kindIcon} />
          <span className={styles.name}>{live.length} layers</span>
          <span className={styles.kind}>{kindBreakdown(live)}</span>
        </>
      ) : (
        <>
          <Icon name={kindIcon(kind)} size="sm" className={styles.kindIcon} />
          <LayerName nodeId={primary} name={node.name ?? primary} locked={node.locked === true} />
          <span className={styles.kind}>{kindNoun(kind)}</span>
        </>
      )}
      {actions}
    </div>
  );
}

/*
 * Memoized: the Properties panel re-renders for its own reasons (a search
 * keystroke, the ⋯ menu hand-off) and hands this the same selection it had
 * before. Pinned by `inspectorRenderScope.test.tsx`.
 */
export const SelectionHeader = memo(SelectionHeaderInner);

export default SelectionHeader;
