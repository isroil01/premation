import { useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore, CAMERA_ORTHO_VIEWS, type Camera3dMode, type ViewChannel } from '@stores/guidesStore';
import { CUSTOM_VIEW_IDS, CUSTOM_VIEW_LABEL } from '@core/workspace/customViews';
import { usePreferenceStore } from '@stores/preferenceStore';
import {
  useRenderQualityStore,
  RESOLUTION_LABELS,
  RESOLUTION_PERCENT,
  type AdaptiveFloor,
  type PreviewResolution,
} from '@stores/renderQualityStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useOnionSkinStore } from '@stores/onionSkinStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { Dropdown } from '@components/Dropdown';
import { OnionSkinSettingsPopover } from '@layout/BottomTimeline/OnionSkinSettings';
import { cacheWorkAreaNow, installPreviewCacheCommands } from '@layout/Timeline/previewCacheCommands';
import { describePreviewCache, previewCacheStats } from '@layout/Timeline/previewCacheStats';
import { useTransportOverflow } from '@layout/Workspace/transportOverflow';
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
  const smartGuides = useGuidesStore((s) => s.smartGuides);
  const toggleSmartGuides = useGuidesStore((s) => s.toggleSmartGuides);
  const setCamera3dMode = useGuidesStore((s) => s.setCamera3dMode);

  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const setAutoKeyframe = (v: boolean) => usePreferenceStore.getState().set('timelineAutoKeyframe', v);

  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);
  const motionPathDots = useGuidesStore((s) => s.motionPathDots);
  const setMotionPathDots = useGuidesStore((s) => s.setMotionPathDots);

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

  // Controls the transport bar could not fit — see `transportOverflow`.
  const overflow = useTransportOverflow((st) => st.items);

  return (
    <div className={styles.toolGroup}>
      <PreviewMenu roi={roi} setRoi={setRoi} setCentreRoi={setCentreRoi} />

      {/* View Options & Overlays Dropdown */}
      <Dropdown
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className={styles.toolDropdownTrigger}
            title="View Options"
          >
            {/* `sm`, like every other glyph in the transport bar this renders
                into. At `md` it was a size above its neighbours and, with the
                chevron beside it, read as the one important button in the row. */}
            <Icon name="sliders-h" size="sm" />
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
        items={[
          { type: 'checkbox', id: 'grid', label: 'Grid', checked: grid, onChange: toggleGrid },
          { type: 'checkbox', id: 'rulers', label: 'Rulers', checked: rulers, onChange: toggleRulers },
          { type: 'checkbox', id: 'safe-area', label: 'Safe Areas', checked: safeArea, onChange: toggleSafeArea },
          // Measurement badges, equal-spacing and equal-size snapping while a
          // drag is in flight; Alt-hover measures between two layers.
          { type: 'checkbox', id: 'smart-guides', label: 'Smart Guides', checked: smartGuides, onChange: toggleSmartGuides },
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
            /*
              Multi-view layouts. These labels used to read "view-only right
              pane" and "top-left interactive", which stopped being true when
              `usePaneWorkspace` gave every pane its own Workspace: its own
              camera and framing, its own hit-tester bound to the view THAT pane
              shows, and global selection, so a click or an edit in any pane is
              the same undoable command it would be in the main viewport. The
              menu was talking people out of using panes they could already
              work in. The one thing still exclusive to the main viewport is the
              interactive 3D transform gizmo — panes draw the scene reference
              geometry (SceneGeometryOverlay) without its handles.
            */
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
                label: '2 Views (side by side; each interactive, own camera)',
                checked: viewLayout === '2',
                onChange: () => setViewLayout('2'),
              },
              {
                type: 'checkbox' as const,
                id: 'layout-4',
                label: '4 Views (2×2 grid; each interactive, own camera)',
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
          /*
            Resolution and Region of Interest used to sit here — resolution
            ALSO sat in the transport bar, so the same setting had two menus
            and each could show the other's stale label. Both are preview
            settings (what the renderer spends pixels on), so both moved into
            the Preview menu beside this one, which is now their only home.
          */
          { type: 'checkbox', id: 'auto-keyframe', label: 'Auto-Keyframe Mode', checked: autoKeyframe, onChange: setAutoKeyframe },
          /*
            Whatever the transport bar has shed to fit, appended under a rule.
            Last, so the menu's own entries never move as the window resizes —
            a menu whose items reorder while you reach for one is worse than a
            long menu. Empty at full width, so the separator goes with them.
          */
          ...(overflow.length ? [{ type: 'separator' as const }, ...overflow] : []),
        ]}
      />
    </div>
  );
}

