/**
 * App — the application root.
 *
 * Lifecycle:
 *   1. Providers boot the Application core and wire the built-in commands.
 *   2. We register the demo panels in the layout store.
 *   3. We render the editor: toolbar, layout, status bar.
 *
 * Engine integration points:
 *   - Register additional panels: `useLayoutStore.getState.registerPanel(...)`
 *   - Mount a rendering engine: call `useLayoutStore.setState` or use the
 *     layout-registered WorkspaceViewport selector `[data-workspace-viewport]`.
 *   - Push timeline data: pass a `model` prop to <BottomTimeline />.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { clampPps } from '@layout/Timeline/zoomAnchor';
import { Providers } from '@providers/Providers';
import { useLayoutStore, consumeLayoutMigration } from '@stores/layoutStore';
import { reconcileActiveWorkspace } from '@core/layout/workspaceManager';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { getTime as playheadNow } from '@stores/playbackClockStore';
import { usePlaybackClock } from '@layout/Timeline/usePlaybackClock';
import { useTimelineKeys } from '@layout/Timeline/useTimelineKeys';
import { documentMirror } from '@stores/documentMirror';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { resolveSelectionKey } from '@core/mirror/keySelection';
import { fetchMemberTracks, memberTracksNow } from '@stores/memberTracks';
import { setWorkArea as setTimelineWorkArea } from '@layout/Timeline/timelineEdits';
import { addKeyframesForSelectionEdit } from '@layout/Menu/appEdits';
import { type TimelineRow } from '@motion/engine-api';
import { useSpaceTransport } from '@hooks/useSpaceTransport';
import { playheadSeconds, setTimelinePixelsPerSecond, setTimelineScrollPixels } from '@core/timeline/timelineView';
import { MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { fetchTimelineRows, timelineRowsNow } from '@stores/timelineRows';
import { modifiedRowsOf } from '@layout/Timeline/modifiedRows';
import { useTimelinePixelsPerSecond, useTimelineRuler, useTimelineTracks } from '@layout/Timeline/useTimelineModel';
import { timelineHandlerProps, useTimelineHandlers } from '@layout/Timeline/useTimelineHandlers';
import { bindAdaptiveResolution } from '@stores/renderQualityStore';
import { EditorLayout } from '@layout/EditorLayout';

import { EditorStatusBar } from '@layout/StatusBar';
import { getEventBus } from '@core/events/EventBus';
import { BottomTimeline } from '@layout/BottomTimeline';
import { TopNav } from '@layout/TopNav';
import { AiChatProvider } from '@layout/AiChat/AiChatContext';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { availablePanelDefs } from '@layout/EditorLayout/panelDefs';
import type { TimelineModel, TimelineTrack } from '@layout/Timeline';
import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { AUDIO_WAVEFORM_ROW } from '@core/timeline/propertyTree';
import { AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP } from '@core/audio/audioParams';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { useResponsiveLayout } from '@hooks/useResponsiveLayout';

/** The editor UI wrapped in the AI chat provider — chat state must sit above
 *  the dock tree so switching sidebar tabs never cancels a run or rolls back a
 *  pending preview. Routing renders EditorShell directly (EditorPage), so the
 *  provider lives here, not in <App>. */
export function EditorShell(): JSX.Element {
  return (
    <AiChatProvider>
      <EditorShellInner />
    </AiChatProvider>
  );
}

/* The playhead RIGHT NOW is `playheadNow()` — `getTime` from the playback
 * clock store, read non-reactively. For event handlers: they fire at event
 * time, so a render-captured value buys them nothing — while a reactive
 * subscription in the shell re-rendered the whole editor tree every playback
 * frame just to keep that captured value fresh. The clock store is the live
 * authority during playback; the project store's copy lags by the 4Hz mirror.
 *
 * The ONE render-time consumer of the playhead in the shell is the status
 * bar's self-subscribing <StatusBarTimecode/> (`useCurrentTime`), isolated so
 * only that span re-renders per comp frame, not EditorShellInner. */
