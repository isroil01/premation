/**
 * TransportBar — the ONE row under the stage.
 *
 * Left to right:
 *
 *   3D view · layout · timecode current / total · snapshot + compare ·
 *   [go to start · previous frame · PLAY · next frame · go to end] ·
 *   the motion-path toggle (`ViewportTools`, with a selected path only) ·
 *   resolution · preview · transparency grid · overlays · channel · exposure
 *   (`ViewportDisplayControls`) · magnification
 *
 * That is AE's Composition panel footer plus the transport. What used to sit
 * here as well and was not (2026-10-07): Loop (the Preview panel's), Auto-
 * Keyframe (the timeline's toolbar), the 3D-view badge (the 3D View menu says
 * it), Smooth / Straighten path (the keyframe menu), the 3D switch (the
 * timeline switch and Layer ▸ 3D Layer), Viewer LUT and display mode (the
 * Preview menu), bookmarks (View ▸ Viewport) and pop out (the panel menu).
 *
 * Split / Trim In / Trim Out and Add Marker are not buttons here (2026-10-07):
 * AE's Composition panel has none, and each is a chord (Ctrl+Shift+D, Alt+[,
 * Alt+], * / Numpad *), a clip right-click row and a Layer menu row.
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
 * Everything here reads the transport (`timelineView`), the document mirror
 * (the comp's rate, start and length) and the workspace store directly, so the bar takes no props and can be dropped anywhere in the
 * viewport region (the popout timeline mounts a second copy).
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import {
  goToEnd,
  goToStart,
  stepBackward,
  stepForward,
  togglePlayTransport,
} from '@core/timeline/timelineView';
import { ViewportTools } from './ViewportTools';
import { ViewportDisplayControlsView, displayOverflowItems, useViewportDisplayModel } from './ViewportDisplayControls';
import { ZoomField, useZoomPercent, zoomMenuItems } from './ZoomField';
import { framesToTimecode } from '@core/time/timecode';
import { useWorkspaceStore } from '@stores/projectStore';
import { LiveTimecode } from '@layout/Timeline/LiveTimecode';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { settingsDurationSeconds, settingsFps, settingsStartFrame } from '@core/mirror/compFacts';
import { displayLevelFor, isDemoted, type TransportGroup } from './transportOverflow';
import { useTransportDemote } from './useTransportDemote';
import {
  getCompositionShuttle,
  subscribeCompositionShuttleRate,
} from '@core/timeline/transportController';
import styles from './TransportBar.module.css';

/**
 * Memoised: it takes no props and subscribes to everything it draws (workspace
 * and preference stores, the composition's mirror record), so the viewport shell
 * above it re-rendering — once per painted frame of a drag — has nothing to tell it.
 */
export const TransportBar = memo(function TransportBar(): JSX.Element {
  const ws = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] : null));
  const settings = useActiveMirrorComp()?.settings;
  const fps = settingsFps(settings);
  const startFrame = settingsStartFrame(settings);
  const duration = settingsDurationSeconds(settings);

  // No live clock subscription here: the timecode is a `LiveTimecode` leaf that
  // writes its own text every frame, so playback does not re-render the bar.

  const barRef = useRef<HTMLDivElement>(null);
  const level = useTransportDemote(barRef);
  const shed = (group: TransportGroup): boolean => isDemoted(group, level);
  // The display controls' share of the ladder — its first rungs.
  const displayLevel = displayLevelFor(level);
  const display = useViewportDisplayModel();
  const zoom = useZoomPercent();

  // Everything the row has shed, as rows of the bar's own `⋯` menu, in row
  // order: the display controls, then the zoom.
  const displayItems = displayOverflowItems(display, displayLevel);
  const overflowItems = useMemo<DropdownItem[]>(() => {
    const items: DropdownItem[] = [];
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
  }, [level, zoom, displayItems]);

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
        Left of play: the views — 3D view, layout, the timecode, snapshots.
        Right of play: how the frame is shown — resolution, preview,
        transparency, overlays, channel, exposure — and the magnification.

        The split is what makes the row look balanced: the eye weighs the mass
        either side of the play button, not the geometry, so the two sides are
        kept roughly even.
      */}
      <div className={styles.sideLeft}>
        {/* Viewport layout dropdown */}
        <div className={styles.cluster}>
          <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="layout" />
        </div>

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
          onClick={() => goToStart()}
        >
          <Icon name="skip-back" size="sm" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Previous Frame (Page Up)"
          aria-label="Previous Frame"
          onClick={() => stepBackward()}
        >
          <Icon name="chevron-left" size="sm" />
        </button>
        <button
          type="button"
          className={cn(styles.btn, styles.playBtn, ws?.playing && styles.playBtnActive)}
          title={ws?.playing ? 'Pause Playback (Space)' : 'Start Playback (Space)'}
          aria-label={ws?.playing ? 'Pause' : 'Play'}
          onClick={() => togglePlayTransport()}
        >
          <Icon name={ws?.playing ? 'pause' : 'play'} size="md" />
        </button>
        <ShuttleRateBadge />
        <button
          type="button"
          className={styles.btn}
          title="Next Frame (Page Down)"
          aria-label="Next Frame"
          onClick={() => stepForward()}
        >
          <Icon name="chevron-right" size="sm" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Go to End (End)"
          aria-label="Go to End"
          onClick={() => goToEnd()}
        >
          <Icon name="skip-forward" size="sm" />
        </button>
      </div>

      <div className={styles.sideRight}>
        {/* The motion-path toggle, while a layer with a path is selected */}
        <ViewportTools />

        {/* Resolution · Preview · Transparency Grid · Overlays · Channel · Exposure */}
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
});

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