/**
 * Live cache coverage, as the Preview menu's header line.
 *
 * Its own component so the sampling lives — and only lives — inside the open
 * menu: `Popover` mounts its children on open and unmounts them on close, so
 * this timer exists for exactly as long as somebody is reading it. Putting the
 * same numbers in `PreviewMenu`'s render would have made a control in the
 * transport bar re-render twice a second, for ever, to keep a string nobody was
 * looking at up to date.
 */
function PreviewCacheHeader(): JSX.Element {
  const [stats, setStats] = useState(previewCacheStats);
  useEffect(() => {
    const id = setInterval(() => setStats(previewCacheStats()), 500);
    return () => clearInterval(id);
  }, []);
  return <>{describePreviewCache(stats)}</>;
}

/**
 * The Preview menu — the one home for what the viewport spends its pixels on.
 *
 * Before this, preview settings were scattered across four surfaces: the
 * resolution picker existed TWICE (transport bar and View Options, each able to
 * show the other's stale label), motion blur / draft / onion skin sat in the
 * timeline's switch row among controls that change how the timeline LISTS
 * layers rather than what the renderer draws, adaptive resolution hid inside
 * the transport's quality submenu, and region of interest was in View Options.
 * They are all the same kind of setting — fidelity traded for speed — and they
 * are all here now.
 *
 * Draft 3D is deliberately a MIRROR: the 3D menu in `SceneControls` still owns
 * it for people working in that menu, and both read the same store, so neither
 * copy can drift.
 */
