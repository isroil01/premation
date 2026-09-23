/**
 * TransportBar — the ONE row under the stage.
 *
 * Left to right:
 *
 *   [split · trim in · trim out] · timecode current / total ·
 *   [go to start · previous frame · PLAY · next frame · go to end] ·
 *   [loop · marker] · the scene tools (`ViewportTools`: motion path, the 3D
 *   switch, auto-keyframe, the status badges) · the display controls
 *   (`ViewportDisplayControls`: layout, channel, resolution, preview, LUT,
 *   overlays, snapshot + compare, display mode, bookmarks, pop out) · the
 *   zoom field
 *
 * The five transport buttons in the middle are the only set of them in the
 * app. The JKL shuttle and the in / out marks that used to sit beside them as
 * seven more buttons are keyboard chords (J K L · I O · Shift+I Shift+O) and
 * rows in Composition ▸ Transport; what remains of them here is a small
 * rate badge beside PLAY that appears only while a shuttle is running, so the
 * keys stay discoverable without costing seven slots.
 *
 * All of it drives the VIEWPORT, so all of it lives with the viewport. The
 * timeline's own tools are in the timeline panel's toolbar row. The display
 * controls used to sit at the right end of the tabs row above the stage; they
 * came down here because that row was "too many buttons on the right" and
 * this one had the room — and because they, too, are about the viewport.
 *
 * The row cannot wrap. It is a `1fr auto 1fr` grid with play in the middle,
 * and when the right column outweighs what it has, the ladder in
 * `transportOverflow.ts` sheds from it — the display controls first, one by
 * one, then the bar's own groups — into the bar's single `⋯` menu. Play does
 * not move.
 *
 * Everything here reads the timeline controller and the workspace store
 * directly, so the bar takes no props and can be dropped anywhere in the
 * viewport region (the popout timeline mounts a second copy).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { getTimelineController } from '@core/timeline/TimelineController';
import { splitSelectedAtPlayhead, trimSelectedEndToPlayhead, trimSelectedStartToPlayhead } from '@layout/Timeline/timelineEdits';
import { addCompMarkerAtPlayhead, addLayerMarkersAtPlayhead } from '@layout/Timeline/markerCommands';
import { ViewportTools } from './ViewportTools';
import { ViewportDisplayControlsView, displayOverflowItems, useViewportDisplayModel } from './ViewportDisplayControls';
import { ZoomField, useZoomPercent, zoomMenuItems } from './ZoomField';
import { framesToTimecode } from '@core/time/timecode';
import { useWorkspaceStore } from '@stores/projectStore';
import { LiveTimecode } from '@layout/Timeline/LiveTimecode';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { displayLevelFor, isDemoted, type TransportGroup } from './transportOverflow';
import { useTransportDemote } from './useTransportDemote';
import {
  getCompositionShuttle,
  subscribeCompositionShuttleRate,
} from '@core/timeline/transportController';
import styles from './TransportBar.module.css';

export function TransportBar(): JSX.Element {
  const ws = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] : null));
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const selectedIds = useSelectionStore((s) => s.ids);
  const fps = useCompositionStore((s) => s.fps);
  const startFrame = useCompositionStore((s) => s.startFrame);
  const duration = useCompositionStore((s) => s.durationSeconds);

  // Looping is PER COMP; a state seeded once showed the previous tab's value
  // after switching comps.
  const [looping, setLooping] = useState(() => getTimelineController().isLooping());
  useEffect(() => {
    setLooping(getTimelineController().isLooping());
  }, [activeTabId]);

  // No live clock subscription here: the timecode is a `LiveTimecode` leaf that
  // writes its own text every frame, so playback does not re-render the bar.

  const barRef = useRef<HTMLDivElement>(null);
  const level = useTransportDemote(barRef);
  const shed = (group: TransportGroup): boolean => isDemoted(group, level);
  // The display controls' share of the ladder — its first ten rungs.
  const displayLevel = displayLevelFor(level);
  const display = useViewportDisplayModel();
  const zoom = useZoomPercent();

  // The timeline's own edits (engine API, one entry each, the legacy labels).
  const splitAtPlayhead = (): void => { void splitSelectedAtPlayhead(selectedIds); };
  const trimInToPlayhead = (): void => { void trimSelectedStartToPlayhead(selectedIds); };
  const trimOutToPlayhead = (): void => { void trimSelectedEndToPlayhead(selectedIds); };
  const toggleLoop = (): void => {
    getTimelineController().setLooping(!looping);
    setLooping(!looping);
  };
  // One layer selected → a layer marker on it; otherwise a comp marker. The
  // timeline's marker commands (their colour gap is documented there).
  const addMarker = (): void => {
    if (selectedIds.length === 1 && addLayerMarkersAtPlayhead() > 0) return;
    addCompMarkerAtPlayhead();
  };

  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const toggleAutoKeyframe = (): void => {
    usePreferenceStore.getState().set('timelineAutoKeyframe', !autoKeyframe);
  };

  // Everything the row has shed, as rows of the bar's own `⋯` menu, in row
  // order: the clip edits, loop and marker, the display controls, the zoom.
  // Built here because these are the handlers' home.
  const displayItems = displayOverflowItems(display, displayLevel);
  const overflowItems = useMemo<DropdownItem[]>(() => {
    const items: DropdownItem[] = [];
    if (shed('clipEdits')) {
      items.push(
        { type: 'item', id: 'tb-split', label: 'Split Layer at Playhead', icon: 'scissors', shortcut: 'Ctrl+Shift+D', onSelect: splitAtPlayhead },
        { type: 'item', id: 'tb-trim-in', label: 'Trim In-Point to Playhead', icon: 'trim-in', shortcut: 'Alt+[', onSelect: trimInToPlayhead },
        { type: 'item', id: 'tb-trim-out', label: 'Trim Out-Point to Playhead', icon: 'trim-out', shortcut: 'Alt+]', onSelect: trimOutToPlayhead },
      );
    }
    if (shed('loopMarker')) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { type: 'checkbox', id: 'tb-loop', label: 'Loop Playback', checked: looping, onChange: toggleLoop },
        { type: 'item', id: 'tb-marker', label: selectedIds.length === 1 ? 'Add Layer Marker' : 'Add Composition Marker', icon: 'marker', onSelect: addMarker },
        { type: 'checkbox', id: 'tb-autokey', label: 'Auto-Keyframe Mode', checked: autoKeyframe, onChange: toggleAutoKeyframe },
      );
    }
    if (displayItems.length > 0) {
      if (items.length) items.push({ type: 'separator' });
      items.push(...displayItems);
    }
    if (shed('zoom')) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ type: 'item', id: 'tb-zoom', label: `Zoom: ${Math.round(zoom)}%`, icon: 'zoom-in', submenu: zoomMenuItems(zoom) });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, looping, selectedIds, zoom, displayItems, autoKeyframe]);

  return (
    <div
      ref={barRef}
      className={styles.bar}
      role="toolbar"
      aria-label="Viewport transport and tools"
      // The JKL chords read `[data-transport-bar]` as "the viewport has focus"
      // — see `viewportCommands.transportChordsActive`.
      data-transport-bar=""
    >
      {/*
        Left of play: everything about TIME — clip edits at the playhead, the
        timecode, the loop flag, the marker key.
        Right of play: everything about the SCENE — the viewport's own tools
        and its zoom.

        The split is what makes the row look balanced: the eye weighs the mass
        either side of the play button, not the geometry, so the two sides are
        kept roughly even.
      */}
      <div className={styles.sideLeft}>
        {/* Viewport layout dropdown */}
        <div className={styles.cluster}>
          <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="layout" />
        </div>

        {!shed('clipEdits') && (
          <>
            <div className={styles.divider} />

            {/* Layer clip operations: Split, Trim In, Trim Out */}
            <div className={styles.cluster}>
              <button
                type="button"
                className={styles.btn}
                title="Split Layer at Playhead (Ctrl+Shift+D)"
                aria-label="Split Layer at Playhead"
                onClick={splitAtPlayhead}
              >
                <Icon name="scissors" size="sm" />
              </button>
              <button
                type="button"
                className={styles.btn}
                title="Trim In-Point to Playhead (Alt+[)"
                aria-label="Trim In-Point to Playhead"
                onClick={trimInToPlayhead}
              >
                <Icon name="trim-in" size="sm" />
              </button>
              <button
                type="button"
                className={styles.btn}
                title="Trim Out-Point to Playhead (Alt+])"
                aria-label="Trim Out-Point to Playhead"
                onClick={trimOutToPlayhead}
              >
                <Icon name="trim-out" size="sm" />
              </button>
            </div>
          </>
        )}

        <div className={styles.divider} />

        <div
          className={styles.timecode}
          title={`Current time — minutes : seconds : frames @ ${fps} fps`}
        >
          <LiveTimecode fps={fps} startFrame={startFrame} />
          <span className={styles.timecodeTotal}>/ {framesToTimecode(duration, fps, startFrame)}</span>
        </div>

        <div className={styles.divider} />

        {/* Snapshot & compare controls */}
        <div className={styles.cluster}>
          <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="compare" />
        </div>

        {!shed('loopMarker') && (
          <>
            <div className={styles.divider} />

            {/* Playback modes & recording: Loop, Marker, Auto-Keyframe */}
            <div className={styles.cluster}>
              <button
                type="button"
                className={cn(styles.btn, looping && styles.btnActive)}
                title={looping ? 'Loop Playback: ON' : 'Loop Playback: OFF'}
                aria-label="Loop Playback"
                aria-pressed={looping}
                onClick={toggleLoop}
              >
                <Icon name="loop" size="sm" />
              </button>
              <button
                type="button"
                className={styles.btn}
                title={selectedIds.length === 1 ? 'Add Layer Marker' : 'Add Composition Marker'}
                aria-label={selectedIds.length === 1 ? 'Add Layer Marker' : 'Add Composition Marker'}
                onClick={addMarker}
              >
                <Icon name="marker" size="sm" />
              </button>
              <button
                type="button"
                className={cn(styles.btn, autoKeyframe && styles.btnActive, autoKeyframe && styles.autoKeyBtnActive)}
                onClick={toggleAutoKeyframe}
                aria-label="Auto-Keyframe mode"
                aria-pressed={autoKeyframe}
                title={autoKeyframe ? 'Auto-Keyframe Mode is ON (Click to turn OFF)' : 'Auto-Keyframe Mode is OFF (Click to turn ON)'}
              >
                <Icon name="stopwatch" size="sm" />
                {autoKeyframe && <span className={styles.recLabel}>REC</span>}
              </button>
            </div>
          </>
        )}
      </div>

      {/* The centre column: go-to-start · prev · PLAY · next · go-to-end.
          Five controls with play in the middle, in an `auto` column of a
          `1fr auto 1fr` grid — so the play button lands on the bar's exact
          midpoint no matter how the two side groups grow or collapse. It is
          the one control whose position you learn with your hand rather than
          your eye, so it is the one that must not drift. */}
      <div className={styles.cluster}>
        <button
          type="button"
          className={styles.btn}
          title="Go to Start (Home)"
          aria-label="Go to Start"
          onClick={() => getTimelineController().goToStart()}
        >
          <Icon name="skip-back" size="sm" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Previous Frame (Page Up)"
          aria-label="Previous Frame"
          onClick={() => getTimelineController().previousFrame()}
        >
          <Icon name="chevron-left" size="sm" />
        </button>
        <button
          type="button"
          className={cn(styles.btn, styles.playBtn, ws?.playing && styles.playBtnActive)}
          title={ws?.playing ? 'Pause Playback (Space)' : 'Start Playback (Space)'}
          aria-label={ws?.playing ? 'Pause' : 'Play'}
          onClick={() => getTimelineController().togglePlay()}
        >
          <Icon name={ws?.playing ? 'pause' : 'play'} size="md" />
        </button>
        <ShuttleRateBadge />
        <button
          type="button"
          className={styles.btn}
          title="Next Frame (Page Down)"
          aria-label="Next Frame"
          onClick={() => getTimelineController().nextFrame()}
        >
          <Icon name="chevron-right" size="sm" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Go to End (End)"
          aria-label="Go to End"
          onClick={() => getTimelineController().goToEnd()}
        >
          <Icon name="skip-forward" size="sm" />
        </button>
      </div>

      <div className={styles.sideRight}>
        {/* Contextual motion path, 3D switch, and status badges */}
        <ViewportTools />

        {/* Display controls: Overlays, display mode, channel, resolution, preview, LUT, bookmarks, pop out */}
        <div className={styles.cluster}>
          <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="right" />
        </div>

        {/* Last to go: the wheel and the +/- keys still reach the viewport's
            zoom, and the `⋯` menu lists the presets while it is shed. */}
        {!shed('zoom') && (
          <>
            <div className={styles.divider} />

            <div className={styles.cluster}>
              <ZoomField />
            </div>
          </>
        )}

        {overflowItems.length > 0 && (
          <Dropdown
            placement="top-end"
            trigger={
              <button type="button" className={styles.btn} title="More transport controls" aria-label={`More transport controls (${overflowItems.length})`}>
                <Icon name="more-horizontal" size="sm" />
              </button>
            }
            items={overflowItems}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The shuttle's rate, beside PLAY, only while a shuttle is running.
 *
 * J / K / L drive `core/timeline/transportController` — the same shuttle the
 * Source Monitor has, the same 1× / 2× / 4× ladder. The seven buttons that
 * used to sit here to teach the keys are gone; this badge is what is left of
 * them. It costs nothing at rest and, the moment someone presses L, says
 * `▶▶ 1×` where the eye already is, with the keys in its tooltip.
 *
 * Reads the shuttle's own `onRateChange`, not a poll — a shuttle at 4× must
 * not cost a re-render per tick.
 */
function ShuttleRateBadge(): JSX.Element | null {
  const [rate, setRate] = useState(() => getCompositionShuttle().rate());
  useEffect(() => subscribeCompositionShuttleRate(setRate), []);
  if (rate === 0) return null;
  const speed = Math.abs(rate);
  const dir = rate < 0 ? '◀◀' : '▶▶';
  return (
    <span
      className={styles.shuttleRate}
      role="status"
      aria-label={`Shuttle ${rate < 0 ? 'reverse' : 'forward'} ${speed}×`}
      title="Shuttle running — J / L again for 2× and 4×, K stops (I / O mark in and out)"
    >
      {dir} {speed}×
    </span>
  );
}
