import { useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore, CAMERA_ORTHO_VIEWS, type Camera3dMode, type ViewChannel } from '@stores/guidesStore';
import { CUSTOM_VIEW_IDS, CUSTOM_VIEW_LABEL } from '@core/workspace/customViews';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useRenderQualityStore, RESOLUTION_LABELS, type PreviewResolution } from '@stores/renderQualityStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { Dropdown } from '@components/Dropdown';
import styles from './TopNav.module.css';

/** Tiny inline number field that scrubs on drag. */
function ScrubField({
  value,
  onChange,
  unit = '',
  min,
  max,
  step = 1,
  digits = 0,
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  title?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startV: number } | null>(null);
  const stopDragRef = useRef<(() => void) | null>(null);

  const commit = useCallback((v: number) => {
    let clamped = v;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    if (!Number.isFinite(clamped)) return;
    onChange(clamped);
  }, [min, max, onChange]);

  useEffect(() => () => stopDragRef.current?.(), []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startV: value };
      const onMove = (me: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = me.clientX - dragRef.current.startX;
        commit(dragRef.current.startV + dx * step);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        stopDragRef.current = null;
      };
      stopDragRef.current = onUp;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, value, step, commit],
  );

  const onDoubleClick = () => {
    setRaw(value.toFixed(digits));
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const onBlur = () => {
    commit(parseFloat(raw));
    setEditing(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { commit(parseFloat(raw)); setEditing(false); }
    if (e.key === 'Escape') setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={styles.scrubInput}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        autoFocus
      />
    );
  }

  return (
    <span
      className={styles.scrubField}
      title={title}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {value.toFixed(digits)}{unit}
    </span>
  );
}

/** Human labels for the 3D view modes. */
export const CAMERA_VIEW_LABEL: Record<Camera3dMode, string> = {
  active: 'Active Camera', front: 'Front', back: 'Back',
  left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom',
  ...CUSTOM_VIEW_LABEL,
};

const CHANNEL_LABEL: Record<ViewChannel, string> = {
  rgb: 'RGB', red: 'Red', green: 'Green', blue: 'Blue', alpha: 'Alpha',
};

/** Magnification presets (AE's zoom menu). 100 = 1:1. */
const ZOOM_PRESETS = [12.5, 25, 50, 75, 100, 150, 200, 400, 800] as const;

/** Live zoom % field — syncs with the workspace camera. */
export function ZoomField(): JSX.Element {
  const [zoom, setZoom] = useState(() => getWorkspaceController().zoomPercent());

  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const sync = () => setZoom(getWorkspaceController().zoomPercent());
    const s1 = ws.events.on('ZoomChanged', sync);
    const s2 = ws.events.on('ViewportChanged', sync);
    return () => { s1.dispose(); s2.dispose(); };
  }, []);

  return (
    <span className={styles.zoomGroup}>
      <button type="button" className={styles.tool} onClick={() => getWorkspaceController().zoomOut()} title="Zoom out (-)">
        <Icon name="zoom-out" size="sm" />
      </button>
      <ScrubField
        value={zoom}
        onChange={(v) => getWorkspaceController().setZoomPercent(v)}
        unit="%"
        min={5}
        max={6400}
        step={1}
        digits={0}
        title="Zoom · drag or double-click to type"
      />
      {/* Magnification presets — AE's zoom menu, so a discrete jump to 100% or
          Fit doesn't require nudging the ±1.2× steps or typing. The chevron sits
          on the % field; the field itself still scrubs and accepts typed values. */}
      <Dropdown
        placement="bottom-end"
        trigger={
          <button type="button" className={styles.tool} title="Magnification presets" aria-label="Magnification presets">
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
        items={[
          { type: 'item', id: 'zoom-fit', label: 'Fit in view', onSelect: () => getWorkspaceController().fitComposition() },
          { type: 'separator' },
          ...ZOOM_PRESETS.map((pct) => ({
            type: 'checkbox' as const,
            id: `zoom-${pct}`,
            label: `${pct}%`,
            checked: Math.abs(zoom - pct) < 0.5,
            onChange: () => getWorkspaceController().setZoomPercent(pct),
          })),
        ]}
      />
      <button type="button" className={styles.tool} onClick={() => getWorkspaceController().zoomIn()} title="Zoom in (+)">
        <Icon name="zoom-in" size="sm" />
      </button>
      {/* No key is advertised here because none is registered — the tooltip
          used to promise Shift+F, which did nothing. */}
      <button
        type="button"
        className={styles.tool}
        onClick={() => getWorkspaceController().fitComposition()}
        title="Fit comp in view"
      >
        <Icon name="fit" size="sm" />
      </button>
    </span>
  );
}

