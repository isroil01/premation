/**
 * TransportBar — the ONE row under the stage.
 *
 * Left to right, in groups with a hairline between them (2026-10-19):
 *
 *   View: 3D view · layout | timecode current / total | Capture: snapshot ·
 *   compare | [go to start · previous frame · PLAY · next frame · go to end]
 *   | Guides: the motion-path toggle (`ViewportTools`, with a selected path
 *   only) | Display: resolution · preview · transparency grid · overlays ·
 *   channel · exposure (`ViewportDisplayControls`) … magnification, pinned at
 *   the far right.
 *
 * Every control in the groups is drawn from the one button in
 * `viewportToolButton.module.css`: 24px, 14px glyph, a chevron only where a
 * menu opens, the menu's current value as text, and a lit state that is a
 * tint plus a blue glyph — never the filled box that would make a toggle
 * look like Play.
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
import { displayLevelFor, isDemoted, isDisplayShed, type TransportGroup } from './transportOverflow';
import { useTransportDemote } from './useTransportDemote';
import {
  getCompositionShuttle,
  subscribeCompositionShuttleRate,
} from '@core/timeline/transportController';
import { CacheMemoryMeter } from '@layout/CacheMemory/CacheMemoryMeter';
import styles from './TransportBar.module.css';
import tool from './viewportToolButton.module.css';
import { t } from '@core/i18n';

/**
 * Memoised: it takes no props and subscribes to everything it draws (workspace
 * and preference stores, the composition's mirror record), so the viewport shell
 * above it re-rendering — once per painted frame of a drag — has nothing to tell it.
 */
export interface TransportBarProps {
  /**
   * Timecode and the transport only. The pop-out timeline's window has no
   * viewer, so the viewer's own controls (layout, compare, resolution,
   * channels, overlays, zoom) would act on a canvas that is not there.
   */
  playbackOnly?: boolean;
}

