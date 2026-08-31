/**
 * TransportBar — the whole tool row that used to sit atop the timeline panel:
 * the layer split / trim buttons, the transport itself (go-to-start · prev ·
 * play · next · go-to-end · loop · marker), the preview-quality picker, the
 * viewport tools and the zoom field.
 *
 * All of it drives the VIEWPORT, so all of it lives with the viewport. Moving
 * only the play cluster would have been the worse half-measure: the buttons on
 * either side of it act on what the stage is showing too, and splitting one row
 * across two panels means hunting in two places for controls that were adjacent
 * a moment ago. The timeline's top row is the composition tabs' now.
 * See TransportBar.module.css.
 *
 * Everything here reads the timeline controller and the workspace store
 * directly, so the bar takes no props and can be dropped anywhere in the
 * viewport region.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { ViewportTools } from './ViewportTools';
import { ZoomField } from '@layout/TopNav/ViewControls';
import { framesToTimecode } from '@core/time/timecode';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import {
  useRenderQualityStore,
  RESOLUTION_LABELS,
  RESOLUTION_PERCENT,
  type PreviewResolution,
} from '@stores/renderQualityStore';
import { isDemoted, useTransportOverflow } from './transportOverflow';
import { useTransportDemote } from './useTransportDemote';
import styles from './TransportBar.module.css';

export function TransportBar(): JSX.Element {
  const ws = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] : null));
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const selectedIds = useSelectionStore((s) => s.ids);
  const fps = useCompositionStore((s) => s.fps);
  const startFrame = useCompositionStore((s) => s.startFrame);
  const duration = useCompositionStore((s) => s.durationSeconds);
  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const adaptiveFloor = useRenderQualityStore((s) => s.adaptiveFloor);
  const setAdaptive = useRenderQualityStore((s) => s.setAdaptive);

  // Looping is PER COMP; a state seeded once showed the previous tab's value
  // after switching comps.
  const [looping, setLooping] = useState(() => getTimelineController().isLooping());
  useEffect(() => {
    setLooping(getTimelineController().isLooping());
  }, [activeTabId]);

  const time = ws?.time ?? 0;

  const barRef = useRef<HTMLDivElement>(null);
  const level = useTransportDemote(barRef);
  const shed = (group: Parameters<typeof isDemoted>[0]): boolean => isDemoted(group, level);

  const splitAtPlayhead = (): void => {
    getTimelineController().splitSelectedAtPlayhead(selectedIds);
    bumpScene();
  };
  const trimInToPlayhead = (): void => {
    getTimelineController().trimSelectedStartToPlayhead(selectedIds);
    bumpScene();
  };
  const trimOutToPlayhead = (): void => {
    getTimelineController().trimSelectedEndToPlayhead(selectedIds);
    bumpScene();
  };
  const toggleLoop = (): void => {
    getTimelineController().setLooping(!looping);
    setLooping(!looping);
  };
  const addMarker = (): void => {
    const ctrl = getTimelineController();
    if (selectedIds.length === 1 && ctrl.addLayerMarkerAtPlayhead(selectedIds[0]!)) return;
    ctrl.addMarkerAtPlayhead();
  };

  const qualityItems = ([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
    type: 'item' as const,
    id: `res-${r}`,
    label: `${RESOLUTION_LABELS[r]} · ${RESOLUTION_PERCENT[r]}`,
    icon: (r === previewResolution ? 'check' : undefined) as any,
    onSelect: () => setResolution(r),
  }));
  const adaptiveItem = {
    type: 'checkbox' as const,
    id: 'adaptive',
    label: `Adaptive Resolution while dragging (${RESOLUTION_LABELS[adaptiveFloor]})`,
    checked: adaptive,
    onChange: setAdaptive,
  };

  // Everything the row has shed, as menu items for View Options. Built here
  // because these are the handlers' home; `ViewControls` only renders them.
  const setOverflowItems = useTransportOverflow((s) => s.setItems);
  const overflowItems = useMemo(() => {
    const items = [];
    if (shed('clipEdits')) {
      items.push(
        { type: 'item' as const, id: 'tb-split', label: 'Split Layer at Playhead', icon: 'scissors' as const, shortcut: 'Ctrl+Shift+D', onSelect: splitAtPlayhead },
        { type: 'item' as const, id: 'tb-trim-in', label: 'Trim In-Point to Playhead', icon: 'trim-in' as const, shortcut: 'Alt+[', onSelect: trimInToPlayhead },
        { type: 'item' as const, id: 'tb-trim-out', label: 'Trim Out-Point to Playhead', icon: 'trim-out' as const, shortcut: 'Alt+]', onSelect: trimOutToPlayhead },
      );
    }
    if (shed('quality')) {
      items.push({
        type: 'item' as const,
        id: 'tb-quality',
        label: `Preview Quality: ${RESOLUTION_LABELS[previewResolution]}`,
        icon: 'graph-speed' as const,
        submenu: [...qualityItems, { type: 'separator' as const }, adaptiveItem],
      });
    }
    if (shed('loopMarker')) {
      items.push(
        { type: 'checkbox' as const, id: 'tb-loop', label: 'Loop Playback', checked: looping, onChange: toggleLoop },
        { type: 'item' as const, id: 'tb-marker', label: selectedIds.length === 1 ? 'Add Layer Marker' : 'Add Composition Marker', icon: 'marker' as const, onSelect: addMarker },
      );
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, looping, previewResolution, adaptive, adaptiveFloor, selectedIds]);

  useEffect(() => {
    setOverflowItems(overflowItems);
    return () => setOverflowItems([]);
  }, [overflowItems, setOverflowItems]);

  return (
    <div ref={barRef} className={styles.bar} role="toolbar" aria-label="Viewport transport and tools">
      {/*
        Left of play: everything about TIME — clip edits at the playhead, the
        timecode, the loop flag, the marker key, the playback resolution.
        Right of play: everything about DISPLAY — the viewport's own tools and
        its zoom.

        The split is what makes the row look balanced. Loop, marker and quality
        used to trail the right-hand group, which left three controls and a
        timecode on one side of the play button against ten on the other: play
        sat on the bar's exact midpoint and still read as pushed left, because
        the eye weighs the mass either side of it, not the geometry. It also
        reads better — you no longer cross the viewport tools to reach a
        playback setting.
      */}
      <div className={styles.sideLeft}>
      {/* Layer clip operations. First to leave the row when it runs short:
          three buttons is the widest group here, and each has a shortcut. */}
      {!shed('clipEdits') && (
        <>
          <div className={styles.cluster}>
            <button
              type="button"
              className={styles.btn}
              title="Split Layer at Playhead (Ctrl+Shift+D)"
              onClick={splitAtPlayhead}
            >
              <Icon name="scissors" size="sm" />
            </button>
            <button
              type="button"
              className={styles.btn}
              title="Trim In-Point to Playhead (Alt+[)"
              onClick={trimInToPlayhead}
            >
              <Icon name="trim-in" size="sm" />
            </button>
            <button
              type="button"
              className={styles.btn}
              title="Trim Out-Point to Playhead (Alt+])"
              onClick={trimOutToPlayhead}
            >
              <Icon name="trim-out" size="sm" />
            </button>
          </div>

          <div className={styles.divider} />
        </>
      )}

      <div
        className={styles.timecode}
        title={`Current time — minutes : seconds : frames @ ${fps} fps`}
      >
        {framesToTimecode(time, fps, startFrame)}
        <span className={styles.timecodeTotal}>/ {framesToTimecode(duration, fps, startFrame)}</span>
      </div>

      {/* Loop and marker. Not transport controls — one is a playback mode, the
          other writes to the composition — and running them with the transport
          put PLAY third of seven, so the cluster's midpoint fell on "next
          frame" and the button you aim at from memory sat off centre. */}
      {!shed('loopMarker') && (
        <>
          <div className={styles.divider} />

          <div className={styles.cluster}>
            <button
              type="button"
              className={cn(styles.btn, looping && styles.btnActive)}
              title={looping ? 'Loop Playback: ON' : 'Loop Playback: OFF'}
              onClick={toggleLoop}
            >
              <Icon name="loop" size="sm" />
            </button>
            <button
              type="button"
              className={styles.btn}
              title={selectedIds.length === 1 ? 'Add Layer Marker' : 'Add Composition Marker'}
              onClick={addMarker}
            >
              <Icon name="marker" size="sm" />
            </button>
          </div>
        </>
      )}

      {/* Preview quality ("Full", "Half", …) — a property of the playback, so
          it sits on the playback side of the bar. */}
      {!shed('quality') && (
        <>
          <div className={styles.divider} />

          <div className={styles.cluster}>
            <Dropdown
              placement="top-start"
              trigger={
                <button
                  type="button"
                  className={cn(styles.btn, styles.qualityBtn, previewResolution !== 1 && styles.btnActive)}
                  title="Preview Quality"
                >
                  <Icon name="graph-speed" size="sm" />
                  <span>{RESOLUTION_LABELS[previewResolution]}</span>
                </button>
              }
              items={[...qualityItems, { type: 'separator' as const }, adaptiveItem]}
            />
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
          onClick={() => getTimelineController().goToStart()}
        >
          <Icon name="skip-back" size="sm" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Previous Frame (Page Up)"
          onClick={() => getTimelineController().previousFrame()}
        >
          <Icon name="chevron-left" size="sm" />
        </button>
        <button
          type="button"
          className={cn(styles.btn, styles.playBtn, ws?.playing && styles.playBtnActive)}
          title={ws?.playing ? 'Pause Playback (Space)' : 'Start Playback (Space)'}
          onClick={() => getTimelineController().togglePlay()}
        >
          <Icon name={ws?.playing ? 'pause' : 'play'} size="md" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Next Frame (Page Down)"
          onClick={() => getTimelineController().nextFrame()}
        >
          <Icon name="chevron-right" size="sm" />
        </button>
        <button
          type="button"
          className={styles.btn}
          title="Go to End (End)"
          onClick={() => getTimelineController().goToEnd()}
        >
          <Icon name="skip-forward" size="sm" />
        </button>
      </div>

      {/* Motion path, the 3D switch, auto-keyframe, rulers / safe / channels,
          fit-to-view, pop out — the viewport's own controls. */}
      <div className={styles.sideRight}>
      <div className={styles.cluster}>
        <ViewportTools />
      </div>

      {/* Last to go, and the only group that leaves without a menu entry: the
          wheel, the +/- keys and "Fit in view" inside View Options all still
          reach the viewport's zoom. */}
      {!shed('zoom') && (
        <>
          <div className={styles.divider} />

          <div className={styles.cluster}>
            <ZoomField />
          </div>
        </>
      )}
      </div>
    </div>
  );
}