function EditorShellInner(): JSX.Element {
  const registerPanel = useLayoutStore((s) => s.registerPanel);
  const selectedIds = useSelectionStore((s) => s.ids);
  // NO document-revision subscription here. The shell used to re-render on
  // every revision of the mirror (`useMirrorRevision`), and because it hosts
  // the whole editor tree (TopNav, the dock, the timeline, every panel — few of
  // them memoized) each engine batch re-rendered the entire UI: one viewport
  // drag step = one document revision = ~600 component renders (measured by
  // `src/layout/dragRenderScope.test.tsx`). Nothing the shell renders reads the
  // document directly: the timeline model's rows subscribe to the mirror
  // themselves (Timeline/useTimelineModel), and every panel subscribes to the
  // mirror keys it reads.
  // Scalar selectors, NOT `useActiveWorkspace`.
  //
  // `useActiveWorkspace` returns the whole tab OBJECT, which immer replaces on
  // every `setTime` — 60×/s during playback. That subscription sat right next to
  // a comment claiming it had been removed for exactly this reason, so this
  // ~1200-line component (which hosts the entire editor tree, and whose children
  // are almost all unmemoized) re-rendered every playback frame. Only three
  // fields were ever read off it, and none of them change per frame.
  // (The comp title / dirty flag used to be read here for the inlined status
  // bar; they now live in ProjectStatus + EditorTabs, which subscribe themselves.)
  const activeCompId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  // NO reactive playhead subscription here. `time` changes once per comp frame
  // during playback, and a subscription re-rendered this ~1355-line shell (and
  // reconciled its entire unmemoized return tree — TopNav, dock, timeline) on
  // every single frame, starving the main thread the renderer and the <video>
  // pipeline needed. The only render-time reader was the status-bar timecode
  // (now the self-subscribing <StatusBarTimecode/>); everything else that
  // needs the playhead is an EVENT HANDLER, which reads `playheadNow()` at
  // event time — non-reactive and always current.

  const { activeSet } = useFocusContext();

  // Enable responsive UI auto-collapsing behaviors
  useResponsiveLayout();

  /*
   * There is deliberately no auto-switching of the inspector tab on selection.
   *
   * There used to be: selecting a camera, light or particle layer force-opened
   * the Settings tab, because those layers' controls lived there and the tab
   * you were on would otherwise show you nothing. Before that it was worse —
   * it switched between Transform and Style on every selection change, so
   * reading a transform and clicking a text layer yanked you to Style.
   *
   * Both were workarounds for one thing: the selected layer's properties were
   * split across three tabs. They are one panel now, so every layer kind's
   * controls are already on screen and there is nothing to switch to.
   */

  // Adaptive Resolution: the viewport degrades while ANY drag is in flight.
  // The UI store's drag flag is already set by every gizmo, scrub and value
  // field, so one subscription covers them all.
  useEffect(
    () => bindAdaptiveResolution((cb) => useUIStore.subscribe((s, prev) => {
      if (s.isDragging !== prev.isDragging) cb(s.isDragging);
    })),
    [],
  );

  // Register the default panels exactly once.
  useEffect(() => {
    // Registrations come from the SHARED registry (panelDefs.ts) so a pop-out
    // window can resolve the same titles/icons — it renders PopoutRoute, never
    // EditorShell, so it never runs this effect and used to show a raw id.
    // On-demand panels are registered (so menus/shortcuts can open them) then
    // closed unless a persisted layout already had them open.
    // `availablePanelDefs()`, not PANEL_DEFS: a panel its edition does not offer
    // must never be registered. That is the gate, not a cosmetic filter — the
    // dock renders `panelOrder.map(id => panels[id]).filter(Boolean)`, so an id
    // left over in a PERSISTED layout (or written by a workspace preset) draws
    // nothing at all once it is absent from the registry.
    const openBefore = new Set(Object.values(useLayoutStore.getState().panelOrder).flat());
    for (const p of availablePanelDefs()) {
      registerPanel({ id: p.id, title: p.title, icon: p.icon, region: p.region, weight: p.weight, closable: p.closable, onDemand: p.onDemand });
      if (p.onDemand && !openBefore.has(p.id)) useLayoutStore.getState().closePanel(p.id);
    }
    // A pre-2026-09-15 layout was migrated at load (its tab lists dropped), so
    // the panels above registered into the new defaults. If the user had a
    // specialised builtin workspace active, put ITS panels back — Color should
    // still open on Scopes — rather than silently demoting them to Default.
    if (consumeLayoutMigration()) reconcileActiveWorkspace();
  }, [registerPanel]);



  const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

  // Timeline rows from the document MIRROR (B4): one row per layer of the
  // active comp, in stack order, subscribed to exactly the records they draw
  // (the comp's stack, each layer's header and keyframes, expanded rows'
  // property trees + the throttled playhead). See Timeline/useTimelineModel.
  const tracks = useTimelineTracks(activeCompId, expandedIds);

  // Session hydration is owned by AppRouter (before any route renders), so the
  // editor must NOT re-hydrate here — doing so flips auth status to 'loading'
  // mid-session and bounces RequireAuth back to /login.

  // ── Timeline expansion (reveal animated properties) ──────────────
  // Calm by default: a layer is one row until its chevron — or the `U`
  // reveal shortcut on the selected layers — expands it (AE muscle memory).
  // AE reveal filter: which properties the sub-rows show (null = all).
  const [revealFilter, setRevealFilter] = useState<ReadonlyArray<string> | null>(null);

  // Horizontal zoom — the Timeline Engine's view is the authority (pixels/frame);
  // pps = ppf × fps. Driven by the transport zoom buttons and Ctrl+Wheel.
  const pps = useTimelinePixelsPerSecond(activeCompId);
  const handleZoom = useCallback((next: number, anchorSeconds?: number): void => {
    // Anchor on the point the gesture was aimed at, falling back to the
    // playhead when there was none (a slider, a keyboard zoom).
    setTimelinePixelsPerSecond(clampPps(next), anchorSeconds ?? playheadSeconds());
  }, []);

  const toggleExpand = useCallback((id: string): void => {
    // A manual chevron twirl always shows the FULL property tree — clear any
    // lingering U/P/S/R/T reveal filter so rows don't silently stay hidden.
    setRevealFilter(null);
    setExpandedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  // Latest tracks, read by the reveal shortcuts without re-binding the listener.
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  useEffect(() => {
    // AE reveal shortcuts, filtering which property sub-rows show:
    //   U   → toggle *animated* properties on the selected layers
    //   UU  → toggle *modified* properties (animated, expressed, or set away
    //         from the default) — see `modifiedProps.ts`
    //   P/S/R/T/A → position / scale / rotation / opacity / anchor
    //   M / F / MM → mask shape / mask feather / all mask properties
    //   E   → effects
    //   L / LL → audio levels / waveform
    //   SS  → only the SELECTED properties (or, with none selected, the
    //         properties of the selected keyframes) — AE's SS
    //   Shift+<key> → ADD that property to what is already revealed
    // Each list names every row id that property can appear as: the raw engine
    // props, the merged 'Position' pseudo-row, and the static '__static:*'
    // placeholder shown before any keyframes exist.
    //
    // Masks: the shape is ONE whole-mask track (`setMaskAnim` stores
    // snapshots); feather / opacity / expansion are per-path tracks
    // (`mask.<pathId>.<key>`, see maskPropPath). M = shape, F = feather rows,
    // MM = every mask row the property tree lists.
    const REVEAL: Record<string, ReadonlyArray<string>> = {
      p: ['x', 'y', 'z', POSITION_PSEUDO_PROP, '__static:position'],
      s: ['scale', 'scaleX', 'scaleY', '__static:scale'],
      r: ['rotation', 'rotationX', 'rotationY', '__static:rotation'],
      t: ['opacity', '__static:opacity'],
      m: [MASK_ANIM_PROP, 'mask'],
      f: [MASK_ANIM_PROP, 'mask.feather'],
      a: ['anchorX', 'anchorY', '__static:anchor'],
      // AE's L = "show only Audio Levels". This named the GROUP key ('audio'),
      // but the filter matches on a row's `prop` — so L expanded the layer and
      // then hid every row, which looked like the layer had no audio at all.
      // Both the dB track and the legacy video-layer percent are listed, so a
      // project saved before the dB migration still reveals its level.
      l: [AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP, 'audioLevel'],
    };

    // AE's LL — a second L within the double-tap window swaps the Audio group
    // for the waveform alone. Handled here rather than in ShortcutManager's
    // UU path because single L never was a command: it is this listener.
    const DOUBLE_TAP_MS = 400;
    let lastL = 0;
    let lastM = 0;
    let lastS = 0;

    /**
     * Rows of the engine's AE row projection (`getTimelineRows`) — the model only builds rows for expanded
     * tracks. The selection's projection is fetched as it changes, so a reveal key reads it synchronously.
     */
    const rowsOf = (id: string): readonly TimelineRow[] => timelineRowsNow(id) ?? [];
    const effectRows = (ids: readonly string[]): string[] => [
      ...new Set(ids.flatMap((id) => rowsOf(id).filter((r) => r.group === 'effects').map((r) => r.prop))),
    ];
    const allMaskRows = (ids: readonly string[]): string[] => [
      ...new Set([MASK_ANIM_PROP, ...ids.flatMap((id) => rowsOf(id).filter((r) => r.group === 'masks').map((r) => r.prop))]),
    ];
    const offSelection = useSelectionStore.subscribe((st, prev) => {
      if (st.ids !== prev.ids && st.ids.length > 0) void fetchTimelineRows(st.ids);
    });
    /**
     * A layer's animated member tracks (the engine's `getMemberKeyframes`: keyed tracks and
     * expressions, catalog or not) spelled the way the timeline draws them — x / y / z are ONE
     * merged Position row unless Position is separated (the mirror's `transform/position`).
     */
    const rowsOfMembers = (id: string, members: ReadonlyArray<{ member: string }>): string[] => {
      const separated = documentMirror().property(id, 'transform/position')?.separated === true;
      const rows = new Set<string>();
      for (const { member: p } of members) {
        if (!separated && (p === 'x' || p === 'y' || p === 'z')) rows.add(POSITION_PSEUDO_PROP);
        else rows.add(p);
      }
      return [...rows];
    };
    /** Shift+U: the animated rows over the last known member lists (warmed on selection, re-asked per revision). */
    const animatedRows = (ids: readonly string[]): string[] => [
      ...new Set(ids.flatMap((id) => rowsOfMembers(id, memberTracksNow(id) ?? []))),
    ];

    // AE's Alt+Shift+<prop> — add a keyframe for that property on every
    // selected layer at the playhead, enabling animation if needed. The engine
    // props each chord keys (not the reveal row ids above).
    const ADD_KEY_PROPS: Record<string, ReadonlyArray<string>> = {
      p: ['x', 'y'],
      s: ['scaleX', 'scaleY'],
      r: ['rotation'],
      t: ['opacity'],
      a: ['anchorX', 'anchorY'],
    };

    // Through the engine (B3): `addKeyframes` at the playhead's COMP time — the
    // engine puts each key on its layer's axis and holds the value the user
    // sees there, the same number the stopwatch and the value fields key.
    const addKeyframesFor = (sel: readonly string[], props: ReadonlyArray<string>): void => {
      void addKeyframesForSelectionEdit(sel, props, playheadNow());
    };

    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Alt+Shift+<prop> → add keyframe (checked before the reveal early-outs
      // because reveal ignores modified chords entirely). Read from the
      // physical key: on macOS Option changes `e.key` ("π" for P), so the
      // character never matched there.
      const codeKey = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : key;
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && ADD_KEY_PROPS[codeKey]) {
        const sel = useSelectionStore.getState().ids;
        if (sel.length === 0) return;
        e.preventDefault();
        addKeyframesFor(sel, ADD_KEY_PROPS[codeKey]!);
        // Reveal what was just keyed so the new diamond is visible.
        setRevealFilter(null);
        setExpandedIds((cur) => {
          const set = new Set(cur);
          for (const id of sel) set.add(id);
          return [...set];
        });
        return;
      }

      // Bare 'u' is the registry command (CommandSystem → RevealAnimatedProps);
      // only Shift+U — add animated props to the reveal — lands here.
      const isReveal = REVEAL[key] !== undefined || key === 'e' || (key === 'u' && e.shiftKey);
      if (!isReveal) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Expand the selection and switch which props are shown.
      const sel = useSelectionStore.getState().ids;
      if (sel.length === 0) return;
      let rows: ReadonlyArray<string> =
        key === 'e' ? effectRows(sel)
        : key === 'u' ? animatedRows(sel)
        // F: the per-path `mask.<pathId>.feather` rows (plus the shape row).
        : key === 'f' ? allMaskRows(sel).filter((p) => p === MASK_ANIM_PROP || p.endsWith('.feather'))
        : REVEAL[key]!;
      if (key === 's' && !e.shiftKey) {
        // AE's SS: a second S within the double-tap window shows only the
        // selected properties — the property rows selected in the timeline,
        // else the rows of the selected keyframes — on their layers.
        const now = Date.now();
        if (now - lastS < DOUBLE_TAP_MS) {
          lastS = 0;
          const m = documentMirror();
          const picked: Array<{ nodeId: string; prop: string }> = [...usePropertySelectionStore.getState().entries];
          if (picked.length === 0) {
            for (const kfId of useKeyframeSelectionStore.getState().ids) {
              const hit = resolveSelectionKey(m, kfId);
              if (hit) picked.push({ nodeId: hit.sel.layer, prop: hit.rowProp });
            }
          }
          if (picked.length > 0) {
            e.preventDefault();
            const soloRows = new Set<string>();
            for (const p of picked) {
              const separated = m.property(p.nodeId, 'transform/position')?.separated === true;
              soloRows.add(!separated && (p.prop === 'x' || p.prop === 'y' || p.prop === 'z') ? POSITION_PSEUDO_PROP : p.prop);
            }
            setRevealFilter([...soloRows]);
            setExpandedIds((cur) => [...new Set([...cur, ...picked.map((p) => p.nodeId)])]);
            return;
          }
        } else {
          lastS = now;
        }
      }
      if (key === 'm' && !e.shiftKey) {
        // AE's MM: a second M within the double-tap window reveals every mask
        // property; a third falls back to the shape alone.
        const now = Date.now();
        if (now - lastM < DOUBLE_TAP_MS) {
          rows = allMaskRows(sel);
          lastM = 0;
        } else {
          lastM = now;
        }
      }
      if (rows.length === 0) return;
      e.preventDefault();
      if (e.shiftKey) {
        // AE's Shift+<reveal key>: ADD to what is revealed rather than replace.
        const add = rows;
        setRevealFilter((cur) => (cur === null ? add : [...new Set([...cur, ...add])]));
        setExpandedIds((cur) => [...new Set([...cur, ...sel])]);
        return;
      }
      if (key === 'l') {
        const now = Date.now();
        // LL shows only the waveform; a third L within the window falls back to
        // the group, so the pair toggles rather than sticking on the waveform.
        if (now - lastL < DOUBLE_TAP_MS) {
          rows = [AUDIO_WAVEFORM_ROW];
          lastL = 0;
        } else {
          lastL = now;
        }
      }
      setRevealFilter(rows);
      setExpandedIds((cur) => {
        const set = new Set(cur);
        for (const id of sel) set.add(id);
        return [...set];
      });
    };
    window.addEventListener('keydown', onKey);

    const sub = getEventBus().on('RevealAnimatedProps', (evt: { nodeIds: string[], mode: 'animated' | 'modified', force?: boolean }) => {
      const { nodeIds, mode, force } = evt;
      const targetIds = nodeIds.length > 0 ? nodeIds : tracksRef.current.map(t => t.id);

      // Static placeholder rows (animated:false) are part of the always-there
      // property tree, not animation — U must ignore them, or it would expand
      // every layer and reveal the full tree instead of keyframed props only.
      const animatedProps = (id: string) =>
        (tracksRef.current.find((t) => t.id === id)?.properties ?? []).filter(
          (p) => p.animated !== false,
        );

      // A generator asking to be seen (force) reads the ENGINE, not the model:
      // it emits in the same tick as its write, and `tracksRef` still holds the
      // model from before those keyframes existed. Reading the stale model here
      // would find no animated props and expand nothing — the exact "I clicked
      // it and the timeline is unchanged" this flag is for.
      if (force) {
        // The engine's member lists, asked AFTER the generator's write has landed.
        void Promise.all(targetIds.map(async (id) => ({ id, rows: rowsOfMembers(id, await fetchMemberTracks(id)) }))).then((res) => {
          const withRows = res.filter((r) => r.rows.length > 0);
          if (!withRows.length) return;
          setRevealFilter([...new Set(withRows.flatMap((r) => r.rows))]);
          setExpandedIds((cur) => [...new Set([...cur, ...withRows.map((r) => r.id)])]);
        });
        return;
      }

      if (mode === 'modified') {
        // AE's UU: animated, expressed, OR set away from the default — read
        // from the scene and engine, not the model (which only builds rows for
        // expanded tracks and cannot see an un-keyed 50 % scale).
        // The engine's rows and stored values (layout/Timeline/modifiedRows.ts), asked now.
        const at = playheadNow();
        void Promise.all(targetIds.map(async (id: string) => ({ id, rows: await modifiedRowsOf(id, at) }))).then((all) => {
          const withRows = all.filter((v) => v.rows.length > 0);
          const filter = new Set<string>();
          for (const v of withRows) for (const r of v.rows) filter.add(r);
          setRevealFilter(filter.size > 0 ? [...filter] : null);
          setExpandedIds((cur) => {
            const revealed = targetIds.every((id: string) => cur.includes(id));
            const set = new Set(cur);
            if (revealed) for (const id of targetIds) set.delete(id);
            else for (const v of withRows) set.add(v.id);
            return [...set];
          });
        });
        return;
      }

      if (mode === 'animated') {
        /*
          Read the ENGINE, as `force` does. The model only builds property rows
          for tracks that are already EXPANDED, so asking it which props a
          COLLAPSED layer animates — the one case U exists for — always answered
          "none": select a keyframed camera, press U, nothing happened. The
          model rows are kept as a second source for anything the engine does
          not list (data tracks the model surfaces).
        */
        const enginePropsOf = async (id: string): Promise<string[]> => [
          ...new Set([...animatedProps(id).map((p) => p.prop), ...rowsOfMembers(id, await fetchMemberTracks(id))]),
        ];
        void Promise.all(targetIds.map(async (id) => [id, await enginePropsOf(id)] as const)).then((pairs) => revealAnimated(new Map(pairs)));
        return;
      }
    });

    /** U: reveal the animated rows of the target layers (or collapse them when they already are). */
    const revealAnimated = (propsById: ReadonlyMap<string, readonly string[]>): void => {
      const targetIds = [...propsById.keys()];
      {
        const animatedInTarget = targetIds.filter((id) => (propsById.get(id)?.length ?? 0) > 0);
        // Filter the revealed rows to the animated ones (AE's U shows only
        // keyframed properties; the chevron twirl shows the whole tree).
        const filter = new Set<string>();
        for (const id of animatedInTarget) for (const p of propsById.get(id) ?? []) filter.add(p);
        setRevealFilter(filter.size > 0 ? [...filter] : null);

        setExpandedIds((cur) => {
          const revealed = targetIds.every((id: string) => cur.includes(id));
          const set = new Set(cur);
          if (revealed) {
            for (const id of targetIds) set.delete(id);
          } else {
            for (const id of animatedInTarget) set.add(id);
          }
          return [...set];
        });
      }
    };

    return () => {
      window.removeEventListener('keydown', onKey);
      sub.dispose();
      offSelection();
    };
  }, []);

  // Shift+U reads the selected layers' member lists synchronously (a keydown): ask the engine for
  // them as the selection changes, so the key finds this revision's answer (or the last one).
  useEffect(() => useSelectionStore.subscribe((st) => {
    for (const id of st.ids.slice(0, 64)) memberTracksNow(id);
  }), []);

  // Mark tracks that fall outside the current Focus Mode context as ghosted.
  const focusTracks = useMemo<TimelineTrack[]>(() => {
    if (!activeSet) return tracks;
    return tracks.map((t) => ({ ...t, ghosted: !activeSet.has(t.id) }));
  }, [tracks, activeSet]);

  // Comp markers, work area, duration, rate and start frame: the active comp's
  // mirror record (seconds).
  const ruler = useTimelineRuler(activeCompId);

  // No preview cache is attached here: the frame cache is the engine's (video
  // memory, sized from the graphics adapter). It has no disk tier, and it
  // ignores `setCacheBudget`, so there is no budget or path to send it either.

  // NOTE: preview-coverage (the green RAM lane and blue disk lane under the
  // ruler) is deliberately NOT state here any more. It changes on every
  // rendered frame — 60×/s through a first playback pass, and again through
  // every idle pre-render pass while paused — so holding it in the shell
  // re-rendered the entire application tree at frame rate and replaced the
  // `timelineModel` object below, defeating the memoization the comment on that
  // model exists to protect. The lanes now subscribe themselves; see
  // `layout/Timeline/CacheBars.tsx`.

  // Model object for the timeline — deliberately does NOT include the live
  // playhead time (activeTime). BottomTimeline reads ws?.time directly and
  // passes it to <Timeline> as a separate `playheadTime` prop, so the model
  // object stays referentially stable across playback frames. Without this,
  // timelineModel was a new object 60×/s and forced the entire row tree to
  // re-evaluate on every frame tick.
  const timelineModel = useMemo<TimelineModel>(() => ({
    duration: ruler.duration,
    frameRate: ruler.frameRate,
    startFrame: ruler.startFrame,
    // A SNAPSHOT, deliberately not reactive: every live consumer reads the
    // separate playheadTime path (BottomTimeline/Timeline/GraphEditor), so
    // this field only serves the no-active-tab fallback. Making it reactive
    // rebuilt this model object every playback frame — exactly what the
    // header comment above forbids.
    currentTime: playheadNow(),
    pixelsPerSecond: pps,
    markers: ruler.markers,
    tracks: focusTracks,
    ...(ruler.workArea ? { workArea: ruler.workArea } : {}),
  }), [focusTracks, pps, ruler]);

  // Real-time playback clock: pumps the Timeline Engine while `playing` is set.
  usePlaybackClock();

  // Background "optimized media": once the editor settles, generate proxies
  // for video assets that predate import-time auto-generation. Sequential and
  // cancellable via the Use Proxies toggle; a no-op on builds without ffmpeg.
  useEffect(() => {
    const t = setTimeout(() => {
      void import('@core/assets/proxyManager').then((m) => m.backfillMissingProxies()).catch(() => {});
    }, 5000);
    return () => clearTimeout(t);
  }, []);
  // Frame-accurate transport shortcuts (Home/End, Page Up/Down, Shift = markers).
  useTimelineKeys();
  // Space: tap to play/pause, hold + drag to pan (After Effects).
  useSpaceTransport();

  // Every timeline handler (rows, bars, keyframes, property rows) — shared
  // with the pop-out timeline window.
  const timelineHandlers = useTimelineHandlers(tracksRef);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <EditorLayout
          topNav={<TopNav />}
          statusBar={<EditorStatusBar layerCount={tracks.length} />}
          timeline={
            <BottomTimeline
              model={timelineModel}
              {...timelineHandlerProps(timelineHandlers)}
              onWorkAreaChange={(start, end) => { void setTimelineWorkArea(start, end); }}
              onScroll={(px) => setTimelineScrollPixels(px)}
              onZoom={handleZoom}
              selectedTrackIds={selectedIds}
              expandedTrackIds={expandedIds}
              revealProps={revealFilter}
              onTrackToggleExpand={toggleExpand}
            />
          }
          sidebarRenderers={getAllPanelRenderers()}
          inspectorRenderers={getAllPanelRenderers()}
        />
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <Providers>
      <EditorShell />
    </Providers>
  );
}