export const TransportBar = memo(function TransportBar({ playbackOnly = false }: TransportBarProps): JSX.Element {
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
  // Which groups still have a control to show. A group that has shed all of
  // its controls keeps its place (the shed rows come back into it) but
  // collapses its padding and loses its hairline.
  const showView = !isDisplayShed('layout', displayLevel);
  const showCapture = !isDisplayShed('compare', displayLevel);
  const showDisplay = (['resolution', 'preview', 'transparency', 'overlays', 'channel', 'exposure'] as const)
    .some((g) => !isDisplayShed(g, displayLevel));

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
      items.push({ type: 'item', id: 'tb-zoom', label: t('workspace.transport.zoom', 'Zoom: {percent}%', { percent: Math.round(zoom) }), icon: 'zoom-in', submenu: zoomMenuItems(zoom) });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, zoom, displayItems]);

  return (
    <div
      ref={barRef}
      className={styles.bar}
      role="toolbar"
      aria-label={t('workspace.transport.toolbar', 'Viewport transport and tools')}
      // The JKL chords read `[data-transport-bar]` as "the viewport has focus"
      // — see `viewportCommands.transportChordsActive`.
      data-transport-bar=""
    >
      {/*
        Five groups, hairlines between them (2026-10-19):

          View (3D view, layout) · timecode · Capture (snapshot, compare)
          [ transport ]
          Guides (motion path, while a path is selected) · Display
          (resolution, preview, transparency, overlays, channel, exposure)
          … and the zoom field pinned at the far right.

        The split is what makes the row look balanced: the eye weighs the mass
        either side of the play button, not the geometry, so the two sides are
        kept roughly even. (A Scene group — the 3D switch, anchor and gizmo —
        has no members here: those are the timeline's switch column, Layer ▸
        3D Layer and the stage's own handles, 2026-10-07.)
      */}
      <div className={styles.sideLeft}>
        {!playbackOnly && (
          <>
            <div className={cn(tool.group, !showView && tool.groupEmpty)}>
              <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="layout" />
            </div>
            {showView && <div className={tool.divider} />}
          </>
        )}

        <div
          className={styles.timecode}
          title={t('workspace.transport.currentTime', 'Current time — minutes : seconds : frames @ {fps} fps', { fps })}
        >
          <LiveTimecode fps={fps} startFrame={startFrame} />
          <span className={styles.timecodeTotal}>/ {framesToTimecode(duration, fps, startFrame)}</span>
        </div>

        {!playbackOnly && (
          <>
            {showCapture && <div className={tool.divider} />}
            <div className={cn(tool.group, !showCapture && tool.groupEmpty)}>
              <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="compare" />
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
          title={t('workspace.transport.goToStartTitle', 'Go to Start (Home)')}
          aria-label={t('workspace.transport.goToStart', 'Go to Start')}
          onClick={() => goToStart()}
        >
          <Icon name="skip-back" size="md" weight="fill" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title={t('workspace.transport.prevFrameTitle', 'Previous Frame (Page Up)')}
          aria-label={t('workspace.transport.prevFrame', 'Previous Frame')}
          onClick={() => stepBackward()}
        >
          <Icon name="chevron-left" size="md" weight="bold" />
        </button>
        <button
          type="button"
          className={cn(styles.btn, styles.playBtn, ws?.playing && styles.playBtnActive)}
          title={ws?.playing
            ? t('workspace.transport.pauseTitle', 'Pause Playback (Space)')
            : t('workspace.transport.playTitle', 'Start Playback (Space)')}
          aria-label={ws?.playing ? t('workspace.transport.pause', 'Pause') : t('workspace.transport.play', 'Play')}
          onClick={() => togglePlayTransport()}
        >
          <Icon name={ws?.playing ? 'pause' : 'play'} size="lg" weight="fill" />
        </button>
        <ShuttleRateBadge />
        <button
          type="button"
          className={styles.btn}
          title={t('workspace.transport.nextFrameTitle', 'Next Frame (Page Down)')}
          aria-label={t('workspace.transport.nextFrame', 'Next Frame')}
          onClick={() => stepForward()}
        >
          <Icon name="chevron-right" size="md" weight="bold" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title={t('workspace.transport.goToEndTitle', 'Go to End (End)')}
          aria-label={t('workspace.transport.goToEnd', 'Go to End')}
          onClick={() => goToEnd()}
        >
          <Icon name="skip-forward" size="md" weight="fill" />
        </button>
      </div>

      {playbackOnly ? <div className={styles.sideRight} /> : <div className={styles.sideRight}>
        {/* Guides: the motion-path toggle, while a layer with a path is
            selected. It carries its own hairline. */}
        <ViewportTools />

        {/* Display: Resolution · Preview · Transparency Grid · Overlays · Channel · Exposure */}
        <div className={cn(tool.group, !showDisplay && tool.groupEmpty)}>
          <ViewportDisplayControlsView model={display} level={displayLevel} overflow="host" section="right" />
        </div>

        {/* The memory meter: never shed (it is how memory trouble is noticed),
            down to its status dot once the zoom field has gone. */}
        <CacheMemoryMeter compact={shed('zoom')} />

        {/* The zoom field, pinned at the far right. Last to go: the wheel
            and the +/- keys still reach the viewport's zoom, and the `⋯`
            menu lists the presets while it is shed. */}
        {(!shed('zoom') || overflowItems.length > 0) && (
          <div className={styles.zoomSlot}>
            {!shed('zoom') && <ZoomField />}
            {overflowItems.length > 0 && (
              <Dropdown
                placement="top-end"
                trigger={
                  <button type="button" className={tool.tool} title={t('workspace.transport.more', 'More transport controls')} aria-label={t('workspace.transport.moreCount', 'More transport controls ({n})', { n: overflowItems.length })}>
                    <Icon name="more-horizontal" size="sm" />
                  </button>
                }
                items={overflowItems}
              />
            )}
          </div>
        )}
      </div>}
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
      aria-label={rate < 0
        ? t('workspace.transport.shuttleReverse', 'Shuttle reverse {speed}×', { speed })
        : t('workspace.transport.shuttleForward', 'Shuttle forward {speed}×', { speed })}
      title={t('workspace.transport.shuttleTitle', 'Shuttle running — J / L again for 2× and 4×, K stops (I / O mark in and out)')}
    >
      {dir} {speed}×
    </span>
  );
}
