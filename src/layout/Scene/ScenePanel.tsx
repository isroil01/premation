/**
 * ScenePanel — the layer tree for the open composition, plus the project's
 * composition list above it.
 *
 * Three jobs, all of them the document's structure rather than its values:
 *   • the composition list (open, duplicate, settings, delete);
 *   • the layer tree — selection, rename, the switch column, drag-to-reparent,
 *     the parent pick-whip, and the row menu (`sceneMenu`);
 *   • the filter row that narrows the tree five ways, and the view menu that
 *     says how much of the document to list and how densely.
 *
 * It reads the live scene graph directly (`defaultSceneGraph`) and re-derives
 * the tree from a structural change, so there is one source of truth for what
 * the document contains and this panel never holds a second copy of it.
 *
 * ── Why STRUCTURE and not the scene revision ──────────────────────────
 * The tree used to be keyed on `useSceneRevision().rev`. That counter ticks on
 * every value write as well as every structural one — `bumpSceneRevision` is
 * called per pointer move by `viewportGesture` — so dragging a layer on canvas
 * rebuilt this entire tree thirty to sixty times a second: every node of every
 * composition, its plugin ownership, its label colour and a fresh JSX label,
 * then the filter walk, the match count, the kind list and the footer's flatten
 * on top. The timeline was moved off `rev` for exactly this reason and the
 * Layers panel was not. Structure arrives as `SceneGraphChanged`; VALUES that
 * this tree actually displays (a name, a visibility flag, a label colour) each
 * announce themselves as `NodeUpdated`, which is the second signal below.
 *
 * Panel chrome (rows, the footer, the search row) comes from the shared
 * `EditorLayout/panels.module.css`, which the Scene, Assets and Inspector
 * panels all draw from — they are three views of one dock, not three designs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '@components/Panel';
import { TreeView } from '@components/TreeView';
import { SearchField } from '@components/SearchField';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { PickWhip } from '@components/PickWhip';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompId, useMirrorRevision } from '@hooks/useMirror';
import { mirrorCanBeParentOf } from '@core/mirror/parenting';
import { useUIStore } from '@stores/uiStore';
import { openContextMenu } from '@stores/contextMenuStore';
import {
  ROW_DENSITY,
  useSceneViewStore,
  type RowDensity,
  type SearchField as SearchFieldId,
} from '@stores/sceneViewStore';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { RenameLayerResult } from '@core/scene/renameLayer';
import { isLayer } from '@core/engine/doc';
import { type SceneKind } from '@core/scene/seedDefaultScene';
import { KIND_LABEL } from '@core/scene/sceneDerive';
import { parentLayer } from '@layout/Inspector/inspectorEdits';
import { moveLayersInTreeEdit, renameLayerEdit } from './sceneEdits';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { LAYER_FLAGS } from '@core/scene/layerFlags';
import {
  countSceneMatches,
  filterSceneTree,
  isSceneFilterActive,
  toggleKind,
  withRevealed,
  type SceneFilter,
} from './sceneFilters';
import {
  collectIds,
  makeFactsReader,
  presentKinds,
  sceneGraphToTree,
} from './sceneRows';
import { SceneRowSwitches } from './SceneRowSwitches';
import { deleteLayersWithFeedback, sceneNodeMenuItems } from './sceneMenu';
import styles from '@layout/EditorLayout/panels.module.css';
import { CompositionList } from './CompositionList';

const KIND_ORDER = Object.keys(KIND_LABEL) as SceneKind[];

const SEARCH_FIELDS: ReadonlyArray<{ id: SearchFieldId; label: string }> = [
  { id: 'name', label: 'Layer name' },
  { id: 'effects', label: 'Effect names' },
  { id: 'expressions', label: 'Expression text' },
  { id: 'source', label: 'Source file / comp' },
];

const DENSITIES: ReadonlyArray<{ id: RowDensity; label: string }> = [
  { id: 'compact', label: 'Compact' },
  { id: 'cozy', label: 'Cozy' },
  { id: 'comfortable', label: 'Comfortable' },
];

/** Re-export for the layer-ordering tests, which assert what this panel LISTS. */
export { sceneGraphToTree } from './sceneRows';