export function ViewControls(): JSX.Element {
  const grid      = useGuidesStore((s) => s.grid);
  const rulers    = useGuidesStore((s) => s.rulers);
  const safeArea  = useGuidesStore((s) => s.safeArea);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const channel      = useGuidesStore((s) => s.channel);
  
  const setChannel    = useGuidesStore((s) => s.setChannel);
  const toggleGrid     = useGuidesStore((s) => s.toggleGrid);
  const toggleRulers   = useGuidesStore((s) => s.toggleRulers);
  const toggleSafeArea = useGuidesStore((s) => s.toggleSafeArea);
  const setCamera3dMode = useGuidesStore((s) => s.setCamera3dMode);

  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const setAutoKeyframe = (v: boolean) => usePreferenceStore.getState().set('timelineAutoKeyframe', v);

  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);
  const motionPathDots = useGuidesStore((s) => s.motionPathDots);
  const setMotionPathDots = useGuidesStore((s) => s.setMotionPathDots);

  // Preview resolution is a viewport concern (AE keeps it in the viewer bar), so
  // it belongs here beside the other view options rather than only down in the
  // playback controls.
  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);

  const roi = useGuidesStore((s) => s.roi);
  const setRoi = useGuidesStore((s) => s.setRoi);
  const viewLayout = useGuidesStore((s) => s.viewLayout);
  const setViewLayout = useGuidesStore((s) => s.setViewLayout);
  // Set the ROI to the composition's centre half — a sensible starting region
  // the user then drags to taste on the canvas.
  const setCentreRoi = (): void => {
    const comp = useCompositionStore.getState();
    setRoi({ x: Math.round(comp.width / 4), y: Math.round(comp.height / 4), width: Math.round(comp.width / 2), height: Math.round(comp.height / 2) });
  };
  const dotChoice = (id: 'off' | 'small' | 'medium' | 'large', label: string) =>
    ({
      type: 'checkbox' as const,
      id: `mp-dots-${id}`,
      label,
      checked: motionPathDots === id,
      onChange: () => setMotionPathDots(id),
    });

  return (
    <div className={styles.toolGroup}>
      {/* View Options & Overlays Dropdown */}
      <Dropdown
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className={styles.toolDropdownTrigger}
            title="View Options"
          >
            <Icon name="sliders-h" size="md" />
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
        items={[
          { type: 'checkbox', id: 'grid', label: 'Grid', checked: grid, onChange: toggleGrid },
          { type: 'checkbox', id: 'rulers', label: 'Rulers', checked: rulers, onChange: toggleRulers },
          { type: 'checkbox', id: 'safe-area', label: 'Safe Areas', checked: safeArea, onChange: toggleSafeArea },
          {
            type: 'item',
            id: 'camera-3d',
            label: `3D View: ${CAMERA_VIEW_LABEL[camera3dMode]}`,
            submenu: [
              {
                type: 'checkbox' as const,
                id: 'cam-active',
                label: 'Active Camera',
                checked: camera3dMode === 'active',
                onChange: () => setCamera3dMode('active'),
              },
              { type: 'separator' as const },
              ...CAMERA_ORTHO_VIEWS.map((v) => ({
                type: 'checkbox' as const,
                id: `cam-${v}`,
                label: CAMERA_VIEW_LABEL[v],
                checked: camera3dMode === v,
                onChange: () => setCamera3dMode(v),
              })),
              { type: 'separator' as const },
              // Custom views (AE parity): navigable perspective views that never
              // touch the scene camera — Alt+drag/wheel re-frames the VIEW.
              ...CUSTOM_VIEW_IDS.map((v) => ({
                type: 'checkbox' as const,
                id: `cam-${v}`,
                label: CAMERA_VIEW_LABEL[v],
                checked: camera3dMode === v,
                onChange: () => setCamera3dMode(v),
              })),
            ],
          },
          {
            type: 'item',
            id: 'view-layout',
            label: `Layout: ${viewLayout === '4' ? '4 Views' : viewLayout === '2' ? '2 Views' : '1 View'}`,
            submenu: [
              {
                type: 'checkbox' as const,
                id: 'layout-1',
                label: '1 View',
                checked: viewLayout === '1',
                onChange: () => setViewLayout('1'),
              },
              {
                type: 'checkbox' as const,
                id: 'layout-2',
                label: '2 Views (view-only right pane)',
                checked: viewLayout === '2',
                onChange: () => setViewLayout('2'),
              },
              {
                type: 'checkbox' as const,
                id: 'layout-4',
                label: '4 Views (2×2 grid; top-left interactive)',
                checked: viewLayout === '4',
                onChange: () => setViewLayout('4'),
              },
            ],
          },
          {
            type: 'item',
            id: 'show-channel',
            label: `Show Channel: ${CHANNEL_LABEL[channel]}`,
            submenu: ([
              ['rgb', 'RGB (color)'],
              ['red', 'Red'],
              ['green', 'Green'],
              ['blue', 'Blue'],
              ['alpha', 'Alpha'],
            ] as const).map(([c, label]) => ({
              type: 'checkbox' as const,
              id: `channel-${c}`,
              label,
              checked: channel === c,
              onChange: () => setChannel(c),
            })),
          },
          { type: 'separator' },
          { type: 'checkbox', id: 'motion-path', label: 'Motion Paths', checked: motionPathVisible, onChange: () => toggleMotionPath() },
          {
            type: 'item',
            id: 'motion-path-dots',
            label: 'Motion Path Dots',
            submenu: [
              dotChoice('off', 'Off (curve only)'),
              dotChoice('small', 'Small'),
              dotChoice('medium', 'Medium'),
              dotChoice('large', 'Large'),
            ],
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'resolution',
            label: `Resolution: ${RESOLUTION_LABELS[previewResolution]}`,
            submenu: ([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
              type: 'checkbox' as const,
              id: `res-${r}`,
              label: RESOLUTION_LABELS[r],
              checked: previewResolution === r,
              onChange: () => setResolution(r),
            })),
          },
          { type: 'checkbox', id: 'auto-keyframe', label: 'Auto-Keyframe Mode', checked: autoKeyframe, onChange: setAutoKeyframe },
          { type: 'separator' },
          {
            type: 'item',
            id: 'roi',
            label: roi ? 'Region of Interest: on' : 'Region of Interest',
            submenu: [
              // Drag the region on the canvas after setting it (the handles are
              // painted by the renderer); these are the quick set/clear entries.
              { type: 'checkbox' as const, id: 'roi-on', label: 'Restrict to Region', checked: !!roi, onChange: (on: boolean) => (on ? setCentreRoi() : setRoi(null)) },
              { type: 'item' as const, id: 'roi-centre', label: 'Region to Centre', onSelect: setCentreRoi },
              { type: 'item' as const, id: 'roi-clear', label: 'Clear Region', disabled: !roi, onSelect: () => setRoi(null) },
            ],
          },
        ]}
      />
    </div>
  );
}
