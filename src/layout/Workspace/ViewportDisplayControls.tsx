/**
 * ViewportDisplayControls — how the frame is SHOWN, in the transport row
 * under the stage.
 *
 * ## Why here, and why one set
 *
 * These controls have had four homes in a row: a strip of their own above
 * the stage (`ViewportHeader`), the View Options menu in the transport bar,
 * four loose toggles at the end of the header, and the right end of the tabs
 * row. Each move was defensible and the sum was the complaint: "so many
 * duplicated buttons, too many headers" — and then, of the tabs row, "too
 * many buttons on the right". The transport row has free space to the right
 * of play, and it is already the row of the viewport's OTHER tools (motion
 * path, 3D, auto-keyframe, zoom), so the display controls sit there now,
 * between the scene tools and the zoom field; the tabs row is tabs, the lock
 * and the panel menu, nothing else. Every control here is the only one of
 * its kind in the app.
 *
 * ## The set
 *
 *   Left of play: 3D View · Layout · Snapshot + Compare.
 *   Right of play: Resolution · Preview · Transparency Grid · Overlays ·
 *   Channel · Exposure — AE's Composition panel footer, in its order.
 *
 * Viewer LUT and the display mode are rows of the Preview menu (and View ▸
 * Viewport); camera bookmarks are View ▸ Viewport rows and Ctrl+Alt+1…9; pop
 * out is a row of the Composition panel menu. They were buttons here too,
 * which made a 24-button row (2026-10-07).
 *
 * Overlays is new and REPLACES the loose toggles: grid, rulers, safe areas,
 * smart guides, guides (+ lock / clear), motion-path dots, HUD, snap to
 * pixel, pixel aspect correction and the overlay-opacity slider, one menu.
 *
 * ## Shedding
 *
 * The transport bar measures itself (`useTransportDemote`) and its ladder
 * (`TRANSPORT_DEMOTE_ORDER`) starts with these controls, shed one per level
 * in `DISPLAY_DEMOTE_ORDER`, before the bar's own zoom field.
 * A shed dropdown becomes a submenu with the same rows; a shed button becomes
 * an item. Nothing is ever merely hidden. The rows go into the BAR's `⋯`
 * menu — `displayOverflowItems` builds them, `TransportBar` renders them —
 * so the row has one overflow trigger, not one per cluster. Standalone (the
 * tests, an embed) the component renders its own trigger.
 *
 * ## Every button is a command
 *
 * Nothing here holds behaviour. Each control dispatches a registered command
 * from `viewportCommands.ts` or writes one store field, so the key, the
 * palette entry, the menu row and this button are the same code path.
 */

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { CUSTOM_VIEW_IDS } from '@core/workspace/customViews';
import { useGuidesStore, CAMERA_ORTHO_VIEWS, type Camera3dMode, type ViewChannel, type ViewLayout } from '@stores/guidesStore';
import {
  useRenderQualityStore,
  RESOLUTION_LABELS,
  RESOLUTION_PERCENT,
  type PreviewResolution,
} from '@stores/renderQualityStore';
import { useCompareStore, COMPARE_MODE_LABEL, type CompareMode } from '@stores/compareStore';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import { useActiveCompRootId } from '@hooks/useMirrorFrame';
import {
  PreviewMenu,
  usePreviewMenuItems,
  CAMERA_VIEW_LABEL,
  cameraViewLabel,
  effectiveViewMode,
  useCompCameraViews,
} from '@layout/TopNav/ViewControls';
import { VIEWPORT_COMMAND_IDS } from './viewportCommands';
import { isDisplayShed, type DisplayGroup } from './transportOverflow';
import styles from './ViewportDisplayControls.module.css';

// The ladder lives with the transport bar's, in `transportOverflow.ts` — it is
// the first rungs of that one now. Re-exported so importers keep reading
// it from the component that walks it.
export { DISPLAY_DEMOTE_ORDER, isDisplayShed, type DisplayGroup } from './transportOverflow';

