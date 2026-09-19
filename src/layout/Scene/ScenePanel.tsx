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
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useProjectStore } from '@stores/projectStore';
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
import { renameLayer } from '@core/scene/renameLayer';
import { type SceneKind } from '@core/scene/seedDefaultScene';
import { KIND_LABEL, flattenComposition } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { canReparent, eligibleParents, moveNodeAdjacent, parentOptionsFor, reparentNode } from '@core/scene/parenting';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { LAYER_FLAGS } from '@core/scene/layerFlags';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { batchScene } from '@stores/sceneStore';
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
 * A counter that ticks on the things THIS tree draws: structure, and the node
 * values that appear on a row.
 *
 * Deliberately narrower than `useSceneRevision` — see the file header. A value
 * write announces itself as `NodeUpdated` whether or not it is one this panel
 * shows, which is still far less often than the raw revision and, unlike it,
 * never fires on a viewport drag tick for a node that is not being drawn here.
 */
function useSceneStructure(): number {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const bump = (): void => setRev((r) => r + 1);
    const subs = [
      getEventBus().on('SceneGraphChanged', bump),
      getEventBus().on('NodeUpdated', bump),
      getEventBus().on('LayerReparented', bump),
    ];
    return () => { for (const s of subs) s.dispose(); };
  }, []);
  return rev;
}

export function ScenePanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const setSelected = useSelectionStore((s) => s.set);
  const rev = useSceneStructure();

  const comps = useProjectStore((s) => s.comps);
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const activeCompId = activeTabId ? comps[useProjectStore.getState().tabs[activeTabId]?.compositionId ?? '']?.id : undefined;

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
    [rev, comps, activeTabId, scope, thumbnails],
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

  // Keyframes, effects and expressions do not live in the scene graph:
  // `makeFactsReader` reads them from the animation engine, which announces
  // edits as `AnimationChanged` (effects edits emit it too — see
  // `writeNodeEffects`) and never bumps the structure counter `tree` is keyed
  // on. Without this the "with keyframes" / "with effects" filters kept the
  // answer from whenever the tree last rebuilt: add a keyframe and the layer
  // stayed filtered out.
  const animRev = useAnimationRevision();

  /*
    ONE facts reader per pass, shared by the filter walk and the match count.
    The expensive fields (every expression in the document; the asset list) are
    indexed once here and only when they are actually being searched, instead
    of being re-derived per node per keystroke by both walks.
  */
  const factsOf = useMemo(
    () => makeFactsReader(stored.fields, q.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored.fields, q, rev, animRev],
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
  const itemCount = useMemo(
    () => Math.max(0, flattenComposition(defaultSceneGraph, activeCompRootId()).length - 1),
    // `activeCompRootId` reads the project store; the tab is the other input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, activeTabId],
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
      const chain: string[] = [];
      const seen = new Set<string>();
      let cur: string | null = parentId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        chain.push(cur);
        cur = defaultSceneGraph.getNode(cur)?.parent ?? null;
      }
      setRevealIds(chain);
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
    const chain: string[] = [];
    let cur: string | null = defaultSceneGraph.getNode(id)?.parent ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = defaultSceneGraph.getNode(cur)?.parent ?? null;
    }
    if (chain.length) setRevealIds(chain);
  }, [selected]);

  const selectFromTree = useCallback((ids: ReadonlyArray<string>) => {
    ownSelection.current = ids[ids.length - 1] ?? null;
    setSelected(ids);
  }, [setSelected]);

  const [renamingId, setRenamingId] = useState<string | null>(null);

  /** True (and says so) when the row is locked — locked means not editable here. */
  const refuseIfLocked = (id: string, what: string): boolean => {
    const n = defaultSceneGraph.getNode(id);
    if (!n?.locked) return false;
    useUIStore.getState().notify({ level: 'info', message: `“${n.name ?? id}” is locked — unlock it to ${what}.`, durationMs: 3000 });
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
    // rename that caused it. `renameLayer` follows the rename through those
    // references in the SAME undo entry, and reports the two cases it will not
    // guess at.
    const result = renameLayer(id, name);
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
      const n = defaultSceneGraph.getNode(id);
      // A composition root is not a layer and cannot be moved into one.
      return !!n && n.parent !== null && !n.locked;
    });
    if (movable.length === 0) {
      if (ids.length > 0) refuseIfLocked(ids[0]!, 'move it');
      return;
    }
    if (targetId !== null) {
      const target = defaultSceneGraph.getNode(targetId);
      if (target?.locked && pos === 'inside') {
        useUIStore.getState().notify({
          level: 'info',
          message: `“${target.name ?? targetId}” is locked — unlock it to put layers inside it.`,
          durationMs: 3000,
        });
        return;
      }
    }

    const label = movable.length === 1 ? 'Move layer' : `Move ${movable.length} layers`;
    runDocumentEdit(label, () => {
      batchScene(() => {
        for (const id of [...movable].reverse()) {
          if (targetId === null) {
            // Dropped below the last row: out to the enclosing composition.
            const root = activeCompRootId();
            if (root && canReparent(id, root)) reparentNode(id, root);
            continue;
          }
          if (pos === 'inside') {
            if (canReparent(id, targetId)) reparentNode(id, targetId);
            // Cannot nest: land it just in front of the target instead. Display
            // "before" is child-order "after" — the same flip as the branch
            // below; passing the display word straight through dropped it on
            // the far side.
            else moveNodeAdjacent(id, targetId, 'after');
          } else {
            moveNodeAdjacent(id, targetId, pos === 'before' ? 'after' : 'before');
          }
        }
      });
    });
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
            onDelete={(ids) => deleteLayersWithFeedback(ids)}
            /*
              The parent pick-whip, the gesture AE users reach for a hundred
              times a day. The tree was already a whip TARGET; being only a
              target meant you could parent a layer TO one of these rows and
              never FROM one. Composition roots get no whip — they are the
              document, not a layer that can have a parent.
            */
            renderLead={(node) => {
              const n = defaultSceneGraph.getNode(node.id);
              if (!n || n.parent === null) return null;
              const options = eligibleParents(node.id);
              return (
                <PickWhip
                  label="Parent pick-whip — drag onto a layer (Shift: jump to the parent · Alt: keep values)"
                  accept={(target) => options.some((o) => o.id === target.nodeId)}
                  onPick={(target, m) => reparentNode(node.id, target.nodeId, parentOptionsFor(m))}
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