/**
 * A counter that ticks when the document changes (B4: the mirror's revision).
 *
 * The tree draws structure, the values that appear on a row (names, switches,
 * labels, kinds, icons) and, for the filters, keyframes and effects — so any
 * edit may change it, as the legacy `NodeUpdated` / `AnimationChanged` ticks
 * it replaces said. An edit is a revision; a played frame or a viewport hover
 * is not, so this never ticks per frame.
 */
function useDocumentRevision(): number {
  return useMirrorRevision();
}

/**
 * The ancestors of `id` in the tree, innermost first: its parent chain, then
 * the composition it belongs to (the tree's root row). From the document mirror.
 */
function ancestorChain(id: string): string[] {
  const m = documentMirror();
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = m.layer(id);
  let parent = cur?.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    chain.push(parent);
    cur = m.layer(parent);
    parent = cur?.parent;
  }
  if (cur && !seen.has(cur.comp)) chain.push(cur.comp);
  return chain;
}

/**
 * A row's lock and name: a layer's from the document mirror; a composition
 * ROOT's from its node.
 */
function rowLock(id: string): { locked: boolean; name: string | undefined } | null {
  const l = documentMirror().layer(id);
  if (l) return { locked: l.switches.locked, name: l.name };
  // B4-gap: a composition ROOT is not a layer in the API — its lock is a node flag the legacy
  // writer toggles, with no mirror record.
  const root = defaultSceneGraph.getNode(id);
  return root ? { locked: root.locked === true, name: root.name } : null;
}