/**
 * Run a registered command by id — through `CommandSystem`, not the registry,
 * so the enabled check, the context build and the undo push are the same ones
 * the keyboard and the palette get.
 */
function run(id: string): void {
  void getCommandSystem().execute(asCommandId(id));
}

/** Open the viewport in its own window — the Composition panel menu's Pop Out row. */
export function popOutViewport(): void {
  // Through the desktop's pop-out channel, as panels pop out: a `window.open`
  // child is not a window main knows, so the engine had nowhere to send its
  // frames and the pop-out sat on "Waiting for the first frame".
  if (window.motionEditor?.popout?.spawnWindow) {
    window.motionEditor.popout.spawnWindow('viewport');
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}#/popout/viewport`;
  window.open(url, 'popout-viewport', 'width=1280,height=720,resizable=yes');
}

const CHANNEL_ICON: Record<ViewChannel, IconName> = {
  rgb: 'palette',
  red: 'circle',
  green: 'circle',
  blue: 'circle',
  alpha: 'mask-circle',
};

const CHANNEL_LABEL: Record<ViewChannel, string> = {
  rgb: 'RGB',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
  alpha: 'Alpha',
};

const LAYOUT_LABEL: Record<ViewLayout, string> = {
  '1': '1 View',
  '2': '2 Views',
  '4': '4 Views',
};

const LAYOUT_ICON: Record<ViewLayout, IconName> = {
  '1': 'square',
  '2': 'panel-left',
  '4': 'grid',
};

/** The user's guides, or none when the engine is not up (tests, the popout). */
function userGuides(): ReadonlyArray<{ locked: boolean }> {
  try {
    return getWorkspaceController().ws.guides.list().filter((g) => g.kind === 'user');
  } catch {
    return [];
  }
}

interface TriggerProps {
  icon?: IconName;
  label: string;
  text?: string;
  active?: boolean;
  disabled?: boolean;
  chevron?: boolean;
  onClick?: () => void;
}

/**
 * One control in the row: an `aria-label` and a `title` that say the same
 * thing, so the hover matches the announcement — the strip is too dense for
 * a tooltip layer. None of these is a toggle (every setting is a menu row or
 * an action), so there is no `aria-pressed`; `active` only tints the glyph to
 * say the setting is away from its default. `Popover` clones a dropdown
 * trigger with its own `onClick`, which is why nothing here keys off it.
 */
const Trigger = forwardRef<HTMLButtonElement, TriggerProps>(function Trigger(
  { icon, label, text, active, disabled, chevron, onClick },
  ref,
): JSX.Element {
  // `Popover` positions its menu off the trigger's DOM node, reached through
  // the ref it clones in — a plain function component here would swallow it
  // and every menu would open at the page's origin.
  return (
    <button
      ref={ref}
      type="button"
      className={cn(styles.control, active && styles.controlActive)}
      aria-label={label}
      title={label}
      disabled={disabled ?? false}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} size="sm" /> : null}
      {text ? <span className={styles.text}>{text}</span> : null}
      {chevron ? <Icon name="chevron-down" size="sm" className={styles.chevron} /> : null}
    </button>
  );
});

/** Exposure as AE's footer prints it: signed, one decimal. */
export function formatStops(stops: number): string {
  return `${stops > 0 ? '+' : ''}${stops.toFixed(1)}`;
}

/** The exposure presets, for the overflow menu when the field is shed. */
function exposureMenuItems(m: Pick<ViewportDisplayModel, 'exposure' | 'setExposure'>): DropdownItem[] {
  return [-2, -1, 0, 1, 2].map<DropdownItem>((stops) => ({
    type: 'checkbox',
    id: `vd-exposure-${stops}`,
    label: stops === 0 ? 'Reset Exposure (0.0)' : formatStops(stops),
    checked: Math.abs(m.exposure - stops) < 0.05,
    onChange: () => m.setExposure(stops),
  }));
}

