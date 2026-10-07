/**
 * useTimelineHandlers — every timeline row, bar, keyframe and property-row
 * handler, as one hook (2026-10-07).
 *
 * They lived inline in the editor shell, so the pop-out timeline window (which
 * renders `PopoutTimeline`, never the shell) re-implemented a few and passed
 * nothing for the rest: its switches, Mode / TrkMat / Parent menus, rename,
 * trims and keyframe edits rendered and did nothing. Both timelines now take
 * the same handlers from here — `timelineHandlerProps` spreads them onto
 * `<BottomTimeline>`.
 *
 * `tracksRef` is the host's latest row list (row reorder anchors to it).
 */

import { useMemo, useRef, useCallback } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { copyKeyframes } from '@core/animation/keyframeClipboard';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { bumpScene } from '@stores/sceneStore';
import { getTime as playheadNow } from '@stores/playbackClockStore';
import { clipRippleMenuItems } from '@layout/Timeline/clipEditCommands';
import { deleteKeyframesUi, easePresetOnKeys, moveKeyframesTo, pasteKeyframesAt } from '@layout/Timeline/keyframeEdits';
import { resolveSelectionKey, storedTimeOf } from '@core/mirror/keySelection';
import { documentMirror } from '@stores/documentMirror';
import {
  barOf,
  moveBar,
  moveBars,
  rippleInsertGapAtPlayhead,
  rippleTrimToPlayhead,
  timeStretchEdit,
  unfreezeEdit,
  slideBar,
  slipBar,
  splitLayersAt,
  trimBar,
  trimSelectedEndToPlayhead,
  trimSelectedStartToPlayhead,
} from '@layout/Timeline/timelineEdits';
import { setLayerMatte, setLayersBlend } from '@layout/Inspector/inspectorEdits';
import { freezeFrameEdit, setLabelColorEdit, timeReverseEdit } from '@layout/Workspace/layerMenuEdits';
import {
  deleteClipLayerEdit,
  maskShapeStopwatchEdit,
  moveLayerAdjacentEdit,
  propertyKeyToggleEdit,
  propertyStopwatchEdit,
  propertyValueCommands,
  setKeyInterpolationEdit,
  setKeyRovingEdit,
  soloExclusiveEdit,
  toggleAudioMuteEdit,
  toggleLayerFlagEdit,
  toggleTrackSwitchEdit,
} from '@layout/Menu/appEdits';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { useGesture } from '@hooks/useGesture';
import { flicksToSeconds, type Command } from '@motion/engine-api';
import { mirrorBarOf, mirrorCompBars, type MirrorBar } from '@core/mirror/clipBars';
import { settingsFps } from '@core/mirror/compFacts';
import { mirrorCompIdForTransition, mirrorTransitionAtCut } from '@core/mirror/transitions';
import { activeCompIdNow } from '@hooks/useMirror';
import { goToNextKeyframe, goToPrevKeyframe, playheadSeconds, seekPlayhead } from '@core/timeline/timelineView';
import { uiKindOf } from '@core/mirror/layerKinds';
import { readTrack } from '@core/mirror/selection';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { runSceneEditDetection } from '@core/tracking/sceneEditCommand';
import { usePropertySelectionStore, propertyKey, distributeScrub } from '@stores/propertySelectionStore';
import { mirrorMaskShapeKeyed } from '@core/mirror/masks';

import type { TimelineTrack } from '@layout/Timeline';
import { type EasingKind } from '@motion/animation';
import { openKeyframeVelocityDialog } from '@layout/Timeline/KeyframeVelocityDialog';
import { addTransitionEdit, removeTransitionsEdit, setTransitionEdit } from '@layout/Timeline/transitionEdits';
import { DEFAULT_TRANSITION_FRAMES, TRANSITION_KINDS, TRANSITION_LABEL } from '@core/timeline/transitions';
import { TRANSITION_ALIGNMENTS, TRANSITION_ALIGNMENT_LABEL } from '@layout/Timeline/transitionOverlay';
import { TIMELINE_EDIT_MODES, setTimelineEditMode, getTimelineEditMode } from '@layout/Timeline/timelineEditMode';
import { mirrorStretchPercent, retimableLayerIds } from '@core/mirror/motionAssist';
import { openLayerOnDoubleClick } from '@layout/LayerViewer/openLayer';
import { renameLayerEdit } from '@layout/Scene/sceneEdits';
import { useFocusStore } from '@stores/focusStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { openInterpretFootage } from '@layout/Assets/InterpretFootageModal';
import { itemAsset } from '@core/mirror/itemAssets';
import { customPrompt, customAlert } from '@components/Modal';

import type { MutableRefObject } from 'react';
import { applyTransitionEdit } from '@layout/EditorLayout/transitionInsertEdits';
import { TRANSITION_ITEMS, getTransitionItem } from '@core/library/transitionLibrary';
import { hasPositionKeys, hasPositionTangents } from '@core/mirror/motionFacts';
import { smoothPositionPath, straightenPositionPath } from '@core/mirror/positionTracks';
import { editPositionKeys } from '@layout/Workspace/viewportEdits';

/**
 * The value a property HAS at comp `seconds`: the evaluated value when the
 * property is animated, else its static value, else the type's default — from
 * the document MIRROR (B4: `readTrack` answers stored units for every catalog
 * track — effect params, path operators and text animators included; an
 * animated value is the engine's, batched per time and revision).
 *
 * One definition on purpose. The stopwatch, the add-keyframe command and the
 * timeline's value fields all need this answer, and three copies of the rule is
 * three chances to key a different number than the one on screen — which is
 * exactly how "Enable animation" on Position once wrote y:= x.
 */
function propertyValueAt(nodeId: string, prop: string, seconds: number): number {
  const m = documentMirror();
  const v = readTrack(m, nodeId, prop, seconds);
  if (v !== undefined) return v;
  const meta = mirrorPropertyMeta(prop, m.layer(nodeId), m.tree(nodeId));
  return typeof meta.defaultValue === 'number' ? meta.defaultValue : 0;
}

function setNodeColor(nodeId: string, color: string): void {
  // The label switch through the engine (B3): a palette colour as its index,
  // any other colour as a custom `labelColor`.
  void setLabelColorEdit([nodeId], color);
}

