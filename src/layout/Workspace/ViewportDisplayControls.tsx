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
 * ## The set, left to right
 *
 *   Layout · Channel · Resolution · Preview · LUT · Overlays · Snapshot +
 *   Compare · Display mode · Bookmarks · Pop out
 *
 * Overlays is new and REPLACES the loose toggles: grid, rulers, safe areas,
 * smart guides, guides (+ lock / clear), motion-path dots, HUD, snap to
 * pixel, pixel aspect correction and the overlay-opacity slider, one menu.
 *
 * ## Shedding
 *
 * The transport bar measures itself (`useTransportDemote`) and its ladder
 * (`TRANSPORT_DEMOTE_ORDER`) starts with these ten controls, shed from the
 * RIGHT one per level in `DISPLAY_DEMOTE_ORDER`, before the bar's own groups.
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

import { forwardRef, useMemo } from 'react';
import { useProjectStore } from '@stores/projectStore';
import { Icon, type IconName } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Kbd } from '@components/Kbd';
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
import { useViewerLutStore } from '@stores/viewerLutStore';
import { useCompareStore, COMPARE_MODE_LABEL, type CompareMode } from '@stores/compareStore';
import {
  useViewportDisplayStore,
  DISPLAY_MODE_LABEL,
  type DisplayMode,
} from '@stores/viewportDisplayStore';
import {
  BOOKMARK_SLOTS,
  bookmarksForActiveComp,
  recallCameraBookmark,
  removeCameraBookmark,
  saveCameraBookmark,
} from '@core/workspace/cameraBookmarks';
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
// the first ten rungs of that one now. Re-exported so importers keep reading
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