/**
 * AE's Adjust Exposure: the icon resets to 0 (lit while it is not 0), the value
 * scrubs by dragging (0.1 stop per pixel) or is typed after a double-click.
 * The viewer only — no render, no export, no undo (setViewport `exposure`).
 */
function ExposureControl({ stops, onChange }: { stops: number; onChange: (stops: number) => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startV = stops;
    const move = (me: PointerEvent): void => onChange(Math.round((startV + (me.clientX - startX) * 0.1) * 10) / 10);
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      stopDrag.current = null;
    };
    stopDrag.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [stops, onChange]);
  const commit = (): void => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) onChange(v);
    setEditing(false);
  };
  return (
    <span className={styles.exposure} role="group" aria-label="Exposure">
      <button
        type="button"
        className={cn(styles.control, stops !== 0 && styles.controlActive)}
        aria-label={stops !== 0 ? `Reset Exposure (now ${formatStops(stops)})` : 'Adjust Exposure'}
        title={stops !== 0 ? `Exposure ${formatStops(stops)} stops — click to reset (viewer only)` : 'Adjust Exposure — drag the value; viewer only, never in output'}
        onClick={() => onChange(0)}
      >
        <Icon name="theme" size="sm" />
      </button>
      {editing ? (
        <input
          className={styles.exposureInput}
          aria-label="Exposure in stops"
          value={raw}
          autoFocus
          onChange={(e) => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span
          className={styles.exposureValue}
          role="spinbutton"
          aria-label="Exposure in stops"
          aria-valuenow={stops}
          aria-valuemin={-40}
          aria-valuemax={40}
          tabIndex={0}
          title="Exposure (stops) · drag or double-click to type"
          onPointerDown={onPointerDown}
          onDoubleClick={() => {
            setRaw(stops.toFixed(1));
            setEditing(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') onChange(Math.round((stops + 0.1) * 10) / 10);
            if (e.key === 'ArrowDown') onChange(Math.round((stops - 0.1) * 10) / 10);
          }}
        >
          {formatStops(stops)}
        </span>
      )}
    </span>
  );
}

/**
 * Everything the controls read and every menu they open, gathered once.
 *
 * A hook rather than local state in the component so the HOST of the row can
 * build the same rows into its own overflow menu without subscribing to the
 * eleven stores a second time: `TransportBar` calls this once and hands the
 * result to both `ViewportDisplayControlsView` and `displayOverflowItems`.
 */
export interface ViewportDisplayModel {
  viewLayout: ViewLayout;
  /** The view on screen — a camera view whose camera is gone reads 'active'. */
  camera3dMode: Camera3dMode;
  layoutItems: DropdownItem[];
  /** The 3D view choices (Active Camera, each camera, the ortho and custom views). */
  viewItems: DropdownItem[];
  channel: ViewChannel;
  channelItems: DropdownItem[];
  resolution: PreviewResolution;
  resolutionItems: DropdownItem[];
  previewItems: DropdownItem[];
  /** The Preview menu's trigger is lit: something cheaper than the real frame is on. */
  previewDegraded: boolean;
  overlayItems: DropdownItem[];
  overlaysActive: boolean;
  compareVisible: boolean;
  compareMode: CompareMode;
  compareItems: DropdownItem[];
  /** AE's Adjust Exposure (stops, viewer only) and Toggle Transparency Grid. */
  exposure: number;
  setExposure: (stops: number) => void;
  transparencyGrid: boolean;
  toggleTransparencyGrid: () => void;
}

export function useViewportDisplayModel(): ViewportDisplayModel {
  // ── Layout / 3D view ───────────────────────────────────────────────
  const viewLayout = useGuidesStore((s) => s.viewLayout);
  const setViewLayout = useGuidesStore((s) => s.setViewLayout);
  const storeCameraMode = useGuidesStore((s) => s.camera3dMode);
  const setCamera3dMode = useGuidesStore((s) => s.setCamera3dMode);
  // Every camera in the active comp, by layer name, right under Active Camera
  // — AE's 3D View list. Looking through a camera that is not the topmost is
  // the only way to preview it without reordering the stack.
  const compId = useActiveCompRootId();
  const cameraViews = useCompCameraViews(compId);
  // A stale camera view renders as the Active Camera; tick and label it so.
  const camera3dMode = effectiveViewMode(storeCameraMode, compId);
  const layoutItems: DropdownItem[] = [
    ...(['1', '2', '4'] as ViewLayout[]).map<DropdownItem>((n) => ({
      type: 'checkbox',
      id: `vd-layout-${n}`,
      label: n === '1' ? '1 View' : n === '2' ? '2 Views — side by side, each with its own camera' : '4 Views — 2×2 grid, each with its own camera',
      checked: viewLayout === n,
      onChange: () => setViewLayout(n),
    })),
  ];
  // AE's 3D View popup — its own menu beside the layout, as in AE's
  // Composition panel footer ("Active Camera ▾" then "1 View ▾").
  const viewItems: DropdownItem[] = [
    { type: 'checkbox', id: 'vd-cam-active', label: 'Active Camera', checked: camera3dMode === 'active', onChange: () => setCamera3dMode('active') },
    ...cameraViews.map<DropdownItem>((c) => ({
      type: 'checkbox',
      id: `vd-cam-node-${c.nodeId}`,
      label: c.label,
      checked: camera3dMode === c.mode,
      onChange: () => setCamera3dMode(c.mode),
    })),
    ...CAMERA_ORTHO_VIEWS.map<DropdownItem>((v) => ({
      type: 'checkbox',
      id: `vd-cam-${v}`,
      label: CAMERA_VIEW_LABEL[v],
      checked: camera3dMode === v,
      onChange: () => setCamera3dMode(v),
    })),
    // Custom views (AE parity): navigable perspective views that never touch
    // the scene camera — Alt+drag/wheel re-frames the VIEW.
    ...CUSTOM_VIEW_IDS.map<DropdownItem>((v) => ({
      type: 'checkbox',
      id: `vd-cam-${v}`,
      label: CAMERA_VIEW_LABEL[v],
      checked: camera3dMode === v,
      onChange: () => setCamera3dMode(v),
    })),
  ];

  // ── Channel ────────────────────────────────────────────────────────
  const channel = useGuidesStore((s) => s.channel);
  const setChannel = useGuidesStore((s) => s.setChannel);
  const channelItems = (['rgb', 'red', 'green', 'blue', 'alpha'] as ViewChannel[]).map<DropdownItem>((c) => ({
    type: 'checkbox',
    id: `vd-channel-${c}`,
    label: c === 'rgb' ? 'RGB (colour)' : CHANNEL_LABEL[c],
    checked: channel === c,
    onChange: () => setChannel(c),
  }));

  // ── Resolution (also the Preview panel's) ──────────────────────────
  const resolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);
  const resolutionItems = ([1, 2, 3, 4] as PreviewResolution[]).map<DropdownItem>((r) => ({
    type: 'checkbox',
    id: `vd-res-${r}`,
    label: `${RESOLUTION_LABELS[r]} · ${RESOLUTION_PERCENT[r]}`,
    checked: resolution === r,
    onChange: () => setResolution(r),
  }));

  // ── Preview ────────────────────────────────────────────────────────
  const preview = usePreviewMenuItems();

  // ── Overlays ───────────────────────────────────────────────────────
  const grid = useGuidesStore((s) => s.grid);
  const toggleGrid = useGuidesStore((s) => s.toggleGrid);
  const rulers = useGuidesStore((s) => s.rulers);
  const toggleRulers = useGuidesStore((s) => s.toggleRulers);
  const safeArea = useGuidesStore((s) => s.safeArea);
  const toggleSafeArea = useGuidesStore((s) => s.toggleSafeArea);
  const smartGuides = useGuidesStore((s) => s.smartGuides);
  const toggleSmartGuides = useGuidesStore((s) => s.toggleSmartGuides);
  const guidesVisible = useGuidesStore((s) => s.guidesVisible);
  const motionPathDots = useGuidesStore((s) => s.motionPathDots);
  const setMotionPathDots = useGuidesStore((s) => s.setMotionPathDots);
  const motionPathShow = useGuidesStore((s) => s.motionPathShow);
  const motionPathWindowSeconds = useGuidesStore((s) => s.motionPathWindowSeconds);
  const setMotionPathShow = useGuidesStore((s) => s.setMotionPathShow);
  const setMotionPathWindowSeconds = useGuidesStore((s) => s.setMotionPathWindowSeconds);
  const overlayOpacity = useGuidesStore((s) => s.overlayOpacity);
  const setOverlayOpacity = useGuidesStore((s) => s.setOverlayOpacity);
  const hud = useViewportDisplayStore((s) => s.hud);
  const snapToPixel = useViewportDisplayStore((s) => s.snapToPixel);
  const par = useViewportDisplayStore((s) => s.pixelAspectCorrection);
  const guides = userGuides();
  const dotChoice = (id: 'off' | 'small' | 'medium' | 'large', label: string): DropdownItem => ({
    type: 'checkbox',
    id: `vd-mp-dots-${id}`,
    label,
    checked: motionPathDots === id,
    onChange: () => setMotionPathDots(id),
  });
  const overlayItems: DropdownItem[] = [
    { type: 'checkbox', id: 'vd-grid', label: 'Grid', checked: grid, onChange: toggleGrid },
    { type: 'checkbox', id: 'vd-rulers', label: 'Rulers', checked: rulers, onChange: toggleRulers },
    { type: 'checkbox', id: 'vd-safe-area', label: 'Safe Areas', checked: safeArea, onChange: toggleSafeArea },
    // Measurement badges, equal-spacing and equal-size snapping while a drag
    // is in flight; Alt-hover measures between two layers.
    { type: 'checkbox', id: 'vd-smart-guides', label: 'Smart Guides', checked: smartGuides, onChange: toggleSmartGuides },
    { type: 'checkbox', id: 'vd-guides', label: 'Guides', checked: guidesVisible, onChange: () => run(VIEWPORT_COMMAND_IDS.guidesShow) },
    { type: 'separator' },
    { type: 'item', id: 'vd-guides-lock', label: 'Lock Guides', icon: 'lock', disabled: !guides.some((g) => !g.locked), onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesLock) },
    { type: 'item', id: 'vd-guides-unlock', label: 'Unlock Guides', icon: 'unlock', disabled: !guides.some((g) => g.locked), onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesUnlock) },
    { type: 'item', id: 'vd-guides-clear', label: 'Clear Guides', icon: 'trash', disabled: guides.length === 0, onSelect: () => run(VIEWPORT_COMMAND_IDS.guidesClear) },
    { type: 'separator' },
    {
      type: 'item',
      id: 'vd-motion-path-dots',
      label: 'Motion Path Dots',
      submenu: [
        dotChoice('off', 'Off (curve only)'),
        dotChoice('small', 'Small'),
        dotChoice('medium', 'Medium'),
        dotChoice('large', 'Large'),
      ],
    },
    {
      // AE Preferences ▸ Display ▸ Motion Path: how much of the path to draw.
      type: 'item',
      id: 'vd-motion-path-show',
      label: 'Motion Path Keyframes',
      submenu: [
        { type: 'checkbox', id: 'vd-mp-show-all', label: 'All Keyframes', checked: motionPathShow === 'all', onChange: () => setMotionPathShow('all') },
        { type: 'checkbox', id: 'vd-mp-show-none', label: 'No Keyframes', checked: motionPathShow === 'none', onChange: () => setMotionPathShow('none') },
        { type: 'separator' },
        ...[1, 2, 5, 10].map<DropdownItem>((sec) => ({
          type: 'checkbox',
          id: `vd-mp-show-${sec}s`,
          label: `${sec} Second${sec === 1 ? '' : 's'} Around Playhead`,
          checked: motionPathShow === 'window' && motionPathWindowSeconds === sec,
          onChange: () => {
            setMotionPathWindowSeconds(sec);
            setMotionPathShow('window');
          },
        })),
      ],
    },
    { type: 'separator' },
    { type: 'checkbox', id: 'vd-hud', label: 'HUD — fps, frame time, cache and backend', checked: hud, onChange: () => run(VIEWPORT_COMMAND_IDS.hud) },
    { type: 'checkbox', id: 'vd-snap-pixel', label: 'Snap to Pixel', checked: snapToPixel, onChange: () => run(VIEWPORT_COMMAND_IDS.snapToPixel) },
    { type: 'checkbox', id: 'vd-par', label: 'Pixel Aspect Correction', checked: par, onChange: () => run(VIEWPORT_COMMAND_IDS.pixelAspectCorrection) },
    { type: 'separator' },
    {
      type: 'custom',
      id: 'vd-overlay-opacity',
      render: (
        <label className={styles.opacityRow}>
          <Icon name="layers" size="sm" />
          <span className={styles.opacityLabel}>Overlay opacity</span>
          <input
            type="range"
            className={styles.opacitySlider}
            min={20}
            max={100}
            step={5}
            value={Math.round(overlayOpacity * 100)}
            aria-label="Overlay opacity"
            onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
          />
          <span className={styles.text}>{Math.round(overlayOpacity * 100)}%</span>
        </label>
      ),
    },
  ];
  const overlaysActive = grid || rulers || safeArea || hud;

  // ── Snapshot / compare ─────────────────────────────────────────────
  const compareVisible = useCompareStore((s) => s.visible);
  const compareMode = useCompareStore((s) => s.mode);
  const snapshotCount = useCompareStore((s) => s.snapshots.length);
  const compareItems: DropdownItem[] = [
    { type: 'checkbox', id: 'vd-cmp-show', label: snapshotCount === 0 ? 'Show Snapshot — take one first (F5)' : 'Show Snapshot (Shift+F5)', checked: compareVisible, disabled: snapshotCount === 0, onChange: () => run(VIEWPORT_COMMAND_IDS.compareToggle) },
    { type: 'separator' },
    ...(Object.keys(COMPARE_MODE_LABEL) as CompareMode[]).map<DropdownItem>((m) => ({
      type: 'checkbox',
      id: `vd-cmp-${m}`,
      label: COMPARE_MODE_LABEL[m],
      checked: compareMode === m,
      onChange: () => run(VIEWPORT_COMMAND_IDS.compareMode(m)),
    })),
    { type: 'separator' },
    { type: 'item', id: 'vd-cmp-flip', label: 'Flip A/B', disabled: !compareVisible, onSelect: () => run(VIEWPORT_COMMAND_IDS.compareFlip) },
    { type: 'item', id: 'vd-cmp-clear', label: `Clear ${snapshotCount} Snapshot${snapshotCount === 1 ? '' : 's'}`, disabled: snapshotCount === 0, onSelect: () => run(VIEWPORT_COMMAND_IDS.compareClear) },
  ];

  // ── Exposure / transparency grid (viewer only, AE's footer) ────────
  const exposure = useViewportDisplayStore((s) => s.exposure);
  const setExposure = useViewportDisplayStore((s) => s.setExposure);
  const transparencyGrid = useViewportDisplayStore((s) => s.transparencyGrid);
  const toggleTransparencyGrid = useViewportDisplayStore((s) => s.toggleTransparencyGrid);

  return {
    viewLayout,
    camera3dMode,
    layoutItems,
    viewItems,
    channel,
    channelItems,
    resolution,
    resolutionItems,
    previewItems: preview.items,
    previewDegraded: preview.degraded,
    overlayItems,
    overlaysActive,
    compareVisible,
    compareMode,
    compareItems,
    exposure,
    setExposure,
    transparencyGrid,
    toggleTransparencyGrid,
  };
}