export function ScenePanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  const rev = useDocumentRevision();

  const activeTabId = useProjectStore((s) => s.activeTabId);
  // The active tab's composition (or a group opened in its own tab), when the document has it.
  const tabCompId = useActiveCompId();
  const activeCompId = tabCompId && (documentMirror().comp(tabCompId) || documentMirror().layer(tabCompId)) ? tabCompId : undefined;

  // ── View settings: panel-wide, persisted, outlive the panel's mount ──
  const scope = useSceneViewStore((s) => s.scope);
  const density = useSceneViewStore((s) => s.density);
  const switches = useSceneViewStore((s) => s.switches);
  const thumbnails = useSceneViewStore((s) => s.thumbnails);
  const hideShy = useSceneViewStore((s) => s.hideShy);
  const view = useSceneViewStore((s) => ({
    setScope: s.setScope, setDensity: s.setDensity, toggleSwitch: s.toggleSwitch,
    setThumbnails: s.setThumbnails, setHideShy: s.setHideShy,
  }));

  // ── Filters: per composition, so "show me the cameras" is a question
  //    about THIS comp and does not follow you into one with no cameras ──
  const filters = useSceneViewStore((s) => s.filters);
  const patchFilter = useSceneViewStore((s) => s.patchFilter);
  const clearFilterFor = useSceneViewStore((s) => s.clearFilter);
  const stored = useMemo(
    () => useSceneViewStore.getState().filterFor(activeCompId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters, activeCompId],
  );
  const patch = useCallback(
    (p: Parameters<typeof patchFilter>[1]) => patchFilter(activeCompId, p),
    [patchFilter, activeCompId],
  );

  const tree = useMemo(
    () => sceneGraphToTree(scope, { thumbnails }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, activeTabId, scope, thumbnails],
  );

  const q = stored.query.trim().toLowerCase();
  /*
    Search is one of FIVE questions this panel answers, not the only one. A
    stack of forty layers is narrowed by kind ("show me the cameras"), by label
    colour ("the shots I tagged red"), by whether a layer is animated and by
    whether it carries effects — and they compose, with the search, in
    `sceneFilters.ts`. The search itself now asks four FIELDS, because "where
    is that glow" is one question whether the word names the layer or the
    effect on it.
  */
  const kindFilter = useMemo(() => (stored.kinds ? new Set(stored.kinds) : null), [stored.kinds]);
  const filter: SceneFilter = {
    kinds: kindFilter,
    label: stored.label,
    animatedOnly: stored.animatedOnly,
    effectsOnly: stored.effectsOnly,
    query: q,
    fields: stored.fields,
    hideShy,
  };
  const filterActive = isSceneFilterActive(filter);

  // Keyframes, effects and expressions are edits like any other: the document
  // revision (`rev`) ticks on them, so the "with keyframes" / "with effects"
  // filters re-ask when a keyframe or an effect is added.

  /*
    ONE facts reader per pass, shared by the filter walk and the match count.
    The expensive fields (every expression in the document; the asset list) are
    indexed once here and only when they are actually being searched, instead
    of being re-derived per node per keystroke by both walks.
  */
  const factsOf = useMemo(
    () => makeFactsReader(stored.fields, q.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored.fields, q, rev],
  );

  const filtered = useMemo(
    () => filterSceneTree(tree, filter, factsOf),
    // The filter object is rebuilt every render; its FIELDS are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, kindFilter, stored.label, stored.animatedOnly, stored.effectsOnly, q, stored.fields, hideShy, factsOf],
  );
  const matchCount = useMemo(
    () => (filterActive ? countSceneMatches(filtered, filter, factsOf) : 0),
    // Same fields as `filtered`, which already carries them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, filterActive, factsOf],
  );
  const kindChoices = useMemo(() => presentKinds(tree, KIND_ORDER), [tree]);
  const expandIds = useMemo(() => collectIds(filtered), [filtered]);
  // Expand only the top-level roots by default, so their LAYERS are visible
  // but groups stay shut. `collectIds` returns every descendant, so an imported
  // SVG icon — one group of dozens of paths — unfolded into dozens of rows the
  // moment it was added, burying the rest of the scene. The icon is one body on
  // canvas already (see `selectionGroup`); the tree now agrees with that.
  // Searching still expands everything, so matches stay reachable.
  const defaultExpandIds = useMemo(() => filtered.map((n) => n.id), [filtered]);
  // The ACTIVE composition's layers, root excluded. `defaultSceneGraph.size`
  // counted every node of every composition — each comp root included — so a
  // project with three comps reported a number that matched no list on screen.
  // B4: the composition's layers from the document mirror (every layer of it, groups' members included).
  const itemCount = useMemo(
    () => {
      const m = documentMirror();
      const id = tabCompId ?? m.compIds[0] ?? '';
      const comp = m.comp(id);
      if (comp) return comp.layers.length;
      // A group opened in its own tab: its members, at any depth.
      let n = 0;
      const walk = (ids: readonly string[]): void => {
        for (const c of ids) {
          n += 1;
          walk(m.layer(c)?.children ?? []);
        }
      };
      walk(m.layer(id)?.children ?? []);
      return n;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, tabCompId],
  );

  /*
   * Keep a reparented layer on screen.
   *
   * `parent` IS the tree here, so parenting MOVES the layer into the parent's
   * branch — and only top-level roots are expanded by default. Parent a
   * rectangle to a Null and it lands inside a branch that has never been
   * expanded (a Null has no children until that moment), so it vanishes from
   * this panel entirely while still rendering on canvas. Reported as
   * "missing layer after parent to null".
   *
   * The whole ancestor chain, not just the parent: the destination can itself
   * sit inside a shut group, and opening only the innermost branch would leave
   * the layer just as hidden one level up.
   */
  const [revealIds, setRevealIds] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    const sub = getEventBus().on('LayerReparented', ({ parentId }) => {
      setRevealIds(parentId ? [parentId, ...ancestorChain(parentId)] : []);
    });
    return () => sub.dispose();
  }, []);
  // While a filter drives the expansion set the tree is controlled and drops
  // `revealIds` on the floor (a controlled caller owns its reveal — this is
  // that caller). Merge the chain in here so a reparent during a search opens
  // its branch the same way it does without one.
  const controlledExpandIds = useMemo(() => withRevealed(expandIds, revealIds), [expandIds, revealIds]);

  /*
    Follow a selection this panel did not make.

    Clicking a layer on canvas, in the timeline, or through a command selects
    it everywhere — and this tree, which may have it scrolled a thousand rows
    away or shut inside a group, simply did not react. The tree scrolls to the
    newest member of the selection and opens its ancestors, but only when the
    selection CHANGED from outside: `ownSelection` marks the ids this panel just
    set, so clicking a row here does not make the list jump under the cursor.
  */
  const ownSelection = useRef<string | null>(null);
  const [scrollToId, setScrollToId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const id = selected[selected.length - 1];
    if (!id || ownSelection.current === id) return;
    setScrollToId(id);
    const chain = ancestorChain(id);
    if (chain.length) setRevealIds(chain);
  }, [selected]);

  const selectFromTree = useCallback((ids: ReadonlyArray<string>) => {
    ownSelection.current = ids[ids.length - 1] ?? null;
    setSelected(ids);
  }, [setSelected]);

  const [renamingId, setRenamingId] = useState<string | null>(null);

  /** True (and says so) when the row is locked — locked means not editable here. */
  const refuseIfLocked = (id: string, what: string): boolean => {
    const row = rowLock(id);
    if (!row?.locked) return false;
    useUIStore.getState().notify({ level: 'info', message: `“${row.name ?? id}” is locked — unlock it to ${what}.`, durationMs: 3000 });
    return true;
  };

  const startRename = (id: string): void => {
    if (refuseIfLocked(id, 'rename it')) return;
    setRenamingId(id);
  };

  const commitRename = (id: string, name: string): void => {
    setRenamingId(null);
    if (refuseIfLocked(id, 'rename it')) return;

    // Not a bare `node.name = name`. Expressions reference layers by NAME and
    // resolve at evaluation time, so a plain rename silently zeroes every
    // reference to this layer — with the symptom appearing nowhere near the
    // rename that caused it. `renameLayerEdit` sends the engine's rename when
    // no expression names the old or new name, and otherwise keeps
    // `renameLayer`, which follows the rename through those references in the
    // SAME undo entry and reports the two cases it will not guess at.
    void renameLayerEdit(id, name).then((result) => reportRename(result, name));
  };

  /** What a rename did to expressions, said once (see `renameLayer`). */
  const reportRename = (result: RenameLayerResult, name: string): void => {
    if (!result.ok) return;

    if (result.repaired.length > 0) {
      useUIStore.getState().notify({
        level: 'info',
        message:
          result.repaired.length === 1
            ? '1 expression updated to follow the new name.'
            : `${result.repaired.length} expressions updated to follow the new name.`,
        durationMs: 4000,
      });
    }

    // The author's call, not ours — and worth saying out loud precisely because
    // it breaks nothing visibly today.
    if (result.captured.length > 0) {
      const n = result.captured.length;
      useUIStore.getState().notify({
        level: 'warning',
        message: `${n} expression${n === 1 ? '' : 's'} naming “${name.trim()}” now read this layer instead of the one they read before.`,
        // Longer than the others: this one is a silent retarget the user cannot
        // see anywhere else, and it is the only notice they will get.
        durationMs: 10000,
      });
    } else if (result.nameAlreadyInUse) {
      useUIStore.getState().notify({
        level: 'warning',
        message: `Another layer is already called “${name.trim()}”. An expression naming it can only reach one of them.`,
        durationMs: 6000,
      });
    }
  };

  /*
    Drag-to-reorder / reparent from the layer tree.

    Three things the single-id version got wrong, all of them visible with more
    than one row selected or more than one lock in the stack:
      • it moved ONE layer of a multi-row drag and left the rest behind;
      • it checked the DRAGGED layer's lock and not the destination's, so a
        locked group happily accepted children;
      • each moved layer was its own undo entry.

    The tree DISPLAYS front first (reversed child order), while
    `moveNodeAdjacent` speaks child order — so display-before means child-after
    and vice versa. Dropped in reverse so a multi-row drag keeps the order the
    rows were in rather than inverting it.
  */
  const handleReorder = (
    ids: ReadonlyArray<string>,
    targetId: string | null,
    pos: 'before' | 'after' | 'inside',
  ): void => {
    const movable = ids.filter((id) => {
      // A composition root is not a layer and cannot be moved into one.
      const l = documentMirror().layer(id);
      return !!l && !l.switches.locked && isLayer(id);
    });
    if (movable.length === 0) {
      if (ids.length > 0) refuseIfLocked(ids[0]!, 'move it');
      return;
    }
    if (targetId !== null) {
      const target = rowLock(targetId);
      if (target?.locked && pos === 'inside') {
        useUIStore.getState().notify({
          level: 'info',
          message: `“${target.name ?? targetId}” is locked — unlock it to put layers inside it.`,
          durationMs: 3000,
        });
        return;
      }
    }

    // One entry: `setParent` + `reorderLayers` through the engine (the drop
    // rules are spelled out on `moveLayersInTreeEdit`).
    void moveLayersInTreeEdit(movable, targetId, pos);
  };

  const openNodeMenu = (id: string, e: React.MouseEvent): void => {
    openContextMenu(e.clientX, e.clientY, sceneNodeMenuItems(id, { startRename }));
  };

  const rowHeight = ROW_DENSITY[density];

  /** The view menu: scope, density, which switches, thumbnails, shy. */
  const viewMenuItems: DropdownItem[] = [
    { type: 'label', label: 'Show' },
    ...(['comp', 'project'] as const).map((s): DropdownItem => ({
      type: 'item',
      id: `v-scope-${s}`,
      label: s === 'comp' ? 'This composition' : 'Whole project',
      icon: scope === s ? 'check' : undefined,
      onSelect: () => view.setScope(s),
    })),
    { type: 'separator' },
    { type: 'label', label: 'Row height' },
    ...DENSITIES.map((d): DropdownItem => ({
      type: 'item',
      id: `v-density-${d.id}`,
      label: d.label,
      icon: density === d.id ? 'check' : undefined,
      onSelect: () => view.setDensity(d.id),
    })),
    { type: 'separator' },
    { type: 'label', label: 'Switches on each row' },
    ...LAYER_FLAGS.map((f): DropdownItem => ({
      type: 'checkbox',
      id: `v-switch-${f.id}`,
      label: f.label,
      checked: switches.includes(f.id),
      onChange: () => view.toggleSwitch(f.id),
    })),
    { type: 'separator' },
    {
      type: 'checkbox',
      id: 'v-thumbs',
      label: 'Source thumbnails',
      checked: thumbnails,
      onChange: () => view.setThumbnails(!thumbnails),
    },
    {
      type: 'checkbox',
      id: 'v-shy',
      label: 'Hide shy layers',
      checked: hideShy,
      onChange: () => view.setHideShy(!hideShy),
    },
  ];

  return (
    <Panel
      id="scene"
      title="Scene"
      icon="layers"
      hideHeader
      noScroll
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'scene' })}
    >
      <div className={styles.sceneShell} data-tour="scene-panel">
        <CompositionList collapsible />
        <div className={styles.layerSectionHead}>
          <span className={styles.compSectionLabel}>Layers</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button
                type="button"
                className={styles.sceneFilterBtn}
                title="How this panel lists layers"
                aria-label="Layers panel view options"
              >
                <Icon name="settings" size="sm" />
              </button>
            }
            items={viewMenuItems}
          />
        </div>
      <div className={styles.searchRow}>
        <SearchField
          placeholder={searchPlaceholder(stored.fields)}
          ariaLabel="Search layers"
          value={stored.query}
          onChange={(query) => patch({ query })}
        />
        {/* WHICH fields the box searches. A separate control rather than a
            syntax ("fx:glow") because the answer has to be visible without
            being typed — a search that silently looks in four places is as
            confusing as one that silently looks in one. */}
        <Dropdown
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className={styles.sceneFilterBtn}
              title={`Searching: ${stored.fields.map((f) => SEARCH_FIELDS.find((s) => s.id === f)?.label ?? f).join(', ')}`}
              aria-label="Choose what the search looks in"
            >
              <Icon name="search" size="sm" />
            </button>
          }
          items={SEARCH_FIELDS.map((f): DropdownItem => ({
            type: 'checkbox',
            id: `field-${f.id}`,
            label: f.label,
            checked: stored.fields.includes(f.id),
            onChange: () => patch({ fields: toggleField(stored.fields, f.id) }),
          }))}
        />
      </div>
      <div className={styles.sceneFilterRow} aria-label="Layer filters">
        <Dropdown
          placement="bottom-start"
          trigger={
            <button
              type="button"
              className={styles.sceneFilterBtn}
              title={kindFilter ? `Showing ${[...kindFilter].map((k) => KIND_LABEL[k]).join(', ')}` : 'Filter by layer kind'}
              aria-label="Filter by layer kind"
              aria-pressed={kindFilter !== null}
              disabled={kindChoices.length === 0}
            >
              <Icon name="layers" size="sm" />
            </button>
          }
          items={[
            { type: 'item', id: 'all-kinds', label: 'All kinds', icon: kindFilter === null ? 'check' : undefined, onSelect: () => patch({ kinds: null }) },
            { type: 'separator' },
            ...kindChoices.map((k): DropdownItem => ({
              type: 'checkbox',
              id: k,
              label: KIND_LABEL[k],
              checked: kindFilter?.has(k) ?? false,
              // An empty set collapses back to "every kind" — unchecking the
              // last box means "stop filtering", not "show nothing".
              onChange: () => {
                const next = toggleKind(kindFilter, k);
                patch({ kinds: next ? [...next] : null });
              },
            })),
          ]}
        />
        <Dropdown
          placement="bottom-start"
          trigger={
            <button
              type="button"
              className={styles.sceneFilterBtn}
              title="Filter by label colour"
              aria-label="Filter by label colour"
              aria-pressed={stored.label !== null}
            >
              {stored.label && stored.label !== 'none' ? (
                <span className={styles.sceneFilterLabelDot} style={{ background: stored.label }} aria-hidden />
              ) : (
                <Icon name="palette" size="sm" />
              )}
            </button>
          }
          items={[
            { type: 'item', id: 'any-label', label: 'Any label', icon: stored.label === null ? 'check' : undefined, onSelect: () => patch({ label: null }) },
            // The set you forgot to tag — the other half of what a label is for.
            { type: 'item', id: 'no-label', label: 'Unlabelled', icon: stored.label === 'none' ? 'check' : undefined, onSelect: () => patch({ label: 'none' }) },
            { type: 'separator' },
            ...LABEL_COLORS.map((c): DropdownItem => ({
              type: 'item',
              id: c.id,
              label: (
                <>
                  <span aria-hidden="true" className={styles.labelSwatch} style={{ background: c.color }} />
                  {c.label}
                </>
              ),
              icon: stored.label === c.color ? 'check' : undefined,
              onSelect: () => patch({ label: stored.label === c.color ? null : c.color }),
            })),
          ]}
        />
        <button
          type="button"
          className={styles.sceneFilterBtn}
          title="Only layers with keyframes"
          aria-label="Only layers with keyframes"
          aria-pressed={stored.animatedOnly}
          onClick={() => patch({ animatedOnly: !stored.animatedOnly })}
        >
          <Icon name="keyframe" size="sm" />
        </button>
        <button
          type="button"
          className={styles.sceneFilterBtn}
          title="Only layers with effects"
          aria-label="Only layers with effects"
          aria-pressed={stored.effectsOnly}
          onClick={() => patch({ effectsOnly: !stored.effectsOnly })}
        >
          <Icon name="magic-wand" size="sm" />
        </button>
        {filterActive && (
          <button
            type="button"
            className={styles.sceneFilterBtn}
            title="Clear layer filters"
            aria-label="Clear layer filters"
            onClick={() => clearFilterFor(activeCompId)}
          >
            <Icon name="close" size="sm" />
          </button>
        )}
      </div>
      {/*
        A pick-whip drop surface. Rows already carry `data-id` from the shared
        TreeView and that id IS the scene node id here, so scoping the container
        is the entire integration — see `@core/whip/whipTarget` for why the
        alternative (teaching TreeView to emit whip attributes) would be worse
        for a component six panels use with four kinds of id.
      */}
      <div className={styles.body} data-whip-scope="layer">
        {filtered.length ? (
          <TreeView
            nodes={filtered}
            ariaLabel="Layers"
            rowHeight={rowHeight}
            selectedIds={selected}
            onSelect={selectFromTree}
            defaultExpandedIds={defaultExpandIds}
            expandedIds={filterActive ? controlledExpandIds : undefined}
            revealIds={revealIds}
            scrollToId={scrollToId}
            onNodeContextMenu={openNodeMenu}
            onReorder={handleReorder}
            renamingId={renamingId ?? undefined}
            onRename={commitRename}
            onRenameCancel={() => setRenamingId(null)}
            onRenameRequest={startRename}
            onDelete={(ids) => { void deleteLayersWithFeedback(ids); }}
            /*
              The parent pick-whip, the gesture AE users reach for a hundred
              times a day. The tree was already a whip TARGET; being only a
              target meant you could parent a layer TO one of these rows and
              never FROM one. Composition roots get no whip — they are the
              document, not a layer that can have a parent.
            */
            renderLead={(node) => {
              // A composition root (no layer record) gets no whip.
              if (!documentMirror().layer(node.id)) return null;
              return (
                <PickWhip
                  label="Parent pick-whip — drag onto a layer (Shift: jump to the parent · Alt: keep values)"
                  accept={(target) => mirrorCanBeParentOf(documentMirror(), node.id, target.nodeId)}
                  // The inspector's writer (`setParent`); a composition root = no parent.
                  onPick={(target, m) => parentLayer(node.id, isLayer(target.nodeId) ? target.nodeId : null, m)}
                />
              );
            }}
            renderActions={(node) => <SceneRowSwitches nodeId={node.id} flags={switches} />}
          />
        ) : (
          <div className={styles.empty} role="status">
            {filterActive
              ? 'No layers match this filter.'
              : 'No layers yet. Add one from the “+ New layer” menu in the toolbar.'}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span>{itemCount} {itemCount === 1 ? 'layer' : 'layers'}</span>
        {filterActive && (
          <>
            <span>·</span>
            <span>{matchCount} {matchCount === 1 ? 'match' : 'matches'}</span>
          </>
        )}
        <span>·</span>
        <span>{selected.length} selected</span>
      </div>
      </div>
    </Panel>
  );
}

/** Placeholder that says where the box is looking, so the answer is visible
 *  before a fruitless search rather than after it. */
function searchPlaceholder(fields: ReadonlyArray<SearchFieldId>): string {
  if (fields.length === 0 || (fields.length === 1 && fields[0] === 'name')) return 'Search layers…';
  if (fields.length === SEARCH_FIELDS.length) return 'Search layers, effects, expressions…';
  return `Search ${fields.map((f) => SEARCH_FIELDS.find((s) => s.id === f)?.label.toLowerCase() ?? f).join(' · ')}…`;
}

/** Toggle a search field; unchecking the last one falls back to the name,
 *  because a search box that looks in nothing is a box that does nothing. */
function toggleField(fields: ReadonlyArray<SearchFieldId>, id: SearchFieldId): SearchFieldId[] {
  const next = fields.includes(id) ? fields.filter((f) => f !== id) : [...fields, id];
  return next.length === 0 ? ['name'] : [...next];
}