/** Open the viewport in its own window. Also reachable from the panel grip menu. */
export function popOutViewport(): void {
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

const DISPLAY_ICON: Record<DisplayMode, IconName> = {
  shaded: 'solid',
  wireframe: 'cube',
  bounds: 'frame',
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

/** The bookmark rows: nine slots, recall by click, save with Shift, clear with Alt. */
function useBookmarkItems(): { items: DropdownItem[]; count: number } {
  // Subscribed to the two things that change the answer — the bookmark table
  // and which comp is active — so a save from the keyboard or a comp switch
  // re-lists without a manual refresh.
  const table = useGuidesStore((s) => s.cameraBookmarks);
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const bookmarks = useMemo(() => {
    void table; void activeTabId;
    return bookmarksForActiveComp();
  }, [table, activeTabId]);
  const bySlot = useMemo(() => new Map(bookmarks.map((b) => [b.slot, b])), [bookmarks]);

  const items: DropdownItem[] = [
    { type: 'label', label: 'Ctrl+Alt+1…9 recalls · add Shift to save' },
    ...BOOKMARK_SLOTS.map<DropdownItem>((n) => {
      const b = bySlot.get(n);
      return {
        type: 'item',
        id: `vd-bookmark-${n}`,
        label: (
          <span className={styles.slotRow}>
            <Kbd chord={`Ctrl+Alt+${n}`} size="sm" className={styles.slotKey} />
            <span className={b ? styles.slotName : `${styles.slotName} ${styles.slotEmpty}`}>
              {b ? b.name : 'Empty — Shift-click to save this view'}
            </span>
          </span>
        ),
        // Shift saves, Alt clears, a plain click recalls — the same three
        // gestures the keyboard has, so the popover teaches the keys.
        onSelect: (mods) => {
          if (mods.shiftKey) saveCameraBookmark(n);
          else if (mods.altKey && b) removeCameraBookmark(n);
          else if (b) recallCameraBookmark(n);
          else saveCameraBookmark(n);
        },
      };
    }),
  ];
  return { items, count: bookmarks.length };
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
  channel: ViewChannel;
  channelItems: DropdownItem[];
  resolution: PreviewResolution;
  resolutionItems: DropdownItem[];
  previewItems: DropdownItem[];
  lut: boolean;
  lutName: string | null;
  lutItems: DropdownItem[];
  overlayItems: DropdownItem[];
  overlaysActive: boolean;
  compareVisible: boolean;
  compareMode: CompareMode;
  compareItems: DropdownItem[];
  displayMode: DisplayMode;
  displayItems: DropdownItem[];
  bookmarkItems: DropdownItem[];
  bookmarkCount: number;
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
    { type: 'separator' },
    { type: 'label', label: '3D view' },
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

  // ── Resolution — the only resolution control in the app ────────────
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

  // ── Viewer LUT ─────────────────────────────────────────────────────
  const lut = useViewerLutStore((s) => s.lut);
  const lutName = useViewerLutStore((s) => s.name);
  const lutItems: DropdownItem[] = [
    { type: 'label', label: lut ? (lutName ?? 'Viewer LUT loaded') : 'No viewer LUT' },
    { type: 'item', id: 'vd-lut-load', label: 'Load .cube LUT…', icon: 'upload', onSelect: () => run(VIEWPORT_COMMAND_IDS.viewerLutLoad) },
    { type: 'item', id: 'vd-lut-clear', label: 'Clear Viewer LUT', disabled: !lut, onSelect: () => run(VIEWPORT_COMMAND_IDS.viewerLutClear) },
    { type: 'separator' },
    { type: 'label', label: 'A monitor look for this viewport only — never in output.' },
  ];

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

  // ── Display mode ───────────────────────────────────────────────────
  const displayMode = useViewportDisplayStore((s) => s.displayMode);
  const displayItems = (Object.keys(DISPLAY_MODE_LABEL) as DisplayMode[]).map<DropdownItem>((m) => ({
    type: 'checkbox',
    id: `vd-disp-${m}`,
    label: DISPLAY_MODE_LABEL[m],
    checked: displayMode === m,
    onChange: () => run(VIEWPORT_COMMAND_IDS.displayMode(m)),
  }));

  // ── Camera bookmarks ───────────────────────────────────────────────
  const bookmarks = useBookmarkItems();

  return {
    viewLayout,
    camera3dMode,
    layoutItems,
    channel,
    channelItems,
    resolution,
    resolutionItems,
    previewItems: preview.items,
    lut: !!lut,
    lutName: lutName ?? null,
    lutItems,
    overlayItems,
    overlaysActive,
    compareVisible,
    compareMode,
    compareItems,
    displayMode,
    displayItems,
    bookmarkItems: bookmarks.items,
    bookmarkCount: bookmarks.count,
  };
}

/**
 * The shed controls as menu rows, in row order — a shed dropdown is a submenu
 * of the same rows, a shed button an item. The host puts these in its own `⋯`.
 */
export function displayOverflowItems(m: ViewportDisplayModel, level: number): DropdownItem[] {
  const shed = (g: DisplayGroup): boolean => isDisplayShed(g, level);
  const overflow: DropdownItem[] = [];
  if (shed('layout')) overflow.push({ type: 'item', id: 'vd-of-layout', icon: LAYOUT_ICON[m.viewLayout], label: `Layout: ${LAYOUT_LABEL[m.viewLayout]}`, submenu: m.layoutItems });
  if (shed('channel')) overflow.push({ type: 'item', id: 'vd-of-channel', icon: CHANNEL_ICON[m.channel], label: `Channel: ${CHANNEL_LABEL[m.channel]}`, submenu: m.channelItems });
  if (shed('resolution')) overflow.push({ type: 'item', id: 'vd-of-resolution', label: `Resolution: ${RESOLUTION_LABELS[m.resolution]}`, submenu: m.resolutionItems });
  if (shed('preview')) overflow.push({ type: 'item', id: 'vd-of-preview', icon: 'tv', label: 'Preview', submenu: m.previewItems });
  if (shed('lut')) overflow.push({ type: 'item', id: 'vd-of-lut', icon: 'sliders-h', label: 'Viewer LUT', submenu: m.lutItems });
  if (shed('overlays')) overflow.push({ type: 'item', id: 'vd-of-overlays', icon: 'grid', label: 'Overlays', submenu: m.overlayItems });
  if (shed('compare')) {
    overflow.push({ type: 'item', id: 'vd-of-snapshot', icon: 'camera', label: 'Take Snapshot', shortcut: 'F5', onSelect: () => run(VIEWPORT_COMMAND_IDS.snapshot) });
    overflow.push({ type: 'item', id: 'vd-of-compare', icon: 'wipe', label: 'Compare', submenu: m.compareItems });
  }
  if (shed('displayMode')) overflow.push({ type: 'item', id: 'vd-of-display', icon: DISPLAY_ICON[m.displayMode], label: `Display: ${DISPLAY_MODE_LABEL[m.displayMode]}`, submenu: m.displayItems });
  if (shed('bookmarks')) overflow.push({ type: 'item', id: 'vd-of-bookmarks', icon: 'push-pin', label: 'Camera Bookmarks', submenu: m.bookmarkItems });
  if (shed('popout')) overflow.push({ type: 'item', id: 'vd-of-popout', icon: 'pop-out', label: 'Pop Out Viewport', onSelect: popOutViewport });
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
        <Dropdown
          placement="top-start"
          trigger={<Trigger icon={LAYOUT_ICON[m.viewLayout]} label={`Viewport layout: ${LAYOUT_LABEL[m.viewLayout]}${m.camera3dMode !== 'active' ? ` · ${cameraViewLabel(m.camera3dMode)}` : ''}`} active={m.viewLayout !== '1' || m.camera3dMode !== 'active'} chevron />}
          items={m.layoutItems}
        />
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
          {!shed('overlays') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon="grid" label="Overlays — grid, rulers, guides, HUD, overlay opacity" active={m.overlaysActive} chevron />}
              items={m.overlayItems}
            />
          )}
          {!shed('displayMode') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon={DISPLAY_ICON[m.displayMode]} label={`Display mode: ${DISPLAY_MODE_LABEL[m.displayMode]}`} active={m.displayMode !== 'shaded'} />}
              items={m.displayItems}
            />
          )}
          {!shed('channel') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon={CHANNEL_ICON[m.channel]} text={CHANNEL_LABEL[m.channel]} label={`Show channel: ${CHANNEL_LABEL[m.channel]}`} active={m.channel !== 'rgb'} />}
              items={m.channelItems}
            />
          )}
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
          {!shed('lut') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon="sliders-h" label={m.lut ? `Viewer LUT: ${m.lutName ?? 'loaded'}` : 'Viewer LUT'} active={m.lut} />}
              items={m.lutItems}
            />
          )}
          {!shed('bookmarks') && (
            <Dropdown
              placement="top-end"
              trigger={<Trigger icon="push-pin" label={`Camera bookmarks (${m.bookmarkCount} saved)`} active={m.bookmarkCount > 0} />}
              items={m.bookmarkItems}
            />
          )}
          {!shed('popout') && (
            <Trigger icon="pop-out" label="Pop out the viewport preview into its own window" onClick={popOutViewport} />
          )}
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