/**
 * The shed controls as menu rows, in row order — a shed dropdown is a submenu
 * of the same rows, a shed button an item. The host puts these in its own `⋯`.
 */
export function displayOverflowItems(m: ViewportDisplayModel, level: number): DropdownItem[] {
  const shed = (g: DisplayGroup): boolean => isDisplayShed(g, level);
  const overflow: DropdownItem[] = [];
  if (shed('layout')) {
    overflow.push({ type: 'item', id: 'vd-of-3dview', icon: 'cube', label: `3D View: ${cameraViewLabel(m.camera3dMode)}`, submenu: m.viewItems });
    overflow.push({ type: 'item', id: 'vd-of-layout', icon: LAYOUT_ICON[m.viewLayout], label: `Layout: ${LAYOUT_LABEL[m.viewLayout]}`, submenu: m.layoutItems });
  }
  if (shed('channel')) overflow.push({ type: 'item', id: 'vd-of-channel', icon: CHANNEL_ICON[m.channel], label: `Channel: ${CHANNEL_LABEL[m.channel]}`, submenu: m.channelItems });
  if (shed('resolution')) overflow.push({ type: 'item', id: 'vd-of-resolution', label: `Resolution: ${RESOLUTION_LABELS[m.resolution]}`, submenu: m.resolutionItems });
  if (shed('preview')) overflow.push({ type: 'item', id: 'vd-of-preview', icon: 'tv', label: 'Preview', submenu: m.previewItems });
  if (shed('transparency')) overflow.push({ type: 'checkbox', id: 'vd-of-transparency', label: 'Transparency Grid', checked: m.transparencyGrid, onChange: m.toggleTransparencyGrid });
  if (shed('overlays')) overflow.push({ type: 'item', id: 'vd-of-overlays', icon: 'grid', label: 'Overlays', submenu: m.overlayItems });
  if (shed('exposure')) overflow.push({ type: 'item', id: 'vd-of-exposure', icon: 'theme', label: `Exposure: ${formatStops(m.exposure)}`, submenu: exposureMenuItems(m) });
  if (shed('compare')) {
    overflow.push({ type: 'item', id: 'vd-of-snapshot', icon: 'camera', label: 'Take Snapshot', shortcut: 'F5', onSelect: () => run(VIEWPORT_COMMAND_IDS.snapshot) });
    overflow.push({ type: 'item', id: 'vd-of-compare', icon: 'wipe', label: 'Compare', submenu: m.compareItems });
  }
  return overflow;
}