export function useTimelineHandlers(tracksRef: MutableRefObject<ReadonlyArray<TimelineTrack>>) {
  const setSelected = useSelectionStore((s) => s.set);
  const addSelected = useSelectionStore((s) => s.add);
  const focusIsolate = useFocusStore((s) => s.isolate);
  const propertyEntries = usePropertySelectionStore((s) => s.entries);
  const selectedPropertyKeys = useMemo(() => propertyEntries.map(propertyKey), [propertyEntries]);
  const handlePropertySelect = (trackId: string, prop: string, mode: 'replace' | 'toggle'): void => {
    const store = usePropertySelectionStore.getState();
    if (mode === 'replace') store.select({ nodeId: trackId, prop });
    else store.toggle({ nodeId: trackId, prop });
  };

  // Track visibility / lock toggles → `setLayerSwitches` (B3). Every timeline
  // row is a layer of the active composition, so the engine addresses them all.
  const toggleTrackVisible = (trackId: string): void => {
    void toggleTrackSwitchEdit(trackId, 'visible');
  };
  const toggleTrackLock = (trackId: string): void => {
    void toggleTrackSwitchEdit(trackId, 'locked');
  };
  /**
   * Toggle a layer's solo. `exclusive` is AE's Alt+click — "turn off all other
   * solo switches", which leaves this layer the only one soloed. Solo covers
   * picture AND sound in AE, and `voicesOf` in audioScene already silences
   * non-soloed voices, so this one flag drives both.
   */
  const toggleTrackSolo = (trackId: string, exclusive = false): void => {
    // Alt+click a lit switch clears everything (nothing soloed); Alt+click an
    // unlit one isolates it. Either way every OTHER switch goes dark.
    if (exclusive) void soloExclusiveEdit(trackId);
    else void toggleTrackSwitchEdit(trackId, 'solo');
  };

  // Wire scrub → Timeline Engine (authority); it mirrors seconds into the store.
  const handleScrub = (t: number): void => {
    seekPlayhead(t);
  };

  // Clicking a timeline track selects its node (Shift/Cmd = additive).
  const handleTrackSelect = (trackId: string, additive: boolean): void => {
    if (additive) addSelected(trackId);
    else setSelected([trackId]);
  };

  // A Shift span or a lane marquee arrives already resolved — the timeline is
  // the only thing that knows the row order a span runs along.
  const handleTrackSelectMany = (trackIds: ReadonlyArray<string>): void => {
    setSelected([...trackIds]);
  };

  // Rename a scene node — committed when user confirms via Enter or blur.
  const handleTrackRename = (trackId: string, newName: string): void => {
    // The Layers panel's rename: `renameLayer` / `renameItem` through the engine, or the legacy
    // rename when an expression names the layer (it follows the rename through them — sceneEdits).
    void renameLayerEdit(trackId, newName).then((result) => {
      if (!result.ok) return;
      if (result.repaired.length > 0) {
        const n = result.repaired.length;
        useUIStore.getState().notify({
          level: 'info',
          message: `${n} expression${n === 1 ? '' : 's'} updated to follow the new name.`,
          durationMs: 4000,
        });
      }
      if (result.captured.length > 0) {
        const n = result.captured.length;
        useUIStore.getState().notify({
          level: 'warning',
          message: `${n} expression${n === 1 ? '' : 's'} naming “${newName.trim()}” now read this layer instead of the previous layer.`,
          durationMs: 10000,
        });
      } else if (result.nameAlreadyInUse) {
        useUIStore.getState().notify({
          level: 'warning',
          message: `Another layer is already called “${newName.trim()}”; expressions can reach only one of them by name.`,
          durationMs: 6000,
        });
      }
    });
  };

  /**
   * Toggle a layer's AUDIO mute from the speaker glyph on its clip bar.
   *
   * Deliberately separate from the track's visibility eye: hiding a layer
   * silences it too, but muting the sound must not blank the picture. Writes
   * the same prop the inspector's Mute switch does — the glyph is a second view
   * of one piece of state, not a second piece of state.
   */
  const handleClipMuteToggle = (nodeId: string): void => {
    void toggleAudioMuteEdit(nodeId);
  };

  const handleTrackActivate = (trackId: string, alt = false): void => {
    const node = documentMirror().layer(trackId);
    if (!node) return;
    // AE: double-clicking a layer opens it — a comp instance its source comp
    // (with the navigator trail and the playhead carried across), a group its
    // own subtree, footage and solids the Layer panel — per the two "Opening
    // Layers with Double-click" preferences. See openLayer.ts.
    // Alt opens "the other way": a footage layer's source file, a composition layer in the Layer viewer.
    if (openLayerOnDoubleClick(trackId, { alt })) return;
    // A comp instance whose source is gone opens nothing; isolating its empty
    // card would read as a bug.
    if (uiKindOf(node) === 'comp') return;
    focusIsolate(trackId);
    setSelected([trackId]);
  };

  // Drag a track row to a new position (AE-style layer reorder).
  //
  // `toIndex` is a DISPLAY track index (rows listed top = front). The old code
  // fed it straight to `reorderNode` as a sibling index, which was wrong twice
  // over: display order is reversed child order, and with any group expanded
  // the flat row index stopped matching sibling positions at all. Anchoring to
  // the nearest visible SIBLING row is immune to both.
  const handleTrackReorder = useCallback((fromId: string, toIndex: number): void => {
    const list = tracksRef.current;
    const m = documentMirror();
    const node = m.layer(fromId);
    if (!node) return;
    // The scene parent: the group a layer sits in, else its composition.
    const parentId = node.parent ?? node.comp;
    const siblingRow = (t: { id: string } | undefined): boolean => {
      const l = t && t.id !== fromId ? m.layer(t.id) : undefined;
      return !!l && (l.parent ?? l.comp) === parentId;
    };

    // Prefer the first sibling at/after the drop slot → place display-BEFORE it;
    // otherwise the last sibling before the slot → place display-AFTER it.
    let anchorId: string | null = null;
    let displayPos: 'before' | 'after' = 'before';
    for (let i = Math.max(0, toIndex); i < list.length; i++) {
      if (siblingRow(list[i])) { anchorId = list[i]!.id; displayPos = 'before'; break; }
    }
    if (!anchorId) {
      for (let i = Math.min(toIndex, list.length) - 1; i >= 0; i--) {
        if (siblingRow(list[i])) { anchorId = list[i]!.id; displayPos = 'after'; break; }
      }
    }
    if (!anchorId) return;
    // Display order is reversed child order: display-before ⇒ child-after.
    // `reorderLayers` through the engine (B3); rows are layers of the active comp.
    void moveLayerAdjacentEdit(fromId, anchorId, displayPos === 'before' ? 'after' : 'before');
  }, []);

  // ── Keyframe editing (timeline reports intents; the engine does the work) ──
  const handleKeyframeSeek = (kfId: string): void => {
    // The key from the document mirror (B4): its comp time is where the
    // renderer applies it.
    const hit = resolveSelectionKey(documentMirror(), kfId);
    if (!hit) return;
    handleScrub(flicksToSeconds(hit.key.time));
    setSelected([hit.sel.layer]);
  };
  // Through the engine API (B3): one undo entry per release / delete. A key on
  // a member row (Scale X) is its property's whole key (ENGINE_API.md §3.3).
  const handleKeyframeMove = (kfId: string, time: number): void => {
    if (time < 0) void deleteKeyframesUi([kfId]);
    else void moveKeyframesTo([{ id: kfId, time }]);
  };
  const handleKeyframesMove = (moves: ReadonlyArray<{ keyframeId: string; time: number }>): void => {
    void moveKeyframesTo(moves.map((m) => ({ id: m.keyframeId, time: m.time })));
  };
  const handleKeyframesDelete = (keyframeIds: ReadonlyArray<string>): void => {
    void deleteKeyframesUi(keyframeIds);
  };
  /**
   * The keyframe navigator's diamond — the only affordance that creates a
   * keyframe WITHOUT changing the value. Anchoring ("hold here, then move
   * away") is impossible otherwise: the stopwatch writes only the *first*
   * keyframe, so every later one would need a value change to exist.
   */
  const handlePropertyKeyframeToggle = (trackId: string, prop: string): void => {
    // Read the playhead at event time — same store field the navigator draws
    // from, so what it shows and what this writes can't disagree.
    const now = playheadNow();
    // Every row the timeline draws is a catalog property (verified for every
    // layer kind); a row that is not (a stale row of a vanished node) does nothing.
    void propertyKeyToggleEdit(trackId, prop, now);
  };
  /**
   * A static property row's stopwatch (the AE gesture): create the first
   * keyframe(s) at the playhead holding the property's CURRENT static value,
   * turning the placeholder into a live animated row.
   */
  const handlePropertyStopwatch = (trackId: string, props: ReadonlyArray<string>): void => {
    // B4: the layer's lock and whether its mask shape is keyed, from the mirror.
    const m = documentMirror();
    const layer = m.layer(trackId);
    if (!layer || layer.switches.locked) return;
    const now = playheadNow();
    // The mask row is not a numeric track: its keyframes are whole-mask
    // snapshots kept on the scene graph — the first mask's Path addresses them
    // all through the engine (`setAnimated`).
    if (props[0] === MASK_ANIM_PROP) {
      // A row that exists only while the layer has a mask, so there is always
      // a first mask to address.
      void maskShapeStopwatchEdit(trackId, mirrorMaskShapeKeyed(m, trackId), now);
      return;
    }
    // The stopwatch is lit when animated, so clicking it means "turn this off" —
    // the same control both ways, as in AE. It used to only ever create, so the
    // timeline could start an animation but never end one.
    void propertyStopwatchEdit(trackId, props, now);
  };

  /**
   * The timeline's value fields — AE shows a live, scrubbable value beside every
   * property, so an animation can be built without crossing to the inspector.
   *
   * Reads at COMPOSITION time, as every write below sends it: the engine maps
   * it onto each property's key axis (the mirror's values are evaluated there).
   * Reading one axis and writing another is what made a value set at 5s appear
   * to overwrite the keyframe at 1s.
   */
  /**
   * The timeline's value fields show what the Properties panel shows: a
   * property stored as a fraction with `displayScale: 100` in the registry
   * (Scale, fill / stroke opacities…) reads in percent. The row already drew
   * the `%` unit over the RAW value, so Scale read "1 %" — and typing 50 there
   * would have set a scale of 5000 %. Converted here, at the field's boundary,
   * both ways; everything behind it (the scrub snapshot, the writes) stays raw.
   */
  const displayScaleOf = (trackId: string, prop: string): number => {
    const m = documentMirror();
    const scale = mirrorPropertyMeta(prop, m.layer(trackId), m.tree(trackId)).displayScale;
    return typeof scale === 'number' && scale > 0 ? scale : 1;
  };
  const handlePropertyValue = (trackId: string, prop: string): number =>
    propertyValueAt(trackId, prop, playheadNow()) * displayScaleOf(trackId, prop);

  /**
   * Proportional Scrubbing (AE 26.2).
   *
   * While a value field is being dragged and its property is one of SEVERAL
   * selected, the drag's delta is spread across the whole selection — 0 % at
   * the first-selected, 100 % at the last — so one drag cascades ten layers.
   * The snapshot is taken at scrub START (see `ValueField.onScrubStart`): a
   * scrub is relative to where things were, and reading the live values
   * mid-drag would compound the ramp on every pointer move.
   */
  const scrubRef = useRef<null | {
    trackId: string;
    prop: string;
    entries: ReadonlyArray<{ nodeId: string; prop: string }>;
    starts: Map<string, number>;
  }>(null);
  /** True between a value field's scrub start and end (a single-row scrub has no `scrubRef`). */
  const scrubbingNow = useRef(false);
  const valueGesture = useGesture();
  const handlePropertyScrubStart = (trackId: string, prop: string): void => {
    scrubbingNow.current = true;
    const sel = usePropertySelectionStore.getState();
    const inSelection = sel.has({ nodeId: trackId, prop });
    if (!inSelection || sel.entries.length < 2) {
      scrubRef.current = null;
      return;
    }
    const now = playheadNow();
    const starts = new Map<string, number>();
    for (const e of sel.entries) starts.set(propertyKey(e), propertyValueAt(e.nodeId, e.prop, now));
    scrubRef.current = { trackId, prop, entries: sel.entries, starts };
  };
  const handlePropertyScrubEnd = (): void => {
    scrubRef.current = null;
    scrubbingNow.current = false;
    if (valueGesture.isActive()) void valueGesture.end();
  };

  /**
   * The value fields' writes through the engine (B3): one `edit` for a typed
   * value, one GESTURE for a scrub — begun on the first move, ended by
   * `handlePropertyScrubEnd` — so a drag is one undo entry however many moves
   * (the legacy path glued them with a merge key). Each message carries the
   * absolute values for the current pointer position; a distributed scrub
   * sends every layer's write in one message.
   */
  const writePropertyValues = (writes: ReadonlyArray<{ nodeId: string; prop: string; value: number }>, scrubbing: boolean): void => {
    const seconds = playheadNow();
    const autoKeyframe = usePreferenceStore.getState().timelineAutoKeyframe;
    const cmds: Command[] = [];
    for (const w of writes) {
      // Null: not a property of that layer any more (a stale row) — nothing to write.
      const c = propertyValueCommands(w.nodeId, w.prop, w.value, seconds, autoKeyframe);
      if (c === null) return;
      cmds.push(...c);
    }
    if (cmds.length === 0) return;
    const label = `Set ${writes[0]!.prop}`;
    if (scrubbing) {
      if (!valueGesture.isActive()) valueGesture.begin(label);
      valueGesture.send(cmds);
      return;
    }
    void edit(label, cmds);
  };

  const handlePropertyValueChange = (trackId: string, prop: string, shown: number): void => {
    // The field hands back what it showed (see handlePropertyValue).
    const value = shown / displayScaleOf(trackId, prop);
    const scrub = scrubRef.current;
    if (scrub && scrub.trackId === trackId && scrub.prop === prop) {
      const start = scrub.starts.get(propertyKey({ nodeId: trackId, prop }));
      if (start !== undefined) {
        const proportional = usePropertySelectionStore.getState().proportional;
        writePropertyValues(
          distributeScrub(scrub.entries, scrub.starts, value - start, proportional).map(({ ref, value: v }) => ({ nodeId: ref.nodeId, prop: ref.prop, value: v })),
          true,
        );
        return;
      }
    }
    writePropertyValues([{ nodeId: trackId, prop, value }], scrubbingNow.current);
  };

  const handleKeyframeContextMenu = (kfId: string, x: number, y: number): void => {
    // The key from the document mirror (B4).
    const hit = resolveSelectionKey(documentMirror(), kfId);
    if (!hit) return;
    const currentKf = hit.key;
    // Scalar tracks spell hold 'step' when the engine writes it; both sample as a hold.
    const isHold = currentKf.easing === 'hold' || currentKf.easing === 'step';
    const isRoving = currentKf.roving;

    // Every entry acts on the whole keyframe selection when the clicked
    // keyframe is part of it (AE behavior), else on just this keyframe — ease,
    // interpolation, hold, roving, copy and delete alike.
    const selectedKfIds = useKeyframeSelectionStore.getState().ids;
    const easeTargets: string[] = selectedKfIds.has(kfId) ? [...selectedKfIds] : [kfId];
    // `updateKeyframes` through the engine (B3) — the whole key, as in AE.
    const ease = (preset: EasingPreset) => () => { void easePresetOnKeys(easeTargets, preset); };

    /**
     * Set one interpolation KIND on this keyframe (`updateKeyframes` easing).
     *
     * Not the preset path: that maps AE's five preset NAMES onto bezier
     * handles, and Auto Bezier / Continuous Bezier are neither presets nor
     * handle shapes — they are easing kinds the sampler derives tangents for
     * (a key with no handles gets the default ones seeded). Routing them
     * through the preset path would silently write a plain bezier and the
     * keyframe would stop auto-adjusting to its neighbours.
     */
    const setInterp = (kind: EasingKind, label: string) => () => {
      void setKeyInterpolationEdit(easeTargets, kind, label);
    };

    openContextMenu(x, y, [
      { id: 'easy-ease', label: 'Easy Ease', shortcut: 'F9', onSelect: ease('Ease') },
      { id: 'ease-in', label: 'Easy Ease In', shortcut: 'Shift+F9', onSelect: ease('EaseIn') },
      { id: 'ease-out', label: 'Easy Ease Out', shortcut: 'Ctrl+Shift+F9', onSelect: ease('EaseOut') },
      {
        /**
         * AE's Keyframe Interpolation submenu. The inspector row menu has had
         * an interpolation submenu since it shipped; the timeline diamond —
         * the surface people actually right-click — offered four flat easing
         * entries and a hold toggle, and no way to reach Auto or Continuous
         * Bezier at all despite both being live in the sampler.
         *
         * The flat "Enable/Disable Hold" and "Enable/Disable Roving" entries
         * moved IN here rather than being duplicated: both are interpolation
         * choices (roving decides whether the keyframe's time is authored or
         * solved for constant speed), and two doors to one toggle in one menu
         * is how a user ends up thinking they are two different things.
         */
        id: 'interpolation',
        label: 'Keyframe Interpolation',
        children: [
          { id: 'interp-linear', label: 'Linear', onSelect: setInterp('linear', 'Linear interpolation') },
          { id: 'interp-bezier', label: 'Bezier', onSelect: setInterp('bezier', 'Bezier interpolation') },
          { id: 'interp-auto', label: 'Auto Bezier', onSelect: setInterp('autoBezier', 'Auto bezier interpolation') },
          {
            id: 'interp-continuous',
            label: 'Continuous Bezier',
            onSelect: setInterp('continuousBezier', 'Continuous bezier interpolation'),
          },
          {
            // Toggles, because that is what the flat entry it replaces did:
            // choosing Hold on a keyframe that already holds is how you get
            // back to interpolating.
            id: 'interp-hold',
            label: isHold ? 'Hold ✓' : 'Hold',
            onSelect: isHold
              ? setInterp('linear', 'Disable hold keyframe')
              : setInterp('hold', 'Enable hold keyframe'),
          },
          { id: 'interp-sep', separator: true },
          {
            id: 'interp-roving',
            label: isRoving ? 'Rove Across Time ✓' : 'Rove Across Time',
            onSelect: () => {
              // The engine re-times the roving run for constant speed.
              void setKeyRovingEdit(easeTargets, !isRoving);
            },
          },
        ],
      },
      ...(hasPositionKeys(documentMirror(), hit.sel.layer)
        ? [
            {
              /*
               * The layer's motion path as a whole (they were two buttons in the
               * viewer's transport row): Auto-Bezier smooths it through every
               * Position key, Straighten drops the spatial tangents. One undo each.
               */
              id: 'motion-path',
              label: 'Motion Path',
              children: [
                {
                  id: 'motion-path-smooth',
                  label: 'Smooth (Auto-Bezier)',
                  onSelect: () => {
                    const layer = hit.sel.layer;
                    void editPositionKeys(layer, 'Smooth motion path', (scratch) => smoothPositionPath(layer, scratch));
                  },
                },
                {
                  id: 'motion-path-straighten',
                  label: 'Straighten',
                  disabled: !hasPositionTangents(documentMirror(), hit.sel.layer),
                  onSelect: () => {
                    const layer = hit.sel.layer;
                    void editPositionKeys(layer, 'Straighten motion path', (scratch) => straightenPositionPath(layer, scratch));
                  },
                },
              ],
            },
          ]
        : []),
      {
        // The speed-graph maths was drag-only. A number you can type is the
        // whole reason AE ships this dialog — see KeyframeVelocityDialog.
        id: 'velocity',
        label: 'Keyframe Velocity…',
        onSelect: () => {
          // The dialog shapes the row's member curve(s) on the stored axis (keyframeVelocity).
          const layer = hit.sel.layer;
          if (!openKeyframeVelocityDialog(layer, hit.rowProp, storedTimeOf(layer)(hit.key))) {
            useUIStore.getState().notify({
              level: 'info',
              message: 'A lone keyframe has no segment to shape.',
              durationMs: 2600,
            });
          }
        },
      },
      { id: 'sep-ease', separator: true },
      {
        // Navigation from the menu that is already open on a keyframe: the J/K
        // chords do this, but nothing said so anywhere a pointer can reach.
        id: 'goto-prev-kf',
        label: 'Go to Previous Keyframe',
        shortcut: 'J',
        onSelect: () => goToPrevKeyframe(),
      },
      {
        id: 'goto-next-kf',
        label: 'Go to Next Keyframe',
        shortcut: 'K',
        onSelect: () => goToNextKeyframe(),
      },
      { id: 'sep-nav', separator: true },
      {
        id: 'copy',
        label: `Copy Keyframe${easeTargets.length > 1 ? 's' : ''}`,
        shortcut: 'Ctrl+C',
        onSelect: () => { void copyKeyframes(new Set(easeTargets)); },
      },
      {
        id: 'paste',
        label: 'Paste at Playhead',
        shortcut: 'Ctrl+V',
        onSelect: () => {
          const targets = useSelectionStore.getState().ids;
          if (targets.length > 0) void pasteKeyframesAt(targets, playheadSeconds());
        },
      },
      {
        id: 'delete',
        label: `Delete Keyframe${easeTargets.length > 1 ? 's' : ''}`,
        danger: true,
        onSelect: () => { void deleteKeyframesUi(easeTargets); },
      },
    ]);
  };

  // ── Clip editing (Timeline Engine layers) ─────────────────────────
  // Through the engine API (B3): one undo entry per release, bar geometry
  // computed with the timeline's own clip math — see layout/Timeline/timelineEdits.
  const handleClipMove = (clipId: string, start: number): void => {
    void moveBar(clipId, start);
  };
  // A multi-row drag or a stagger: one undo entry for the whole gesture.
  const handleClipMoveMany = (
    moves: ReadonlyArray<{ clipId: string; start: number }>,
    label?: string,
  ): void => {
    void moveBars(moves, label);
  };
  const handleClipTrim = (clipId: string, edge: 'start' | 'end', time: number, opts?: { ripple?: boolean }): void => {
    void trimBar(clipId, edge, time, opts);
  };
  const handleClipSlip = (clipId: string, sourceInSec: number): void => {
    void slipBar(clipId, sourceInSec);
  };
  const handleClipSlide = (clipId: string, startSec: number): void => {
    void slideBar(clipId, startSec);
  };
  /**
   * Is there a clip after this one on the same track?
   *
   * "Close the gap" only means something if something can move into it — with
   * nothing later on the track it is an identical delete wearing a longer name,
   * which is half of what made two delete entries confusing.
   */
  /**
   * B4: a timeline clip id's bar in the ACTIVE composition and that composition's bars, from the mirror's layer
   * timings (`clipBars.ts`, the controller's bars: one per layer, none inside a group), in frames of its rate. A
   * composition has ONE track, so "the same track" is the composition.
   */
  const activeCompBars = (clipId: string): { bar: MirrorBar | null; bars: MirrorBar[] } => {
    const m = documentMirror();
    const comp = activeCompIdNow();
    const fps = settingsFps(comp ? m.comp(comp)?.settings : undefined);
    const nodeId = barOf(clipId)?.nodeId;
    const bar = comp && nodeId && m.layer(nodeId)?.comp === comp ? mirrorBarOf(m, nodeId, fps) : null;
    return { bar, bars: bar ? mirrorCompBars(m, comp, fps) : [] };
  };
  const hasLaterClipOnTrack = (clipId: string): boolean => {
    const { bar, bars } = activeCompBars(clipId);
    if (!bar) return false;
    return bars.some((l) => l.nodeId !== bar.nodeId && l.start >= bar.end);
  };

  const handleClipContextMenu = (clipId: string, x: number, y: number): void => {
    const { bar: layer, bars: compBars } = activeCompBars(clipId);
    const nodeId = layer?.nodeId;
    // B4: the layer's source item and its time config (Reverse = a negative stretch, Freeze Frame) from the mirror.
    const m = documentMirror();
    const mirrorLayer = nodeId ? m.layer(nodeId) : undefined;
    const assetId = mirrorLayer?.source && m.item(mirrorLayer.source)?.kind === 'footage' ? mirrorLayer.source : undefined;
    // B4: Interpret Footage takes the item as the page's asset record, built from the mirror's ItemInfo
    // (its interpretation, media type and media URL).
    const assetInfo = assetId ? m.item(assetId) : undefined;
    const asset = assetInfo ? itemAsset(assetInfo) : null;
    const time = mirrorLayer ? { reverse: mirrorLayer.timing.stretch < 0, freeze: mirrorLayer.timing.freeze !== undefined } : null;

    /*
     * The cut this clip takes part in, if any.
     *
     * Addressed by SCENE NODE and searched across the whole comp, not along one
     * track, for the reason `clipCuts` documents at length: splitting clones the
     * node, so the two halves of a cut land on two ADJACENT ROWS rather than on
     * one, and a same-track search finds nothing at exactly the moment the user
     * has just made the cut they want to soften.
     *
     * The clip's OUT-point wins when it has neighbours on both sides. That is
     * the cut a right-click on a bar most often means — you reach for a
     * dissolve while thinking about where this shot ends — and offering both
     * would need two submenus that are indistinguishable in the menu.
     */
    const others = compBars.filter((l) => l.nodeId !== nodeId);
    /*
     * "Abuts" is not enough on its own: once a cross dissolve is applied the two
     * bars OVERLAP by the transition's length, so a search for a seam finds
     * nothing at exactly the cut the user is right-clicking to remove one from.
     * A neighbour is therefore any bar that starts inside this one and carries
     * on past its end (or, before it, ends inside this one having started
     * earlier) — which covers the touching case and the overlapped one with the
     * same test. The nearest to the out-point (or in-point) wins.
     */
    const nearest = <T,>(list: T[], distance: (item: T) => number): T | undefined =>
      list.slice().sort((a, b) => distance(a) - distance(b))[0];
    const neighbourAfter = layer
      ? nearest(
          others.filter((l) => l.start > layer.start && l.start <= layer.end && l.end > layer.end),
          (l) => Math.abs(l.start - layer.end),
        )
      : undefined;
    const neighbourBefore = layer
      ? nearest(
          others.filter((l) => l.end < layer.end && l.end >= layer.start && l.start < layer.start),
          (l) => Math.abs(l.end - layer.start),
        )
      : undefined;
    const cut =
      nodeId && neighbourAfter
        ? { leftNodeId: nodeId, rightNodeId: neighbourAfter.nodeId }
        : nodeId && neighbourBefore
          ? { leftNodeId: neighbourBefore.nodeId, rightNodeId: nodeId }
          : null;
    // B4: the cut's transition from the mirror (`MirrorComp.transitions`, the API's records).
    const atCut = cut ? mirrorTransitionAtCut(m, mirrorCompIdForTransition(m, cut), cut.leftNodeId, cut.rightNodeId) : undefined;
    const existingTransition = atCut
      ? { id: atCut.id, leftNodeId: atCut.left, kind: atCut.kind, alignment: atCut.alignment }
      : undefined;

    openContextMenu(x, y, [
      {
        id: 'split',
        label: 'Split Layer at Playhead (Ctrl+Shift+D)',
        onSelect: () => {
          // Every bar has a layer behind it (syncFromScene seeds bars only from
          // layers, and removes a bar whose layer goes), so there is no bar-only path.
          if (nodeId) void splitLayersAt([nodeId], playheadSeconds());
        },
      },
      {
        id: 'trim-in',
        label: 'Trim In to Playhead (Alt+[)',
        onSelect: () => {
          if (nodeId) void trimSelectedStartToPlayhead([nodeId]);
        },
      },
      {
        id: 'trim-out',
        label: 'Trim Out to Playhead (Alt+])',
        onSelect: () => {
          if (nodeId) void trimSelectedEndToPlayhead([nodeId]);
        },
      },
      {
        id: 'ripple-trim-out',
        label: 'Ripple Trim Out to Playhead',
        onSelect: () => {
          // A composition has ONE track, so the clip's track IS the comp: the
          // engine's ripple set (every later layer) is the legacy one.
          void rippleTrimToPlayhead(clipId, 'end');
        },
      },
      {
        id: 'ripple-trim-in',
        label: 'Ripple Trim In to Playhead',
        onSelect: () => {
          void rippleTrimToPlayhead(clipId, 'start');
        },
      },
      {
        id: 'ripple-insert',
        label: 'Ripple Insert 1s Gap at Playhead',
        onSelect: () => {
          void rippleInsertGapAtPlayhead(clipId, 1);
        },
      },
      { id: 'sep-remove', separator: true },
      /*
       * Ripple Delete / Lift / Extract.
       *
       * Built by `clipRippleMenuItems` rather than spelled out here: the three
       * differ only in whether the gap closes, and that distinction is worth
       * exactly one home. See `layout/Timeline/clipEditCommands.ts` — the same
       * module registers the commands behind them, so the palette, the menus
       * and Shift+Delete cannot drift apart from this menu.
       */
      ...clipRippleMenuItems(clipId, bumpScene),
      { id: 'sep-time', separator: true },
      {
        id: 'time-stretch',
        label: 'Time Stretch…',
        disabled: !nodeId,
        onSelect: async () => {
          if (!nodeId || !time) return;
          const raw = await customPrompt('Time Stretch', 'Enter new stretch percentage (100% = original speed):', String(mirrorStretchPercent(documentMirror(), nodeId)));
          if (raw !== null) {
            const parsed = parseFloat(raw);
            // The shared path: footage changes rate; any other layer bakes bar,
            // keys and markers (negative = reverse). One undo step either way.
            const allowed = retimableLayerIds(documentMirror(), [nodeId]).length > 0 ? parsed >= 1 : parsed !== 0;
            if (!isNaN(parsed) && allowed && Math.abs(parsed) <= 1000) {
              void timeStretchEdit([nodeId], parsed, 'in', playheadSeconds());
            }
          }
        },
      },
      {
        id: 'time-reverse',
        label: time?.reverse ? 'Restore Forward Playback' : 'Time-Reverse Layer',
        disabled: !nodeId,
        onSelect: () => {
          if (!nodeId || !time) return;
          void timeReverseEdit(nodeId);
        },
      },
      {
        id: 'freeze-frame',
        label: time?.freeze ? 'Unfreeze Frame' : 'Freeze Frame at Playhead',
        disabled: !nodeId,
        onSelect: () => {
          if (!nodeId || !time) return;
          if (!time.freeze) {
            void freezeFrameEdit(nodeId, playheadSeconds());
            return;
          }
          void unfreezeEdit([nodeId]);
        },
      },
      ...(asset
        ? [
            { id: 'sep-footage', separator: true },
            {
              id: 'interpret-footage',
              label: 'Interpret Footage… (Ctrl+Alt+G)',
              onSelect: () => openInterpretFootage(asset),
            },
            // AE's Layer ▸ Scene Edit Detection. Video only: a still has no cuts.
            // B4-kept: an engine job run from the UI (decodes the clip's pixels) — not registered as an engine job yet (G).
            ...(asset.type === 'video' && nodeId
              ? [
                  {
                    id: 'scene-edit-markers',
                    label: 'Scene Edit Detection → Markers',
                    onSelect: () => void runSceneEditDetection(nodeId, 'markers'),
                  },
                  {
                    id: 'scene-edit-split',
                    label: 'Scene Edit Detection → Split Clips',
                    onSelect: () => void runSceneEditDetection(nodeId, 'split'),
                  },
                ]
              : []),
          ]
        : []),
      { id: 'sep-transition', separator: true },
      /*
       * Transitions.
       *
       * A submenu rather than four flat rows: the four kinds are variants of one
       * act, and flattening them would push five unrelated items apart in a menu
       * that is already long. Present-but-DISABLED when the clip has no
       * neighbour, rather than hidden — "why is there no transition command
       * here" is a question the greyed row answers and an absent one does not.
       */
      /*
       * The Library's layer transitions, on this layer's own edges — the same
       * act as dropping a card on the bar's start or end. Solid-inserting
       * recipes are left out: they never target a layer.
       */
      ...(['in', 'out'] as const).map((edge) => ({
        id: `layer-transition-${edge}`,
        label: edge === 'in' ? 'Transition In' : 'Transition Out',
        disabled: !nodeId,
        children: TRANSITION_ITEMS.filter((t) => !t.solidOnly).map((t) => ({
          id: `layer-transition-${edge}-${t.id}`,
          label: t.name,
          onSelect: () => {
            if (nodeId) handleLayerTransitionDrop(t.id, nodeId, edge);
          },
        })),
      })),
      {
        id: 'add-transition',
        label: 'Transition at Cut',
        disabled: !cut,
        children: TRANSITION_KINDS.map((kind) => ({
          id: `add-transition-${kind}`,
          label: TRANSITION_LABEL[kind],
          onSelect: () => {
            if (!cut) return;
            void addTransitionEdit(
              cut.leftNodeId,
              cut.rightNodeId,
              kind,
              DEFAULT_TRANSITION_FRAMES,
              'centred',
            ).then((res) => {
              if (!res.ok) void customAlert('Transition', res.reason);
            });
          },
        })),
      },
      ...(existingTransition && cut
        ? [
            /*
             * Alignment — where the transition sits relative to the cut.
             *
             * The record has carried this since transitions shipped and every
             * entry point wrote 'centred', so the other two placements existed
             * only in the type. A submenu of three named values next to the
             * bracket's click-to-cycle: the same property, picked rather than
             * stepped, for when you know which one you want. One undo entry
             * each, because `setTransition` re-materializes the transition
             * inside a single history entry.
             */
            {
              id: 'transition-alignment',
              label: 'Alignment',
              children: TRANSITION_ALIGNMENTS.map((alignment) => ({
                id: `transition-alignment-${alignment}`,
                label: `${TRANSITION_ALIGNMENT_LABEL[alignment]}${
                  existingTransition.alignment === alignment ? '  ✓' : ''
                }`,
                onSelect: () => {
                  if (existingTransition.alignment === alignment) return;
                  void setTransitionEdit(existingTransition.leftNodeId, existingTransition.id, {
                    alignment,
                  }).then((res) => {
                    if (!res.ok) void customAlert('Transition', res.reason);
                  });
                },
              })),
            },
            {
              id: 'remove-transition',
              label: `Remove ${TRANSITION_LABEL[existingTransition.kind]}`,
              onSelect: () => {
                void removeTransitionsEdit([existingTransition.id]);
              },
            },
          ]
        : []),
      /*
       * The five timeline edit tools, reachable from the menu too.
       *
       * They have no chord (Shift+S / R / U are AE's add-to-reveal keys) and
       * live in the timeline's View ▾ menu; a right-click on the very bar these
       * gestures act on is where someone asks "can I move just the cut?", so
       * the answer belongs here as well. `TIMELINE_EDIT_MODES` is the one
       * source for the labels, so a mode cannot exist in one menu and not here.
       */
      {
        id: 'edit-mode',
        label: 'Timeline Tool',
        children: TIMELINE_EDIT_MODES.map((def) => ({
          id: `edit-mode-${def.mode}`,
          label: `${def.label}${getTimelineEditMode() === def.mode ? '  ✓' : ''}`,
          onSelect: () => setTimelineEditMode(def.mode),
        })),
      },
      { id: 'sep-del', separator: true },
      /*
       * Two deletes, and they have to read as genuinely different things.
       *
       * They used to be "Delete Clip (Del)" and "Ripple Delete Clip", which is
       * one word apart and looks like the same command twice — and NEITHER of
       * them deleted the layer. Both removed only the clip BAR, leaving the
       * scene node behind, so the timeline row stayed with nothing on it and
       * the next `syncFromScene` seeded it a fresh full-length bar. The layer
       * came back, which is why deleting from the Scene tree "worked" and
       * deleting from the timeline did not.
       *
       * Now both remove the layer for real. The only difference is what
       * happens to the TIME the layer occupied, which is what the labels say.
       */
      {
        id: 'delete',
        label: 'Delete Layer (Del)',
        danger: true,
        onSelect: () => {
          void deleteClipLayerEdit(nodeId, false);
        },
      },
      {
        id: 'ripple-delete',
        label: 'Delete Layer and Close Gap',
        danger: true,
        // Only meaningful when something later on the track can move left into
        // the space. Otherwise it is the entry above under a longer name.
        disabled: !hasLaterClipOnTrack(clipId),
        onSelect: () => {
          void deleteClipLayerEdit(nodeId, true);
        },
      },
    ]);
  };

  // The Modes column and the pick-whip (B3: `setLayersBlend`, `setLayerMatte`,
  // `setParent`), and the switch verbs (`@core/scene/layerFlags`).
  const handleTrackBlendModeChange = (trackId: string, mode: Parameters<typeof setLayersBlend>[1]): void => {
    setLayersBlend([trackId], mode);
  };
  const handleTrackMatteChange = (trackId: string, matte: Parameters<typeof setLayerMatte>[1]): void => {
    setLayerMatte(trackId, matte);
  };
  const handleTrackParentChange = (trackId: string, parentId: string | null, options?: { preserveWorld?: boolean; jump?: boolean }): void => {
    // `setParent` (B3): the pick-whip / dropdown keep the world pose unless
    // the row asked otherwise (Alt); Shift = Parent & Link JUMP (B3z: onto the
    // parent's anchor at the playhead).
    const jump = options?.jump === true && parentId !== null;
    void edit(parentId ? 'Parent' : 'Unparent', {
      type: 'setParent',
      layers: [trackId],
      ...(parentId ? { parent: parentId } : {}),
      keepWorldTransform: options?.preserveWorld ?? true,
      ...(jump ? { jump: true, time: compTime(playheadSeconds()) } : {}),
    });
  };
  const handleTrackToggleFlag = (trackId: string, flag: Parameters<typeof toggleLayerFlagEdit>[1] | 'collapse'): void => {
    // `collapse` never arrives: `TrackHeaderColumn` calls
    // `toggleCollapseSwitch` itself (it means two things by layer kind).
    if (flag === 'collapse') return;
    void toggleLayerFlagEdit(trackId, flag);
  };

  /**
   * A Library layer transition dropped on a bar's start or end: that layer's
   * entrance (from its in-point) or exit (ending at its out-point), keyed by
   * the Library's recipe — one undo entry.
   */
  const handleLayerTransitionDrop = (transId: string, trackId: string, edge: 'in' | 'out'): void => {
    const item = getTransitionItem(transId);
    const layer = documentMirror().layer(trackId);
    if (!item || !layer) return;
    const inSec = flicksToSeconds(layer.timing.inPoint);
    const outSec = flicksToSeconds(layer.timing.outPoint);
    const time = edge === 'in' ? inSec : Math.max(inSec, outSec - item.duration);
    void applyTransitionEdit(transId, `Apply ${item.name}`, { layer: trackId, time }).then((result) => {
      const notify = useUIStore.getState().notify;
      if (!result) {
        notify({ level: 'warning', message: item.solidOnly ? `${item.name} inserts a solid — click it in the Library instead` : `Could not apply ${item.name}`, durationMs: 2600 });
        return;
      }
      notify({ level: 'success', message: `${item.name} ${edge === 'in' ? 'entrance' : 'exit'} on ${layer.name}`, durationMs: 1800 });
    });
  };

  return {
    handleLayerTransitionDrop,
    selectedPropertyKeys,
    handlePropertySelect,
    toggleTrackVisible,
    toggleTrackLock,
    toggleTrackSolo,
    handleScrub,
    handleTrackSelect,
    handleTrackSelectMany,
    handleTrackRename,
    handleClipMuteToggle,
    handleTrackActivate,
    handleTrackReorder,
    handleKeyframeSeek,
    handleKeyframeMove,
    handleKeyframesMove,
    handleKeyframesDelete,
    handleKeyframeContextMenu,
    handlePropertyKeyframeToggle,
    handlePropertyStopwatch,
    handlePropertyValue,
    handlePropertyValueChange,
    handlePropertyScrubStart,
    handlePropertyScrubEnd,
    handleClipMove,
    handleClipMoveMany,
    handleClipTrim,
    handleClipSlip,
    handleClipSlide,
    handleClipContextMenu,
    handleTrackBlendModeChange,
    handleTrackMatteChange,
    handleTrackParentChange,
    handleTrackToggleFlag,
  };
}