function PreviewMenu({
  roi,
  setRoi,
  setCentreRoi,
}: {
  roi: { x: number; y: number; width: number; height: number } | null;
  setRoi: (roi: null) => void;
  setCentreRoi: () => void;
}): JSX.Element {
  const useProxies = usePreferenceStore((p) => p.useProxies);
  const setPreference = usePreferenceStore((p) => p.set);
  const resolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const setAdaptive = useRenderQualityStore((s) => s.setAdaptive);
  const adaptiveFloor = useRenderQualityStore((s) => s.adaptiveFloor);
  const setAdaptiveFloor = useRenderQualityStore((s) => s.setAdaptiveFloor);
  const draftQuality = useRenderQualityStore((s) => s.draft);
  const setDraftQuality = useRenderQualityStore((s) => s.setDraft);

  const motionBlur = useMotionBlurStore((s) => s.enabled);
  const setMotionBlur = useMotionBlurStore((s) => s.setEnabled);

  const draft3d = useGuidesStore((s) => s.draft3d);
  const toggleDraft3d = useGuidesStore((s) => s.toggleDraft3d);

  const onionEnabled = useOnionSkinStore((s) => s.enabled);
  const toggleOnion = useOnionSkinStore((s) => s.toggle);

  // The cache actions are commands as well as buttons, so the palette and any
  // future menu row can reach them even with the timeline panel collapsed —
  // the cache lane's own group, which also installs them, unmounts with it.
  useEffect(() => {
    installPreviewCacheCommands();
  }, []);

  /** On when the viewport is showing something cheaper than the real thing. */
  const degraded = resolution !== 1 || draftQuality || draft3d;

  return (
    <>
      <Dropdown
        placement="top-end"
        trigger={
          <button
            type="button"
            className={degraded ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
            title="Preview quality, motion blur, onion skin, region of interest"
            aria-label="Preview"
          >
            <Icon name="tv" size="sm" />
            <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
          </button>
        }
        items={[
          { type: 'label', label: <PreviewCacheHeader /> },
          {
            type: 'item',
            id: 'preview-cache-now',
            label: 'Cache Work Area Now',
            icon: 'refresh',
            onSelect: cacheWorkAreaNow,
          },
          { type: 'separator' },
          {
            /*
              Full / Half / Third / Quarter, then Auto.

              "Auto" IS the adaptive-resolution flag: not a fifth fixed
              resolution but a rule about the other four — drop to the floor
              while a drag is in flight or playback is measured slow, never
              below what the user picked. Listing it as a sibling of the four is
              how AE's Fast Previews reads, and it keeps one setting from having
              two switches in one menu.
            */
            type: 'item',
            id: 'preview-resolution',
            label: `Resolution: ${RESOLUTION_LABELS[resolution]}${adaptive ? ' · Auto' : ''}`,
            submenu: [
              ...([1, 2, 3, 4] as PreviewResolution[]).map((r) => ({
                type: 'checkbox' as const,
                id: `res-${r}`,
                label: `${RESOLUTION_LABELS[r]} · ${RESOLUTION_PERCENT[r]}`,
                checked: resolution === r,
                onChange: () => setResolution(r),
              })),
              { type: 'separator' as const },
              {
                type: 'checkbox' as const,
                id: 'res-auto',
                label: `Auto — drop to ${RESOLUTION_LABELS[adaptiveFloor]} while dragging or when playback is slow`,
                checked: adaptive,
                onChange: setAdaptive,
              },
              ...([2, 3, 4] as AdaptiveFloor[]).map((f) => ({
                type: 'checkbox' as const,
                id: `res-floor-${f}`,
                label: `Auto floor: ${RESOLUTION_LABELS[f]}`,
                checked: adaptiveFloor === f,
                disabled: !adaptive,
                onChange: () => setAdaptiveFloor(f),
              })),
            ],
          },
          {
            // Proxies substitute pixels in the viewport only; export always
            // decodes the original, by construction (see proxyManager).
            type: 'checkbox' as const,
            id: 'preview-use-proxies',
            label: 'Use proxies — faster scrubbing, never in output',
            checked: useProxies,
            onChange: (v) => setPreference('useProxies', v),
          },
          { type: 'separator' },
          {
            type: 'checkbox',
            id: 'preview-motion-blur',
            label: 'Motion Blur',
            checked: motionBlur,
            onChange: setMotionBlur,
          },
          {
            /*
              The composition-wide motion-blur gate above and this one are a
              pair: Draft Quality skips the multi-sample pass, so motion blur
              can be ON and still cost nothing. The timeline's switch row
              labelled this "Draft 3D / Fast Preview", which named a DIFFERENT
              setting (the one below, in `guidesStore`) and sent people looking
              for lights and shadows.
            */
            type: 'checkbox',
            id: 'preview-draft-quality',
            label: 'Draft Quality — skip motion-blur samples',
            checked: draftQuality,
            onChange: setDraftQuality,
          },
          {
            type: 'checkbox',
            id: 'preview-draft-3d',
            label: 'Draft 3D — skip heavy lights & shadows',
            checked: draft3d,
            onChange: () => toggleDraft3d(),
          },
          { type: 'separator' },
          {
            type: 'checkbox',
            id: 'preview-onion-skin',
            label: 'Onion Skin — ghosts of nearby frames, while paused',
            checked: onionEnabled,
            onChange: () => toggleOnion(),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'preview-roi',
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

      {/*
        Onion skin's before / after / step / opacity, in the popover the
        timeline's switch row used to carry. Only while onion skinning is ON:
        these are working values you change WHILE looking at the ghosts, so with
        the feature off the chevron is a permanent button for a panel that
        cannot show you anything — and this row sheds controls under width
        pressure as it is.
      */}
      {onionEnabled && <OnionSkinSettingsPopover className={styles.tool} />}
    </>
  );
}