export interface ViewportDisplayControlsViewProps {
  model: ViewportDisplayModel;
  /** How many controls the row has shed, from the right. 0 = all shown. */
  level?: number;
  /**
   * Who renders the shed rows. `own` — this group appends its own `⋯`
   * trigger (the standalone form). `host` — the row that mounts the group
   * lists them in its own overflow menu (`displayOverflowItems`), so the
   * group renders nothing for what it has shed.
   */
  overflow?: 'own' | 'host';
  /**
   * Section filter to allow distributing controls across left and right sides of Play:
   * - 'layout': just the viewport layout dropdown
   * - 'compare': take snapshot + compare dropdown
   * - 'right': overlays, display mode, channel, resolution, preview, lut, bookmarks, popout
   * - 'all': all controls (default, standalone form)
   */
  section?: 'layout' | 'compare' | 'right' | 'all';
}

/**
 * The controls, from a model the host already holds. Menus open UPWARD
 * (`top-end` / `top-start`): the row sits at the bottom of the viewport, over the timeline.
 */
export function ViewportDisplayControlsView({
  model: m,
  level = 0,
  overflow = 'own',
  section = 'all',
}: ViewportDisplayControlsViewProps): JSX.Element {
  const shed = (g: DisplayGroup): boolean => isDisplayShed(g, level);
  const ownOverflow = overflow === 'own' ? displayOverflowItems(m, level) : [];

  const showLayout = (section === 'all' || section === 'layout') && !shed('layout');
  const showCompare = (section === 'all' || section === 'compare') && !shed('compare');
  const showRight = section === 'all' || section === 'right';

  const groupLabel =
    section === 'layout'
      ? 'Viewport layout'
      : section === 'compare'
      ? 'Viewport snapshots'
      : 'Viewport display';

  return (
    <div
      className={styles.root}
      role="group"
      aria-label={groupLabel}
      data-viewport-display={section !== 'all' ? section : ''}
    >
      {showLayout && (
        <>
          <Dropdown
            placement="top-start"
            trigger={<Trigger text={cameraViewLabel(m.camera3dMode)} label={`3D View: ${cameraViewLabel(m.camera3dMode)}`} active={m.camera3dMode !== 'active'} chevron />}
            items={m.viewItems}
          />
          <Dropdown
            placement="top-start"
            trigger={<Trigger icon={LAYOUT_ICON[m.viewLayout]} label={`Viewport layout: ${LAYOUT_LABEL[m.viewLayout]}`} active={m.viewLayout !== '1'} chevron />}
            items={m.layoutItems}
          />
        </>
      )}

      {showCompare && (
        <>
          <Trigger icon="camera" label="Take Snapshot (F5) — freeze this frame for comparison" onClick={() => run(VIEWPORT_COMMAND_IDS.snapshot)} />
          <Dropdown
            placement="top-start"
            trigger={<Trigger icon="wipe" label={m.compareVisible ? `Compare: ${COMPARE_MODE_LABEL[m.compareMode]} (on)` : 'Compare snapshots'} active={m.compareVisible} chevron />}
            items={m.compareItems}
          />
        </>
      )}

      {showRight && (
        <>
          {!shed('resolution') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger text={RESOLUTION_LABELS[m.resolution]} label={`Preview resolution: ${RESOLUTION_LABELS[m.resolution]}`} active={m.resolution !== 1} chevron />}
              items={m.resolutionItems}
            />
          )}
          {!shed('preview') && (
            <PreviewMenu className={styles.control} activeClassName={cn(styles.control, styles.controlActive)} placement="top-end" />
          )}
          {!shed('transparency') && (
            <button
              type="button"
              className={cn(styles.control, m.transparencyGrid && styles.controlActive)}
              aria-label="Toggle Transparency Grid"
              aria-pressed={m.transparencyGrid}
              title={m.transparencyGrid ? 'Transparency Grid: on — transparent areas show a checkerboard' : 'Transparency Grid: off — transparent areas show the background colour'}
              onClick={m.toggleTransparencyGrid}
            >
              <Icon name="mask-square" size="sm" />
            </button>
          )}
          {!shed('overlays') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon="grid" label="Overlays — grid, rulers, guides, HUD, overlay opacity" active={m.overlaysActive} chevron />}
              items={m.overlayItems}
            />
          )}
          {!shed('channel') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon={CHANNEL_ICON[m.channel]} text={CHANNEL_LABEL[m.channel]} label={`Show channel: ${CHANNEL_LABEL[m.channel]}`} active={m.channel !== 'rgb'} />}
              items={m.channelItems}
            />
          )}
          {!shed('exposure') && <ExposureControl stops={m.exposure} onChange={m.setExposure} />}
          {ownOverflow.length > 0 && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon="more-horizontal" label={`More display controls (${ownOverflow.length})`} />}
              items={ownOverflow}
            />
          )}
        </>
      )}
    </div>
  );
}

export interface ViewportDisplayControlsProps {
  /** How many controls the row has shed, from the right. 0 = all shown. */
  level?: number;
}

/** The standalone form: reads its own model and renders its own `⋯`. */
export function ViewportDisplayControls({ level = 0 }: ViewportDisplayControlsProps): JSX.Element {
  const model = useViewportDisplayModel();
  return <ViewportDisplayControlsView model={model} level={level} overflow="own" />;
}