export type TimelineHandlers = ReturnType<typeof useTimelineHandlers>;

/** The handlers as `<BottomTimeline>` props — one list for both timelines. */
export function timelineHandlerProps(h: TimelineHandlers) {
  return {
    onScrub: h.handleScrub,
    onClipMove: h.handleClipMove,
    onClipMoveMany: h.handleClipMoveMany,
    onClipTrim: h.handleClipTrim,
    onLayerTransitionDrop: h.handleLayerTransitionDrop,
    onClipSlip: h.handleClipSlip,
    onClipSlide: h.handleClipSlide,
    onClipContextMenu: h.handleClipContextMenu,
    onTrackSelect: h.handleTrackSelect,
    onTrackSelectMany: h.handleTrackSelectMany,
    onTrackToggleVisible: h.toggleTrackVisible,
    onTrackToggleLock: h.toggleTrackLock,
    onTrackToggleSolo: h.toggleTrackSolo,
    onTrackBlendModeChange: h.handleTrackBlendModeChange,
    onTrackMatteChange: h.handleTrackMatteChange,
    onTrackParentChange: h.handleTrackParentChange,
    onTrackToggleFlag: h.handleTrackToggleFlag,
    onKeyframeSeek: h.handleKeyframeSeek,
    onKeyframeMove: h.handleKeyframeMove,
    onKeyframesMove: h.handleKeyframesMove,
    onKeyframesDelete: h.handleKeyframesDelete,
    onKeyframeContextMenu: h.handleKeyframeContextMenu,
    onPropertyKeyframeToggle: h.handlePropertyKeyframeToggle,
    onPropertyStopwatch: h.handlePropertyStopwatch,
    onPropertyValue: h.handlePropertyValue,
    onPropertyValueChange: h.handlePropertyValueChange,
    onPropertyScrubStart: h.handlePropertyScrubStart,
    onPropertyScrubEnd: h.handlePropertyScrubEnd,
    selectedPropertyKeys: h.selectedPropertyKeys,
    onPropertySelect: h.handlePropertySelect,
    onTrackActivate: h.handleTrackActivate,
    onClipMuteToggle: h.handleClipMuteToggle,
    onTrackRename: h.handleTrackRename,
    onTrackReorder: h.handleTrackReorder,
    onTrackColorChange: (trackId: string, color: string | undefined) => { if (color) setNodeColor(trackId, color); },
  };
}
