import { useCallback, useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { useProjectLibrary, type OrientationFilter } from '@stores/projectLibraryStore';
import { Icon, type IconName } from '@components/Icon';
import { Logo } from '@components/Logo';
import { Checkbox } from '@components/Checkbox';
import { Pagination } from '@components/Pagination';
import { Modal, customConfirm } from '@components/Modal';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useUIStore } from '@stores/uiStore';
import { setPendingFootage } from '@core/project/pendingFootage';
import { AiSettingsSection } from '@layout/Settings/AiSettingsSection';
import { NativePluginsPage } from '@layout/Plugins/NativePluginsPage';
import { RegistryPluginsNotice } from '@layout/Plugins/RegistryPluginsNotice';
import { BillingSection } from '@layout/Settings/BillingSection';
import { AccountSection } from '@layout/Settings/AccountSection';
import { PlanCard } from '@layout/Settings/PlanCard';
import { billingEnabled } from '@core/config/edition';
import { hasDesktopChrome } from '@core/config/uiPlatform';
import { TITLE_BAR_ROUTE_SLOT_ID } from '@layout/TitleBar/routeSlot';
import { ColorPicker } from '@components/ColorPicker';
import { cn } from '@utils/cn';
import {
  SIZE_PRESETS, SIZE_GROUPS, FPS_PRESETS,
  MIN_DIMENSION, MAX_DIMENSION, MIN_DURATION, MAX_DURATION,
  clampDimension, clampFps, clampDuration, describeSize, describeDuration,
  aspectRatioLabel,
} from '@core/composition/presets';
import { purgeStoredAssets, type AssetFolder, type ImportedAsset } from '@stores/assetStore';
import { useMirrorAssetRecords, useMirrorFolders } from '@hooks/useAssetRecords';
import { edit } from '@core/engine/uiEdits';
import { engine, hasEngine } from '@core/engine/engineInstance';
import { getAssetVisualInfo, FOLDER_COLOR } from '@layout/Assets/assetVisuals';
import { createFolderEdit, createFolderTreeEdit, importBrowserFilesEdit, renameItemEdit } from '@layout/Assets/assetEdits';
import type { CompositionSettings } from '@stores/compositionStore';
import {
  api,
  type AccountRecord,
  type ProjectSummary,
  type RenderJobDto,
  type TrashedProject,
} from '@core/api/client';
import { projectLimitDetail } from '@core/api/transport';
import { usePagedList } from '@hooks/usePagedList';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import { clearRecovery } from '@core/persistence/recovery';
import { emptySceneProject } from '@core/scene/sceneProjectIO';
import type { EditorDocument } from '@core/api/cloudDocument';
import { DashboardCustomizeTab } from './DashboardCustomizeTab';
import { APP_VERSION } from '@layout/Help/whatsNew';
import { openWhatsNew } from '@layout/Help/WhatsNewDialog';
import { ReviewPrompt } from '@layout/Reviews/ReviewPrompt';
import { useReviewPromptStore } from '@stores/reviewPromptStore';
import styles from './DashboardPage.module.css';

/**
 * A stable hue for a project's fallback tile, from its id.
 *
 * Only reached when there is no poster frame. The point is not decoration: a
 * column of projects that have never been rendered used to be a column of
 * identical blue glyphs, so the tile actively made rows harder to tell apart.
 * A hue derived from the id is consistent across sessions and across pages —
 * the same project is the same colour in Projects, on Home and in the Trash —
 * so it becomes something you can actually recognise.
 *
 * FNV-1a, because it has to spread short similar ids (`p1`, `p2`) across the
 * wheel; summing char codes would put them next to each other.
 */
/**
 * "Read-only" on a project past the Free plan's cloud allowance.
 *
 * The server sets `readOnly` per row (the same rule that refuses its saves), so
 * the user learns it here rather than from a failed save after opening it.
 */
function ReadOnlyTag(): JSX.Element {
  return (
    <span
      className={styles.readOnlyTag}
      title="Past your plan's cloud project limit. It opens and exports, but does not save to the cloud."
    >
      <Icon name="lock" size="sm" />
      Read-only
    </span>
  );
}

function thumbHue(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}

function timeAgo(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const s = Math.max(1, Math.round((Date.now() - d) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * When a project was last touched, the way a file browser says it: relative
 * while that is the useful answer, a date once it is not.
 */
function lastEditedLabel(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const minutes = Math.round((Date.now() - d) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(d);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** A comp length as timecode — h:mm:ss:ff at the comp's own frame rate. */
function timecodeOf(seconds: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const frames = Math.max(0, Math.round(seconds * fps));
  const ff = frames % rate;
  const total = Math.floor(frames / rate);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}:${two(ff)}`;
}

/** "0.9" from "0.9.0" — how a release is named in prose. */
const RELEASE_LABEL = APP_VERSION.split('.').slice(0, 2).join('.');

type ProjectView = 'list' | 'grid';
const PROJECT_VIEW_KEY = 'premation.dashboard.projectView';
const NEWS_SEEN_KEY = 'premation.dashboard.newsSeen';

/** A per-machine convenience; a blocked or empty store just means the default. */
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window / blocked storage: the choice lasts for this session only */
  }
}

/**
 * Dashboard destinations.
 *
 * `billing` used to be a CARD inside `settings`, which made that page a scroll
 * of unrelated concerns — account, subscription, assistant — and left a
 * first-class surface with no address of its own.
 * "Show me my plan" was a link to a scroll POSITION
 * (`?tab=settings&section=billing`, followed by a `scrollIntoView`), which is
 * what a missing page looks like while something still has to link to it.
 */
type TabType =
  | 'home'
  | 'projects'
  | 'assets'
  | 'renders'
  | 'trash'
  | 'customize'
  | 'billing'
  | 'plugins'
  | 'settings';

const TABS: readonly TabType[] = [
  'home', 'projects', 'assets', 'renders', 'trash', 'customize', 'billing', 'plugins', 'settings',
];

/**
 * Narrow a `?tab=` value.
 *
 * Derived from TABS rather than restated. The initial-state reader and the
 * effect below used to carry two hand-written lists that had already drifted —
 * `plugins` was in one and not the other, so `?tab=plugins` opened Home and
 * then jumped to Plugins one render later. (`plugins` is back since 0.9 as the
 * native-plugins page — layout/Plugins/NativePluginsPage.)
 */
function isTab(value: string | null): value is TabType {
  return value != null && (TABS as readonly string[]).includes(value);
}

type Orientation = 'landscape' | 'portrait' | 'square';

interface NavItem {
  tab: TabType;
  label: string;
  icon: IconName;
}

/** The library: what you came here to open, import, export or recover. */
const NAV_LIBRARY: readonly NavItem[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'projects', label: 'Projects', icon: 'folder' },
  { tab: 'assets', label: 'Assets', icon: 'image' },
  { tab: 'renders', label: 'Render queue', icon: 'queue' },
  { tab: 'trash', label: 'Trash', icon: 'trash' },
];

/** The app's own setup. Account pages are in the account menu, top right. */
const NAV_APP: readonly NavItem[] = [
  { tab: 'plugins', label: 'Plugins', icon: 'plugin' },
  { tab: 'customize', label: 'Preferences', icon: 'sliders-h' },
];

/**
 * Render statuses, as a person would say them.
 *
 * `job.status.toUpperCase()` shouted RUNNING / QUEUED / FAILED at the reader
 * and, for `canceled`, spelled it the American way in a UI that is otherwise
 * British. A table maps the wire value to the label once.
 */
const RENDER_STATUS_LABEL: Record<RenderJobDto['status'], string> = {
  queued: 'Queued',
  running: 'Rendering',
  completed: 'Done',
  failed: 'Failed',
  canceled: 'Cancelled',
};

const VIDEO_ACCEPT = 'video/*,.mp4,.mov,.webm,.m4v,.mxf,.avi,.mts,.m2ts,.mpg,.wmv,.mkv';

/** Rows per page for the queue and the trash — both are read, not browsed. */
const TABLE_PAGE_SIZE = 20;
/** Cards per page in the asset grid. */
const ASSET_PAGE_SIZE = 24;

/**
 * The format filter's labels. Orientation is the axis that actually
 * distinguishes a reel from a YouTube cut, and it comes from the comp's own
 * size (the server filters on it — see projectLibraryStore).
 */
const ORIENTATION_LABEL: Record<Orientation, string> = {
  landscape: 'Landscape',
  portrait: 'Portrait',
  square: 'Square',
};

/** "24.5 MB" from a real byte count — the sizes used to be decorative strings. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/**
 * The Dashboard's library Delete — PERMANENT ("cannot be undone"): the items
 * leave the document through the engine (`removeItems`, with the layers that
 * use them), then their stored bytes are purged (local DB + cloud). An undo of
 * that entry would bring back records whose bytes are gone, so the history is
 * cleared with it — the delete is not undoable, as the dialog says.
 */
async function deletePermanentlyEdit(items: readonly string[], assets: readonly ImportedAsset[]): Promise<boolean> {
  if (items.length === 0) return false;
  const res = await edit('Delete', { type: 'removeItems', items: [...items], removeUsingLayers: true });
  if (!res.ok) return false;
  purgeStoredAssets(assets);
  await engine().execute({ type: 'clearHistory' });
  return true;
}

export function DashboardPage(): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  // The projects list is one PAGE of the library — `total` is the library.
  // Search, orientation and paging are all server-side; see projectLibraryStore.
  const {
    projects, total, limit, offset, orientation, status, busy, error,
    load, refresh: refreshProjects, create, remove, removeMany,
  } = useProjectLibrary();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // `?tab=settings` lets other surfaces deep-link here — the assistant's
  // "set up AI" prompt lands the user on the right page, not just this one.
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const t = searchParams.get('tab');
    return isTab(t) ? t : 'home';
  });

  useEffect(() => {
    const tab = searchParams.get('tab');
    // `?tab=settings&section=billing` is the address billing had before it was
    // a page. Honour it so an old link, a bookmark or a previously-sent email
    // still lands on billing rather than dropping the reader into Settings.
    if (tab === 'settings' && searchParams.get('section') === 'billing') {
      setActiveTab('billing');
      return;
    }
    if (isTab(tab)) setActiveTab(tab);
  }, [searchParams]);

  /** Go to a dashboard page, keeping the URL and the view in step. */
  const openTab = useCallback(
    (tab: TabType): void => {
      setActiveTab(tab);
      navigate(`/dashboard?tab=${tab}`);
    },
    [navigate],
  );

  // Search & Filter States for Projects. The orientation filter lives in the
  // store because it is part of the server query, not a view of loaded rows.
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<string>>(new Set());

  // The project's items (synchronized with the editor's Assets tab). B4: the document mirror's items as the
  // page's records — ItemInfo (the playable `mediaUrl`, probe facts, folders) with this session's half on top
  // (thumbnail URL, import time: src/stores/assetSession.ts); Delete Permanently releases those records' stored
  // bytes (`purgeStoredAssets`).
  const storeAssets = useMirrorAssetRecords();
  const folders = useMirrorFolders();
  // The asset store IS the document's item list (captureProjectItems saves every folder and item
  // in it), and a project opened in the editor stays loaded behind the dashboard — so these are
  // document writes. Folders go through the engine (createFolder / renameItem; off the editor
  // route `engine()` is a portless engine, which item commands do not need).

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);

  // Assets & renders — both come from the backend. They used to be hardcoded
  // arrays (`intro_backdrop.mp4`, a job frozen at "Rendering 45%") that ignored
  // the real /assets and /render endpoints entirely.
  const [assetTypeFilter, setAssetTypeFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const [assetsBusy, setAssetsBusy] = useState(false);
  const [assetPage, setAssetPage] = useState({ limit: ASSET_PAGE_SIZE, offset: 0 });
  const [dataError, setDataError] = useState('');
  // An action's error belongs to the page it happened on. This was one string
  // shown by Assets, Renders and Trash alike and never cleared, so a failure on
  // one page sat on top of the other two until a reload.
  useEffect(() => {
    setDataError('');
  }, [activeTab]);
  // Dialogs portal outside this page; the attribute carries the dashboard's
  // scale and dialog frame to them (Modal.module.css), and only while the
  // dashboard is mounted — the editor's dialogs never see it.
  useEffect(() => {
    document.documentElement.dataset.surface = 'dashboard';
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  // The title bar mounts above the routes, so its slot exists by the time this
  // effect runs; null in the browser build, which has no title bar.
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTitleSlot(hasDesktopChrome() ? document.getElementById(TITLE_BAR_ROUTE_SLOT_ID) : null);
  }, []);
  /** The Home numbers could not be loaded — so Home states none, rather than zeroes. */
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [projectView, setProjectView] = useState<ProjectView>(() =>
    readPref(PROJECT_VIEW_KEY) === 'grid' ? 'grid' : 'list',
  );
  const chooseProjectView = (view: ProjectView): void => {
    setProjectView(view);
    writePref(PROJECT_VIEW_KEY, view);
  };
  // The release banner is shown until closed, once per version.
  const [newsOpen, setNewsOpen] = useState(() => readPref(NEWS_SEEN_KEY) !== APP_VERSION);
  const dismissNews = (): void => {
    setNewsOpen(false);
    writePref(NEWS_SEEN_KEY, APP_VERSION);
  };
  /** Plan + credits, from /auth/me. The UI must not guess these. */
  const [account, setAccount] = useState<AccountRecord | null>(null);
  // Pro sales can be closed server-side; the sidebar then stops saying "View plans".
  const salesOpen = useProSalesOpen();
  /** The cloud project cap in force (null = none, incl. the beta and the launch grace). */
  const projectCap =
    account && account.access.reason !== 'beta' ? (account.access.limits?.cloudProjects ?? null) : null;

  /**
   * The render queue and the trash, a page at a time.
   *
   * Both used to be a single `{limit: 50}` fetch on mount, rendered as if 50
   * were all there is — and both are lists that only ever grow. They now load
   * when their tab is opened, and say how much they aren't showing.
   */
  const fetchRenders = useCallback(
    (page: { limit: number; offset: number }) => api.listRenders(page),
    [],
  );
  const renders = usePagedList<RenderJobDto>(fetchRenders, {
    pageSize: TABLE_PAGE_SIZE,
    enabled: activeTab === 'renders',
    errorMessage: 'Could not load the render queue.',
  });

  const fetchTrash = useCallback(
    (page: { limit: number; offset: number }) => api.listTrash(page),
    [],
  );
  const trash = usePagedList<TrashedProject>(fetchTrash, {
    pageSize: TABLE_PAGE_SIZE,
    enabled: activeTab === 'trash',
    errorMessage: 'Could not load the trash.',
  });

  /**
   * Library-wide numbers for the Home tab.
   *
   * Deliberately NOT derived from the loaded page: "Total Projects" counted the
   * rows in the browser, so it showed 24 for a 143-project account, and
   * "Active Renders" counted the running jobs among the newest 50. Both are now
   * a `total` from a one-row query, which is the count the server actually has.
   */
  const [overview, setOverview] = useState<{
    projects: number;
    activeRenders: number;
    /** Renders that ended badly and the user has not looked at yet. */
    failedRenders: number;
    recent: ProjectSummary | null;
  }>({ projects: 0, activeRenders: 0, failedRenders: 0, recent: null });

  const refreshOverview = useCallback(async (): Promise<void> => {
    try {
      // Four one-row queries rather than four lists: every number here is a
      // `total` the server already knows, and asking for the rows to count them
      // would download a library to display one integer.
      const [me, newest, active, failed] = await Promise.all([
        api.me(),
        api.listProjects({ limit: 1 }),
        api.listRenders({ limit: 1, status: 'active' }),
        api.listRenders({ limit: 1, status: 'failed' }),
      ]);
      setAccount(me);
      setOverviewFailed(false);
      setOverview({
        projects: newest.total,
        activeRenders: active.total,
        failedRenders: failed.total,
        recent: newest.items[0] ?? null,
      });
    } catch {
      setOverviewFailed(true);
    }
  }, []);

  // Workspace Setup Modal State
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [setupTitle, setSetupTitle] = useState('Untitled project');
  const [setupWidth, setSetupWidth] = useState(1920);
  const [setupHeight, setSetupHeight] = useState(1080);
  const [setupFps, setSetupFps] = useState(30);
  const [setupDuration, setSetupDuration] = useState(10);
  const [setupBg, setSetupBg] = useState('#101014');
  const [setupTransparent, setSetupTransparent] = useState(false);
  // "Start from a video" — AE's second way in, made visible at the moment it
  // matters. The chosen file is probed IN the modal (a metadata-only <video>
  // element: size and duration; the browser cannot report fps, the editor's
  // deeper probe refines that after import) so the fields below prefill to
  // exactly what the comp will be, still editable. The File itself rides
  // `pendingFootage` to the editor, which imports it and drops it in at full
  // frame.
  const [setupFootage, setSetupFootage] = useState<File | null>(null);
  /** Which way in the dialog is showing: a blank comp, or one matched to a video. */
  const [setupTab, setSetupTab] = useState<'blank' | 'video'>('blank');
  /** The preset the size came from; 'custom' once a dimension is typed. */
  const [setupPresetId, setSetupPresetId] = useState<string>('custom');
  /**
   * Lock aspect ratio. The ratio is HELD, not re-derived from the two fields on
   * each keystroke: typing "1920" passes through 1, 19 and 192, and a ratio
   * read back from those would be whatever the clamp left behind.
   */
  const [lockAspect, setLockAspect] = useState(true);
  const [lockedRatio, setLockedRatio] = useState(1920 / 1080);

  const setSize = (width: number, height: number): void => {
    setSetupWidth(width);
    setSetupHeight(height);
    if (width > 0 && height > 0) setLockedRatio(width / height);
  };

  const swapDimensions = (): void => {
    setSetupPresetId('custom');
    setSize(setupHeight, setupWidth);
  };

  const changeWidth = (width: number): void => {
    setSetupPresetId('custom');
    setSetupWidth(width);
    if (lockAspect && width > 0) setSetupHeight(Math.round(width / lockedRatio));
    else if (width > 0 && setupHeight > 0) setLockedRatio(width / setupHeight);
  };

  const changeHeight = (height: number): void => {
    setSetupPresetId('custom');
    setSetupHeight(height);
    if (lockAspect && height > 0) setSetupWidth(Math.round(height * lockedRatio));
    else if (height > 0 && setupWidth > 0) setLockedRatio(setupWidth / height);
  };

  const pickSetupVideo = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = VIDEO_ACCEPT;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) chooseSetupFootage(f);
    };
    input.click();
  };

  const chooseSetupFootage = (file: File): void => {
    setSetupFootage(file);
    setSetupTab('video');
    setSetupPresetId('custom');
    setSetupTitle(file.name.replace(/\.[a-z0-9]+$/i, '') || file.name);
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setSize(clampDimension(v.videoWidth), clampDimension(v.videoHeight));
      }
      if (Number.isFinite(v.duration) && v.duration > 0) setSetupDuration(clampDuration(v.duration));
      URL.revokeObjectURL(url);
    };
    v.onerror = () => URL.revokeObjectURL(url);
    v.src = url;
  };

  // NOTE: this page deliberately reads no editor preferences any more. It used
  // to subscribe to the WHOLE preference store — `usePreferenceStore` with no
  // selector, which re-renders the entire dashboard on any preference change —
  // in order to render controls that Customize already owned. Both the
  // duplication and the subscription are gone.

  // Search is server-side (the list is paged, so filtering here would only
  // filter the loaded page). Debounced so typing doesn't fire a query a
  // keystroke. `load` resets to page 1 when the query changes.
  useEffect(() => {
    const t = setTimeout(() => { void load({ query: searchQuery }); }, 250);
    return () => clearTimeout(t);
  }, [load, searchQuery]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  const considerReviewPrompt = useReviewPromptStore((s) => s.consider);

  /*
    Ask for a review, once, from someone who has actually made something.

    Armed by "has at least one project" — the trigger asked for — but fired on
    arrival here rather than at the instant a project is created: creating one
    navigates straight into the editor, so a dialog opened at that moment would
    flash past on the way out of the page.

    `consider` is a no-op after the first call per session and swallows its own
    failures, so this is safe on every mount and on every overview refresh.
  */
  useEffect(() => {
    if (overview.projects <= 0) return;
    void considerReviewPrompt({ hasProjects: true });
  }, [overview.projects, considerReviewPrompt]);

  // A different folder or media type is a different list — start it at page 1
  // rather than on whatever page number the previous one happened to be.
  useEffect(() => {
    setAssetPage((p) => (p.offset === 0 ? p : { ...p, offset: 0 }));
  }, [currentFolderId, assetTypeFilter]);

  // NOTE: the "Quick Start Launchpad" (four one-click preset-project cards)
  // was removed 2026-08-20 at the user's request. Project creation now has
  // exactly TWO ways in, both inside the Create Project modal: a blank
  // composition, or from an uploaded video — one door, clearly labelled,
  // instead of three surfaces that each created projects slightly differently.
  // The modal's size presets cover what the launchpad offered.

  const onCreate = () => {
    setSetupTitle('Untitled project');
    setSize(1920, 1080);
    setSetupTab('blank');
    setSetupPresetId(SIZE_PRESETS.find((p) => p.width === 1920 && p.height === 1080)?.id ?? 'custom');
    setLockAspect(true);
    setSetupFps(30);
    setSetupDuration(10);
    setSetupBg('#101014');
    setSetupTransparent(false);
    setSetupFootage(null);
    setSetupModalOpen(true);
  };

  /** The second way in: pick a video, and the dialog opens already matched to it. */
  const onCreateFromVideo = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = VIDEO_ACCEPT;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      onCreate();
      chooseSetupFootage(f);
    };
    input.click();
  };

  const onLaunchWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      clearRecovery();
      const compName = setupTitle.trim() || 'Untitled project';
      // Clamp to valid ranges so a half-typed value (onChange fires before the
      // onBlur clamp) can never produce an out-of-range comp the backend rejects.
      const width = clampDimension(setupWidth);
      const height = clampDimension(setupHeight);
      const fps = clampFps(setupFps);
      const durationSeconds = clampDuration(setupDuration);
      // Same ROOT_COMP_ID contract as the quick-create path above: the comp id
      // and the scene root id must agree, or the project opens on a phantom.
      const initialComp: CompositionSettings = {
        id: 'comp_root',
        name: compName,
        width,
        height,
        fps,
        durationSeconds,
        background: setupBg,
        transparent: setupTransparent,
        startFrame: 0,
      };
      const scene = emptySceneProject();
      if (scene.nodes[0]) scene.nodes[0].name = compName;
      const initialDoc: EditorDocument = {
        version: '1.1.0',
        scene,
        animation: { tracks: {}, expressions: {} },
        comps: { comp_root: initialComp },
      };
      const p = await create(compName, initialDoc);
      if (!p?.id) throw new Error('The server did not return a project id.');
      // Nothing primed here: the stores still belong to whatever project is
      // loaded behind the dashboard. Opening `initialDoc` states its comps, and
      // its timeline is seeded from them (restoreDocument: no `timelines`).
      // Starting from a video: the File rides the handoff; the editor's
      // ProjectLoader imports it and lands it at full frame the moment the
      // project opens. The comp fields above were prefilled from its probe.
      if (setupFootage) setPendingFootage(setupFootage);
      setSetupModalOpen(false);
      navigate(`/editor/${p.id}`);
    } catch (err) {
      // The silent `catch {}` here made the button look dead: any failure
      // (backend down, expired session, validation) vanished with no feedback.
      // Surface it and keep the modal open so the user can fix it and retry.
      console.error('Create & Launch Editor failed:', err);
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Could not create the composition. Check your connection and try again.';
      // Past the Free plan's cloud allowance the server's sentence carries the
      // way out (upgrade, or a local project) — give it time to be read.
      const limited = projectLimitDetail(403, (err as { body?: unknown }).body) !== null;
      useUIStore.getState().notify({ level: 'error', message, durationMs: limited ? 10000 : 5000 });
      setCreating(false);
    }
  };

  const onDelete = async (id: string, name: string) => {
    // It CAN be undone now — saying otherwise would be the opposite lie to the
    // one this codebase usually tells, and would scare people out of tidying up.
    if (!await customConfirm('Move to Trash', `Move “${name}” to the trash? You can restore it for 30 days.`, { confirmLabel: 'Move to Trash' })) return;
    await remove(id).catch(() => undefined);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void refreshOverview();
  };

  /** Selects this page. There is no honest "select all 143" without loading them. */
  const toggleSelectAll = () => {
    if (selectedIds.size === projects.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(projects.map((p) => p.id)));
    }
  };

  /**
   * Move to another page of projects.
   *
   * Clears the selection on the way: selected ids survive a page change but
   * their rows don't, so "Move to trash (3)" would delete projects that are no
   * longer on screen.
   */
  const goToProjectPage = (page: { limit: number; offset: number }): void => {
    setSelectedIds(new Set());
    void load(page);
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /**
   * Filtering happens on the server — see `orientation` in projectLibraryStore.
   *
   * It used to be a `projects.filter(...)` right here, which was correct only
   * while the whole library was in memory. Against a page it silently means
   * "portrait projects among the 24 loaded", and the count beside it would have
   * been counting a different set than the server was.
   *
   * (The axis itself is real: orientation comes from the comp's own width and
   * height. The Category and Status dropdowns this replaced filtered on values
   * invented from `revision % 3`.)
   */
  // Assets Import Simulation
  /** Upload real files the user picks. Replaces a handler that invented an
   *  asset from a random name and never touched the network. */
  const handleImportAssetFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setAssetsBusy(true);
    setDataError('');
    try {
      const items = [...files].map((f) => ({ file: f, folderId: currentFolderId }));
      // Browser `File`s (no path): imported from their bytes, one entry.
      await importBrowserFilesEdit(items);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setAssetsBusy(false);
    }
  };

  const handleImportFolder = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setAssetsBusy(true);
    setDataError('');
    try {
      // The folder tree first — ONE engine entry, parents before children —
      // then each file into the folder its relative path names.
      const picked: Array<{ file: File; dir: string }> = [];
      const dirs: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file) continue;
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const segments = rel.split('/').slice(0, -1);
        for (let n = 1; n <= segments.length; n++) {
          const key = segments.slice(0, n).join('/');
          if (!dirs.includes(key)) dirs.push(key);
        }
        picked.push({ file, dir: segments.join('/') });
      }
      const pathToId = await createFolderTreeEdit(dirs, currentFolderId);
      if (dirs.length > 0 && pathToId.size === 0) throw new Error('Could not create the folders.');
      const items = picked.map(({ file, dir }) => ({ file, folderId: dir ? pathToId.get(dir) ?? currentFolderId : currentFolderId }));
      if (items.length > 0) {
        await importBrowserFilesEdit(items);
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Folder import failed.');
    } finally {
      setAssetsBusy(false);
    }
  };

  const handleNewFolder = async (): Promise<void> => {
    const siblings = folders.filter((f) => f.parentId === currentFolderId);
    const base = 'New Folder';
    let name = base;
    let n = 2;
    while (siblings.some((f) => f.name === name)) name = `${base} ${n++}`;
    const created = await createFolderEdit(name, currentFolderId);
    if (created) setRenamingFolderId(created);
  };

  const handleDeleteFolder = async (folder: AssetFolder): Promise<void> => {
    const assetCount = storeAssets.filter((a) => a.folderId === folder.id).length;
    const subCount = folders.filter((f) => f.parentId === folder.id).length;
    const ok = await customConfirm(
      `Delete “${folder.name}”`,
      assetCount || subCount
        ? `This deletes the folder and everything inside it (${assetCount} asset${assetCount === 1 ? '' : 's'}${subCount ? `, ${subCount} subfolder${subCount === 1 ? '' : 's'}` : ''}). This can’t be undone.`
        : 'Delete this empty folder?',
      { confirmLabel: 'Delete', isDanger: true }
    );
    if (!ok) return;
    // The folder tree and everything in it.
    const doomed = new Set([folder.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of folders) if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) { doomed.add(f.id); grew = true; }
    }
    const assets = storeAssets.filter((a) => a.folderId != null && doomed.has(a.folderId));
    await deletePermanentlyEdit([...doomed, ...assets.map((a) => a.id)], assets);
  };

  const handleDeleteAsset = async (id: string, name: string): Promise<void> => {
    if (!await customConfirm('Delete Asset', `Delete “${name}”? This cannot be undone.`, { isDanger: true, confirmLabel: 'Delete' })) return;
    try {
      await deletePermanentlyEdit([id], storeAssets.filter((a) => a.id === id));
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not delete that asset.');
    }
  };

  const handleRestore = async (id: string): Promise<void> => {
    try {
      await api.restoreProject(id);
      // Drop the row, refill the page from the server, and let the project list
      // and the Home counts see the project that just came back.
      trash.removeLocal([id]);
      void refreshProjects();
      void refreshOverview();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not restore that project.');
    }
  };

  const handleDestroy = async (id: string, name: string): Promise<void> => {
    if (!await customConfirm(
      'Permanently Delete Project',
      `Permanently delete “${name}”? This cannot be undone — the project and all of its version history will be gone for good.`,
      { isDanger: true, confirmLabel: 'Permanently Delete' }
    )) return;
    try {
      await api.destroyProject(id);
      trash.removeLocal([id]);
      void refreshOverview();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not delete that project.');
    }
  };

  const handleCancelRender = async (id: string): Promise<void> => {
    try {
      await api.cancelRender(id);
      // Refetch rather than patch the row in place: cancelling changes what the
      // Home tab's "active" count is, and the page may be stale in other ways.
      renders.reload();
      void refreshOverview();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not cancel that render.');
    }
  };

  const currentBreadcrumb: AssetFolder[] = [];
  {
    let cursor = currentFolderId;
    const byId = new Map(folders.map((f) => [f.id, f] as const));
    while (cursor) {
      const f = byId.get(cursor);
      if (!f) break;
      currentBreadcrumb.unshift(f);
      cursor = f.parentId;
    }
  }

  const subfoldersInView = useMemo(
    () => folders.filter((f) => f.parentId === currentFolderId),
    [folders, currentFolderId],
  );
  const visibleAssetsInView = useMemo(
    () =>
      storeAssets.filter((a) => {
        const matchesType = assetTypeFilter === 'all' || a.type === assetTypeFilter;
        const inFolder = (a.folderId ?? null) === currentFolderId;
        return matchesType && inFolder;
      }),
    [storeAssets, assetTypeFilter, currentFolderId],
  );
  /**
   * Items directly inside each folder (assets + subfolders), in one pass.
   * Each folder card used to scan the whole library for its own count, on
   * every render of the page — folders × assets work per keystroke anywhere.
   */
  const folderItemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of storeAssets) if (a.folderId) counts.set(a.folderId, (counts.get(a.folderId) ?? 0) + 1);
    for (const f of folders) if (f.parentId) counts.set(f.parentId, (counts.get(f.parentId) ?? 0) + 1);
    return counts;
  }, [storeAssets, folders]);

  /**
   * One page of the folder's contents, folders first.
   *
   * Paged in the browser, unlike every other list here, because the asset store
   * is shared with the editor's Assets panel and holds the whole library
   * already — the cost this avoids is a thousand cards in the DOM, not a
   * thousand rows over the wire. (`assetStore.loadFromCloud` pages the fetch.)
   */
  const assetEntryTotal = subfoldersInView.length + visibleAssetsInView.length;
  const pagedFolders = subfoldersInView.slice(
    assetPage.offset,
    assetPage.offset + assetPage.limit,
  );
  const assetStart = Math.max(0, assetPage.offset - subfoldersInView.length);
  const pagedAssets = visibleAssetsInView.slice(
    assetStart,
    assetStart + (assetPage.limit - pagedFolders.length),
  );

  // Render Page Content based on selected sidebar Tab
  const renderTabContent = () => {
    switch (activeTab) {
      case 'home':
        return (
          <>
            {/*
              One closable row for the release. This is the only place the
              dashboard announces anything.
            */}
            {newsOpen && (
              <div className={styles.newsBanner}>
                <div className={styles.newsArt} aria-hidden>{RELEASE_LABEL}</div>
                <div className={styles.newsBody}>
                  <h2 className={styles.newsTitle}>New in {RELEASE_LABEL}: the native engine</h2>
                  <p className={styles.newsText}>
                    Playback, rendering and export now run in a new GPU engine. Your existing projects open as before.
                  </p>
                </div>
                <button type="button" className={styles.btnSecondary} onClick={openWhatsNew}>
                  See what’s new
                </button>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={dismissNews}
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            )}

            {/*
              What is happening, not how many things exist: renders in flight
              and renders that failed are states you act on. When there are
              none of either, the strip is not there at all.
            */}
            {(overview.failedRenders > 0 || overview.activeRenders > 0) && !overviewFailed && (
              <div className={styles.overviewStrip}>
                {overview.failedRenders > 0 && (
                  <button
                    type="button"
                    className={`${styles.overviewSignal} ${styles.overviewSignalDanger}`}
                    onClick={() => openTab('renders')}
                  >
                    {overview.failedRenders === 1
                      ? '1 render failed'
                      : `${overview.failedRenders.toLocaleString()} renders failed`}
                  </button>
                )}
                {overview.activeRenders > 0 && (
                  <button
                    type="button"
                    className={styles.overviewSignal}
                    onClick={() => openTab('renders')}
                  >
                    {overview.activeRenders === 1
                      ? '1 render in progress'
                      : `${overview.activeRenders.toLocaleString()} renders in progress`}
                  </button>
                )}
              </div>
            )}

            <div className={styles.sectionHeaderRow}>
              <h2 className={styles.sectionTitle}>Recent</h2>
              <button type="button" className={styles.sectionLink} onClick={() => openTab('projects')}>
                {overviewFailed || overview.projects <= 6
                  ? 'All projects'
                  : `All ${overview.projects.toLocaleString()} projects`}
              </button>
            </div>
            {/*
              A shortlist. Home used to render the SAME table as the Projects
              tab, in full, under its own search box — so the two pages differed
              by a banner and three boxes, and "View all" led to what you were
              already looking at.
            */}
            {renderProjectsTable({ max: 6 })}
          </>
        );

      case 'projects':
        return renderProjectsTable();

      case 'assets':
        return (
          <div className={styles.assetsContainer}>
            <div className={styles.assetsHeader}>
              <div className={styles.segmentedGroup}>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'all' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'video' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('video')}
                >
                  Videos
                </button>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'image' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('image')}
                >
                  Images
                </button>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'audio' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('audio')}
                >
                  Audio
                </button>
              </div>

              <div className={styles.assetToolbar}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => { void handleNewFolder(); }}
                  title="Create new folder"
                >
                  <Icon name="folder-plus" size="md" style={{ color: FOLDER_COLOR }} />
                  <span>New folder</span>
                </button>

                <label className={`${styles.btnSecondary} ${assetsBusy ? styles.fileLabelBusy : styles.fileLabel}`}>
                  <Icon name="folder-open" size="md" style={{ color: FOLDER_COLOR }} />
                  <span>Import folder</span>
                  <input
                    type="file"
                    multiple
                    className={styles.hiddenFileInput}
                    disabled={assetsBusy}
                    onChange={(e) => {
                      void handleImportFolder(e.currentTarget.files);
                      e.currentTarget.value = '';
                    }}
                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  />
                </label>

                <label className={`${styles.btnPrimary} ${assetsBusy ? styles.fileLabelBusy : styles.fileLabel}`}>
                  <Icon name="upload" size="md" />
                  <span>{assetsBusy ? 'Uploading…' : 'Import asset'}</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*,audio/*"
                    className={styles.hiddenFileInput}
                    disabled={assetsBusy}
                    onChange={(e) => {
                      void handleImportAssetFiles(e.currentTarget.files);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
            </div>

            <nav className={styles.breadcrumb} aria-label="Asset folder">
              <button
                type="button"
                className={`${styles.breadcrumbBtn} ${currentFolderId === null ? styles.breadcrumbBtnActive : ''}`}
                onClick={() => setCurrentFolderId(null)}
              >
                All assets
              </button>
              {currentBreadcrumb.map((f, i) => (
                <span key={f.id} className={styles.breadcrumbSeg}>
                  <span className={styles.breadcrumbSep} aria-hidden>/</span>
                  <button
                    type="button"
                    className={`${styles.breadcrumbBtn} ${i === currentBreadcrumb.length - 1 ? styles.breadcrumbBtnActive : ''}`}
                    onClick={() => setCurrentFolderId(f.id)}
                  >
                    {f.name}
                  </button>
                </span>
              ))}
            </nav>

            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}

            {/*
              An empty state earns its space by offering the one thing that is
              missing. The old copy listed all three toolbar buttons back at the
              user — a caption for a toolbar they can already see — so it now
              gets a heading, a reason, and the primary action itself.
            */}
            {subfoldersInView.length === 0 && visibleAssetsInView.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="folder" size={48} className={styles.emptyStateIcon} />
                <h3>{currentFolderId === null ? 'No assets yet' : 'This folder is empty'}</h3>
                <p>
                  {currentFolderId === null
                    ? 'Footage, stills and audio you import here are available to every project in your library.'
                    : 'Import media into this folder, or drop a subfolder inside it to keep things sorted.'}
                </p>
                <label className={`${styles.btnPrimary} ${assetsBusy ? styles.fileLabelBusy : styles.fileLabel}`}>
                  <Icon name="upload" size="md" />
                  <span>{assetsBusy ? 'Uploading…' : 'Import asset'}</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*,audio/*"
                    className={styles.hiddenFileInput}
                    disabled={assetsBusy}
                    onChange={(e) => {
                      void handleImportAssetFiles(e.currentTarget.files);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
            ) : (
              <>
              <div className={styles.assetsGrid}>
                {/* Render folders first */}
                {pagedFolders.map((folder) => {
                  const count = folderItemCounts.get(folder.id) ?? 0;
                  return (
                    <div
                      key={folder.id}
                      className={styles.assetCard}
                      style={{ cursor: 'pointer' }}
                      onClick={() => { if (renamingFolderId !== folder.id) setCurrentFolderId(folder.id); }}
                    >
                      <div className={styles.assetPreview} style={{ color: FOLDER_COLOR }}>
                        <Icon name="folder" size="lg" />
                      </div>
                      <div className={styles.assetMeta}>
                        {renamingFolderId === folder.id ? (
                          <input
                            autoFocus
                            defaultValue={folder.name}
                            className={styles.assetName}
                            style={{ background: 'var(--color-surface-0)', border: '1px solid var(--color-primary)', borderRadius: 3, color: 'var(--color-text-primary)', width: '100%' }}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => { void renameItemEdit(folder.id, e.target.value); setRenamingFolderId(null); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { void renameItemEdit(folder.id, (e.target as HTMLInputElement).value); setRenamingFolderId(null); }
                              if (e.key === 'Escape') setRenamingFolderId(null);
                            }}
                          />
                        ) : (
                          <div
                            className={styles.assetName}
                            title={folder.name}
                            onDoubleClick={(e) => { e.stopPropagation(); setRenamingFolderId(folder.id); }}
                          >
                            {folder.name}
                          </div>
                        )}
                        <div className={styles.assetDetails}>{count} item{count === 1 ? '' : 's'}</div>
                      </div>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        title="Delete folder"
                        onClick={(e) => { e.stopPropagation(); void handleDeleteFolder(folder); }}
                      >
                        <Icon name="trash" size="sm" />
                      </button>
                    </div>
                  );
                })}

                {/* Render assets */}
                {pagedAssets.map((asset) => {
                  const visual = getAssetVisualInfo(asset);
                  // The small preview, as the editor's Assets panel uses: the
                  // full-res original made every tile download and decode the
                  // whole file. Video gets its server poster when there is one.
                  const preview = asset.thumbSrc ?? (asset.type === 'image' ? asset.src : undefined);
                  return (
                    <div key={asset.id} className={styles.assetCard}>
                      <div className={styles.assetPreview}>
                        {preview ? (
                          <img
                            src={preview}
                            alt=""
                            className={styles.assetPreviewImg}
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                          />
                        ) : (
                          <Icon
                            name={visual.icon}
                            size="lg"
                            className={styles.assetPreviewIcon}
                            style={{ color: visual.color }}
                          />
                        )}
                      </div>
                      <div className={styles.assetMeta}>
                        <div className={styles.assetName} title={asset.name}>{asset.name}</div>
                        <div className={styles.assetDetails}>
                          {formatBytes(asset.size)}
                          {asset.metadata?.width ? ` · ${asset.metadata.width}×${asset.metadata.height}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        title="Delete asset"
                        onClick={() => void handleDeleteAsset(asset.id, asset.name)}
                      >
                        <Icon name="trash" size="sm" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <Pagination
                total={assetEntryTotal}
                limit={assetPage.limit}
                offset={assetPage.offset}
                onChange={setAssetPage}
                itemLabel="item"
              />
              </>
            )}
          </div>
        );

      case 'renders':
        return (
          <div className={styles.tableCard}>
            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}
            {renders.status === 'error' ? <p className={styles.emptyHint}>{renders.error}</p> : null}
            {renders.status === 'loading' ? (
              <div className={styles.loadingState}>
                <p>Loading render queue…</p>
              </div>
            ) : renders.items.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="queue" size={48} className={styles.emptyStateIcon} />
                <h3>No renders in queue</h3>
                <p>Export a project from the composition editor to send render jobs to the queue.</p>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => openTab('projects')}
                >
                  <Icon name="folder" size="md" />
                  <span>Go to projects</span>
                </button>
              </div>
            ) : (
              <>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Job Name</th>
                    <th>Format</th>
                    <th>Progress</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th style={{ width: '60px', textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {renders.items.map((job) => {
                    // Only names a project that happens to be on the loaded
                    // page — the job list is not scoped to it, so anything else
                    // is genuinely unknown from here.
                    const project = projects.find((p) => p.id === job.projectId);
                    return (
                      <tr key={job.id}>
                        <td>
                          <div className={styles.jobCell}>
                            <Icon name="video" size="md" style={{ color: 'var(--color-primary)' }} />
                            <span style={{ fontWeight: 600 }}>{project?.name ?? 'Untitled render'}</span>
                          </div>
                        </td>
                        <td className={styles.monoCell}>{job.format.toUpperCase()}</td>
                        <td>
                          {/*
                            A progress bar only while there is progress to
                            report. A finished job drew a full bar reading
                            "100%" in every row, which is three columns of
                            furniture saying what the status pill beside it
                            already says.
                          */}
                          {job.status === 'running' || job.status === 'queued' ? (
                            <div className={styles.progressCellWrapper}>
                              <div className={styles.progressBar}>
                                <div className={styles.progressFill} style={{ '--fill': Math.min(1, job.progress) } as React.CSSProperties} />
                              </div>
                              <span className={styles.progressText}>{Math.round(job.progress * 100)}%</span>
                            </div>
                          ) : (
                            <span className={styles.progressIdle}>—</span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`${styles.badge} ${
                              job.status === 'completed'
                                ? styles.badgeSuccess
                                : job.status === 'running'
                                  ? styles.badgeProgress
                                  : job.status === 'failed'
                                    ? styles.badgeDanger
                                    : styles.badgeDefault
                            }`}
                          >
                            {job.status === 'running' && <span className={styles.pulseDot} />}
                            {RENDER_STATUS_LABEL[job.status]}
                          </span>
                          {/*
                            Why it failed, in the row.
                            
                            This was a `title` on the pill — the one piece of
                            information a failed render exists to give you,
                            behind a hover most people never try, unreachable
                            on a touch screen and unreadable by a screen
                            reader that does not announce title text.
                          */}
                          {job.status === 'failed' && job.error && (
                            <span className={styles.jobError} title={job.error}>
                              {job.error}
                            </span>
                          )}
                        </td>
                        <td className={styles.monoCell}>{timeAgo(job.createdAt)}</td>
                        <td style={{ textAlign: 'center' }}>
                          {job.resultUrl ? (
                            <a
                              href={job.resultUrl}
                              download
                              className={styles.actionBtn}
                              title="Download result"
                            >
                              <Icon name="download" size="md" />
                            </a>
                          ) : job.status === 'queued' || job.status === 'running' ? (
                            <button
                              type="button"
                              className={styles.actionBtn}
                              title="Cancel render"
                              onClick={() => void handleCancelRender(job.id)}
                            >
                              <Icon name="close" size="md" />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pagination
                total={renders.total}
                limit={renders.limit}
                offset={renders.offset}
                busy={renders.busy}
                onChange={renders.setPage}
                itemLabel="render"
              />
              </>
            )}
          </div>
        );

      case 'trash':
        return (
          <div className={styles.tableCard}>
            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}
            {trash.status === 'error' ? <p className={styles.emptyHint}>{trash.error}</p> : null}
            {trash.status === 'loading' ? (
              <div className={styles.loadingState}>
                <p>Loading trash…</p>
              </div>
            ) : trash.items.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="trash" size={48} className={styles.emptyStateIcon} />
                <h3>Nothing in the trash</h3>
                <p>Deleted projects rest here for 30 days, and can be restored at any point before that.</p>
              </div>
            ) : (
              <>
                {selectedTrashIds.size > 0 && (
                  <div className={styles.selectionBar}>
                    <span className={styles.selectionCount}>
                      {selectedTrashIds.size} {selectedTrashIds.size === 1 ? 'project' : 'projects'} selected
                    </span>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={async () => {
                        for (const id of selectedTrashIds) {
                          await handleRestore(id).catch(() => undefined);
                        }
                        setSelectedTrashIds(new Set());
                      }}
                    >
                      <Icon name="undo" size="sm" />
                      <span>Restore selected ({selectedTrashIds.size})</span>
                    </button>
                    <button
                      type="button"
                      className={styles.btnDanger}
                      onClick={async () => {
                        if (!await customConfirm(
                          'Permanently Delete Projects',
                          `Permanently delete ${selectedTrashIds.size} selected projects? This cannot be undone.`,
                          { isDanger: true, confirmLabel: 'Permanently Delete' }
                        )) return;
                        const gone = new Set<string>();
                        for (const id of selectedTrashIds) {
                          try {
                            await api.destroyProject(id);
                            gone.add(id);
                          } catch { /* ignore individual fail */ }
                        }
                        trash.removeLocal(gone);
                        setSelectedTrashIds(new Set());
                        void refreshOverview();
                      }}
                    >
                      <Icon name="trash" size="sm" />
                      <span>Delete permanently ({selectedTrashIds.size})</span>
                    </button>
                  </div>
                )}
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}>
                        <Checkbox
                          checked={selectedTrashIds.size === trash.items.length && trash.items.length > 0}
                          indeterminate={selectedTrashIds.size > 0 && selectedTrashIds.size < trash.items.length}
                          onChange={() => {
                            if (selectedTrashIds.size === trash.items.length) {
                              setSelectedTrashIds(new Set());
                            } else {
                              setSelectedTrashIds(new Set(trash.items.map((p) => p.id)));
                            }
                          }}
                        />
                      </th>
                      <th>Project</th>
                      <th>Deleted</th>
                      <th>Purges in</th>
                      <th style={{ width: '150px', textAlign: 'center' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trash.items.map((p) => {
                      const isSelected = selectedTrashIds.has(p.id);
                      return (
                        <tr key={p.id} className={isSelected ? styles.rowSelected : ''}>
                          <td style={{ textAlign: 'center' }}>
                            <Checkbox
                              checked={isSelected}
                              onChange={() => {
                                setSelectedTrashIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(p.id)) next.delete(p.id);
                                  else next.add(p.id);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <td>
                            <div className={styles.projectCell}>
                              <div
                                className={styles.projectThumb}
                                style={{ '--thumb-hue': thumbHue(p.id) } as React.CSSProperties}
                              >
                                {p.thumbnailUrl
                                  ? <img src={p.thumbnailUrl} alt="" className={styles.thumbImg} />
                                  : <Icon name="video" size="sm" className={styles.thumbIcon} />}
                              </div>
                              <div>
                                <div className={styles.projectName}>{p.name}</div>
                                <div className={styles.projectTime}>
                                  {describeSize(p.width, p.height)} · {describeDuration(p.durationSeconds)}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className={styles.monoCell}>{timeAgo(p.deletedAt)}</td>
                          <td className={styles.monoCell}>
                            <span className={p.purgesInDays <= 3 ? styles.purgeSoon : undefined}>
                              {p.purgesInDays} {p.purgesInDays === 1 ? 'day' : 'days'}
                            </span>
                          </td>
                          <td>
                            <div className={styles.trashActions}>
                              <button
                                type="button"
                                className={styles.btnSecondary}
                                onClick={() => void handleRestore(p.id)}
                              >
                                <Icon name="undo" size="sm" />
                                <span>Restore</span>
                              </button>
                              <button
                                type="button"
                                className={styles.actionBtn}
                                title="Delete permanently"
                                onClick={() => void handleDestroy(p.id, p.name)}
                              >
                                <Icon name="trash" size="md" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <Pagination
                  total={trash.total}
                  limit={trash.limit}
                  offset={trash.offset}
                  busy={trash.busy}
                  onChange={(page) => {
                    // Same reason as the projects table: the ids outlive the
                    // rows, and "Delete permanently (3)" must not reach rows
                    // the user can no longer see.
                    setSelectedTrashIds(new Set());
                    trash.setPage(page);
                  }}
                  itemLabel="project"
                />
              </>
            )}
          </div>
        );

      case 'billing':
        return (
          <div className={styles.billingPanel} id="billing-settings">
            <BillingSection />
          </div>
        );

      case 'plugins':
        return <NativePluginsPage />;

      case 'customize':
        return (
          <div className={styles.customizePanel}>
            <DashboardCustomizeTab />
          </div>
        );

      case 'settings':
        return (
          <div className={styles.settingsPanel}>
            {/*
              Account: the profile header, then name / email / password /
              devices / deletion — every write there re-reads /auth/me.
            */}
            <div className={styles.settingsCard} id="account-settings">
              <div className={styles.profileHeaderRow}>
                <div className={styles.profileAvatarLarge}>
                  <Icon name="user" size="lg" />
                </div>
                <div className={styles.profileMetaInfo}>
                  <div className={styles.profileDisplayName}>
                    {user?.name || user?.email?.split('@')[0] || 'Account'}
                  </div>
                  <div className={styles.profileEmailText}>{user?.email}</div>
                  {account && (
                    <div className={styles.profileNodeBadge}>
                      {`${account.plan === 'pro' ? 'Premation Cloud' : 'Free plan'} · member since ${new Date(account.createdAt).toLocaleDateString()}`}
                    </div>
                  )}
                </div>
              </div>

              {/* Stated once the account has answered — never as "0 B across 0 assets". */}
              {account && (
                <div className={styles.storageBarSection}>
                  <div className={styles.storageBarHeader}>
                    <span>Storage</span>
                    <span className={styles.monoValue}>
                      {formatBytes(account.storageBytes)} across {account.assetCount} {account.assetCount === 1 ? 'asset' : 'assets'}
                    </span>
                  </div>
                </div>
              )}

              {account && (
                <AccountSection
                  account={account}
                  onAccountChanged={refreshOverview}
                  onOpenBilling={() => openTab('billing')}
                />
              )}
            </div>

            {/* The plan and its cloud allowance; checkout itself stays on Billing. */}
            {account && billingEnabled() && (
              <div className={styles.settingsCard} id="plan-settings">
                <PlanCard account={account} onOpenBilling={() => openTab('billing')} />
              </div>
            )}

            {/* Assistant — how the AI is powered */}
            <div className={styles.settingsCard} id="ai-settings">
              <h3 className={styles.settingsLabel}>Assistant</h3>
              <AiSettingsSection />
            </div>

            {/*
              Editor preferences live on their own first-class Customize page.
            */}
            <div className={styles.settingsCard}>
              <h3 className={styles.settingsLabel}>Editor preferences</h3>
              <p className={styles.optionDesc} style={{ marginBottom: 'var(--space-3)' }}>
                Appearance, interface scale, panel layout, editing behaviour and keyboard
                shortcuts are on the Preferences page.
              </p>
              <div className={styles.settingsRow}>
                <Button variant="secondary" onClick={() => openTab('customize')}>
                  Open Preferences
                </Button>
              </div>
            </div>

          </div>
        );
    }
  };

  /**
   * The projects table.
   *
   * `max` truncates it for Home's shortlist. The rows, the empty state and
   * the error state are the same ones the Projects tab uses — two tables that
   * drift apart is exactly what this page had before, and the shortlist is a
   * view of the list, not a second implementation of it.
   */
  const renderProjectsTable = ({ max }: { max?: number } = {}) => {
    // `max`, not `limit`: the library store already has a `limit` in scope and
    // shadowing it here made the pager read the shortlist's size as the page size.
    const rows = max === undefined ? projects : projects.slice(0, max);
    /** Empty because of a search or a format filter, rather than empty full stop. */
    const isFiltered = searchQuery.trim().length > 0 || orientation !== 'all';
    /** Bulk selection belongs to the full list; Home's shortlist is for opening. */
    const selectable = max === undefined;
    const asGrid = max === undefined && projectView === 'grid';
    return (
      <div className={styles.tableCard}>
        {/*
          Skeleton rows, not the words "Loading projects…".
          
          The table arrives at the height it will keep, so the page does not
          jump when the rows land, and the shape tells you what is coming. A
          sentence in the middle of an empty card tells you only that something
          is missing.
        */}
        {status === 'loading' && (
          <div className={styles.skeletonTable} aria-busy="true" aria-label="Loading projects">
            {Array.from({ length: max ?? 6 }, (_, i) => (
              <div key={i} className={styles.skeletonRow}>
                <span className={styles.skeletonThumb} />
                <span className={styles.skeletonLines}>
                  <span className={styles.skeletonLine} style={{ width: `${38 + ((i * 13) % 28)}%` }} />
                  <span className={`${styles.skeletonLine} ${styles.skeletonLineSub}`} style={{ width: `${22 + ((i * 7) % 16)}%` }} />
                </span>
              </div>
            ))}
          </div>
        )}

        {status === 'error' && (
          <div className={styles.errorState}>
            <Icon name="warning" size="lg" />
            <p>{error}</p>
            <button type="button" className={styles.btnSecondary} onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}

        {/*
          Two different empty states, because they are two different problems.

          "You have no projects" wants a Create button. "Nothing matched
          `aurroa`" wants the search cleared — offering to create a project
          there answers a question the user did not ask, and the old single
          state did exactly that while hedging with "or adjusting your
          filters".
        */}
        {status === 'ready' && projects.length === 0 && (
          <div className={styles.emptyState}>
            {isFiltered ? (
              <>
                <Icon name="search" size={48} className={styles.emptyStateIcon} />
                <h3>No projects match</h3>
                <p>
                  {searchQuery.trim()
                    ? `Nothing in your library is called “${searchQuery.trim()}”.`
                    : orientation === 'all'
                      ? 'Nothing matched the current filters.'
                      : `No ${ORIENTATION_LABEL[orientation].toLowerCase()} projects yet.`}
                </p>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedIds(new Set());
                    void load({ orientation: 'all' });
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <Icon name="folder" size={48} className={styles.emptyStateIcon} />
                <h3>No projects yet</h3>
                <p>A project is one composition — its comps, layers and renders live inside it.</p>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={onCreate}
                  disabled={creating}
                >
                  <Icon name="plus" size="md" />
                  <span>{creating ? 'Creating…' : 'Create your first project'}</span>
                </button>
              </>
            )}
          </div>
        )}

        {status === 'ready' && projects.length > 0 && (asGrid ? (
          <div className={styles.projectGrid}>
            {rows.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.projectTile}
                onClick={() => navigate(`/editor/${p.id}`)}
              >
                <span
                  className={styles.projectTilePoster}
                  style={{ '--thumb-hue': thumbHue(p.id) } as React.CSSProperties}
                >
                  {p.thumbnailUrl
                    ? <img src={p.thumbnailUrl} alt="" />
                    : <Icon name="video" size="lg" />}
                </span>
                <span className={styles.projectTileMeta}>
                  <span className={styles.projectTileName}>{p.name}</span>
                  <span className={styles.projectTileFacts}>
                    {p.width} × {p.height} · {lastEditedLabel(p.updatedAt)}
                    {p.readOnly ? <ReadOnlyTag /> : null}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <table className={`${styles.table} ${styles.tableFixed}`}>
            <thead>
              <tr>
                {selectable && (
                  <th style={{ width: '36px' }}>
                    <Checkbox
                      checked={selectedIds.size === projects.length && projects.length > 0}
                      indeterminate={selectedIds.size > 0 && selectedIds.size < projects.length}
                      onChange={toggleSelectAll}
                      title="Select every project on this page"
                    />
                  </th>
                )}
                <th className={styles.colName}>Name</th>
                <th>Last edited</th>
                <th className={styles.colOptional}>Frame size</th>
                <th>Duration</th>
                <th style={{ width: '44px' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const isSelected = selectable && selectedIds.has(p.id);
                const open = (): void => navigate(`/editor/${p.id}`);
                const menu: DropdownItem[] = [
                  { type: 'item', id: 'open', label: 'Open', onSelect: open },
                  { type: 'separator' },
                  { type: 'item', id: 'trash', label: 'Move to Trash', danger: true, onSelect: () => { void onDelete(p.id, p.name); } },
                ];
                return (
                  /*
                    The whole row opens the project, the way a file list does;
                    the name is the same action as a real button, so it is
                    reachable by keyboard. The checkbox and the menu keep their
                    own clicks.
                  */
                  <tr
                    key={p.id}
                    className={`${styles.rowClickable} ${isSelected ? styles.rowSelected : ''}`}
                    onClick={open}
                  >
                    {selectable && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={isSelected} onChange={() => toggleSelectOne(p.id)} />
                      </td>
                    )}
                    <td>
                      <div className={styles.projectCell}>
                        <span
                          className={styles.projectThumb}
                          style={{ '--thumb-hue': thumbHue(p.id) } as React.CSSProperties}
                          aria-hidden
                        >
                          {p.thumbnailUrl ? (
                            <img src={p.thumbnailUrl} alt="" className={styles.thumbImg} />
                          ) : (
                            <Icon name="video" size="sm" className={styles.thumbIcon} />
                          )}
                        </span>
                        <button
                          type="button"
                          className={styles.projectName}
                          title={p.name}
                          onClick={(e) => { e.stopPropagation(); open(); }}
                        >
                          {p.name}
                        </button>
                        {p.readOnly ? <ReadOnlyTag /> : null}
                      </div>
                    </td>
                    <td className={styles.monoCell}>{lastEditedLabel(p.updatedAt)}</td>
                    <td className={`${styles.monoCell} ${styles.colOptional}`}>
                      {p.width} × {p.height}, {p.fps} fps
                    </td>
                    <td className={styles.monoCell}>{timecodeOf(p.durationSeconds, p.fps)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Dropdown
                        placement="bottom-end"
                        items={menu}
                        trigger={
                          <button
                            type="button"
                            className={styles.moreBtn}
                            title="More"
                            aria-label={`Actions for ${p.name}`}
                          >
                            <Icon name="more-horizontal" size="md" />
                          </button>
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}

        {/*
          No pager on the shortlist: Home shows the newest five and links to the
          full list, so a "1–5 of 43" footer with page arrows would offer to
          page through a list this table is not showing.
        */}
        {status === 'ready' && max === undefined && (
          <Pagination
            total={total}
            limit={limit}
            offset={offset}
            busy={busy}
            onChange={goToProjectPage}
            itemLabel="project"
          />
        )}
      </div>
    );
  };

  // Resolve active titles and page details dynamically for tab headers
  const headerDetails = useMemo(() => {
    switch (activeTab) {
      case 'home':
        return {
          title: 'Home',
          desc: '',
        };
      case 'projects':
        return {
          title: 'Projects',
          desc: '',
        };
      case 'trash':
        return {
          title: 'Trash',
          desc: 'Restore deleted projects within 30 days, or remove them permanently.',
        };
      case 'assets':
        return {
          title: 'Assets',
          desc: 'Import and organize media you’ll use across projects.',
        };
      case 'renders':
        return {
          title: 'Render queue',
          desc: 'Track exports in progress, finished downloads, and queued jobs.',
        };
      case 'billing':
        return {
          title: 'Billing',
          desc: 'Your plan, what’s included, and how to change or cancel.',
        };
      case 'plugins':
        return {
          title: 'Plugins',
          desc: 'Native plugins installed on this machine, and how to add more.',
        };
      case 'customize':
        return {
          title: 'Preferences',
          desc: 'Workspaces, keyboard shortcuts, appearance, audio hardware, and editor behaviors.',
        };
      case 'settings':
        return {
          title: 'Settings',
          desc: 'Your account, plan, storage and the AI assistant.',
        };
    }
  }, [activeTab]);

  const displayName = user?.name || user?.email?.split('@')[0] || 'Account';
  const displayInitial = displayName.trim().charAt(0).toUpperCase() || '?';
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? '';

  const navButton = (item: NavItem): JSX.Element => (
    <button
      key={item.tab}
      type="button"
      className={`${styles.navLink} ${activeTab === item.tab ? styles.navLinkActive : ''}`}
      aria-current={activeTab === item.tab ? 'page' : undefined}
      onClick={() => openTab(item.tab)}
    >
      <Icon name={item.icon} size="md" className={styles.navIcon} />
      <span>{item.label}</span>
      {item.tab === 'renders' && overview.activeRenders > 0 && (
        <span className={styles.navCount} title="Renders in progress">{overview.activeRenders}</span>
      )}
    </button>
  );

  /*
    The account's own pages live behind the account, where a desktop app keeps
    them, instead of as three more rows in the rail. Their addresses are
    unchanged (`?tab=settings`, `?tab=billing`).
  */
  const accountMenu: DropdownItem[] = [
    {
      type: 'custom',
      id: 'who',
      render: (
        <div className={styles.accountMenuHead}>
          <span className={styles.accountName}>{displayName}</span>
          {user?.email ? <span className={styles.accountEmail}>{user.email}</span> : null}
        </div>
      ),
    },
    { type: 'separator' },
    { type: 'item', id: 'settings', label: 'Settings', onSelect: () => openTab('settings') },
    ...(billingEnabled()
      ? [{
          type: 'item' as const,
          id: 'billing',
          label: account?.plan && account.plan !== 'free' ? 'Manage plan' : salesOpen ? 'View plans' : 'Your plan',
          onSelect: () => openTab('billing'),
        }]
      : []),
    { type: 'separator' },
    { type: 'item', id: 'signout', label: 'Sign out', onSelect: () => { void logout(); } },
  ];

  /*
    One search for the dashboard. It searches projects — the query is the
    server's — so typing from any page lands on the list it filters.
  */
  const topControls = (
    <>
      <div className={styles.topSearch}>
        <Icon name="search" size="sm" className={styles.topSearchIcon} />
        <input
          type="search"
          placeholder="Search projects"
          className={styles.topSearchInput}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (activeTab !== 'projects') openTab('projects');
          }}
          aria-label="Search projects"
        />
      </div>
      <Dropdown
        placement="bottom-end"
        items={accountMenu}
        trigger={
          <button type="button" className={styles.accountButton} title="Account" aria-label="Account">
            {displayInitial}
          </button>
        }
      />
    </>
  );

  return (
    <div className={styles.root}>
      {/*
        In the desktop app these controls live in the window's title bar — one
        bar, the way a desktop app has it. The browser build has no title bar,
        so it draws its own, with the brand.
      */}
      {titleSlot ? createPortal(<div className={styles.titleSlot}>{topControls}</div>, titleSlot) : (
        !hasDesktopChrome() && (
          <header className={styles.topBar}>
            <Logo variant="lockup" size={22} />
            <div className={styles.topBarSpacer} />
            {topControls}
          </header>
        )
      )}

      <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.railCta}>
          <button type="button" className={styles.ctaPrimary} onClick={onCreate} disabled={creating}>
            New project
          </button>
          <button type="button" className={styles.ctaSecondary} onClick={onCreateFromVideo} disabled={creating}>
            New from video
          </button>
        </div>

        <nav className={styles.sidebarNav} aria-label="Dashboard">
          {NAV_LIBRARY.map((item) => navButton(item))}
          <div className={styles.navDivider} role="separator" />
          {NAV_APP.map((item) => navButton(item))}
        </nav>

        <div className={styles.railFoot}>
          {hasEngine() && (
            <span className={styles.engineLine}>
              <span className={`${styles.engineDot} ${styles.engineDotReady}`} aria-hidden />
              Engine ready
            </span>
          )}
          <span>Version {APP_VERSION}</span>
        </div>
      </aside>

      <div className={styles.container}>
        <main className={styles.mainContent}>
          {activeTab === 'home' ? (
            <h1 className={styles.welcomeTitle}>
              Welcome to Premation{firstName ? `, ${firstName}` : ''}
            </h1>
          ) : (
            <div className={styles.pageTitleRow}>
              <div className={styles.pageTitleBlock}>
                <h1 className={styles.pageTitle}>{headerDetails.title}</h1>
                {headerDetails.desc ? <p className={styles.pageSubtitle}>{headerDetails.desc}</p> : null}
              </div>
              {activeTab === 'projects' && (
                <div className={styles.pageTools}>
                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      className={styles.btnDanger}
                      onClick={async () => {
                        if (await customConfirm('Move to Trash', `Move ${selectedIds.size} projects to the trash? You can restore them for 30 days.`, { confirmLabel: 'Move to Trash' })) {
                          await removeMany(selectedIds);
                          setSelectedIds(new Set());
                          void refreshOverview();
                        }
                      }}
                    >
                      <Icon name="trash" size="md" />
                      <span>Move to Trash ({selectedIds.size})</span>
                    </button>
                  )}
                  <div className={styles.segmentedGroup} role="group" aria-label="Filter by format">
                    {(['all', 'landscape', 'portrait', 'square'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`${styles.segment} ${orientation === value ? styles.segmentActive : ''}`}
                        aria-pressed={orientation === value}
                        onClick={() => {
                          if (orientation === value) return;
                          setSelectedIds(new Set());
                          void load({ orientation: value as OrientationFilter });
                        }}
                      >
                        {value === 'all' ? 'All' : ORIENTATION_LABEL[value]}
                      </button>
                    ))}
                  </div>
                  <div className={styles.viewToggle} role="group" aria-label="View">
                    <button
                      type="button"
                      className={`${styles.viewToggleBtn} ${projectView === 'list' ? styles.viewToggleBtnActive : ''}`}
                      aria-pressed={projectView === 'list'}
                      title="List view"
                      aria-label="List view"
                      onClick={() => chooseProjectView('list')}
                    >
                      <Icon name="menu" size="md" />
                    </button>
                    <button
                      type="button"
                      className={`${styles.viewToggleBtn} ${projectView === 'grid' ? styles.viewToggleBtnActive : ''}`}
                      aria-pressed={projectView === 'grid'}
                      title="Grid view"
                      aria-label="Grid view"
                      onClick={() => {
                        setSelectedIds(new Set());
                        chooseProjectView('grid');
                      }}
                    >
                      <Icon name="grid" size="md" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Once per user: registry plugins are gone in 0.9, native ones still work. */}
          {activeTab === 'home' && <RegistryPluginsNotice onLearnMore={() => openTab('plugins')} />}

          {renderTabContent()}
        </main>
      </div>
      </div>

      {/* New project — a settings dialog (see the sheet's "New project" note). */}
      <Modal
        open={setupModalOpen}
        onClose={() => !creating && setSetupModalOpen(false)}
        title="New project"
        size="md"
        className={styles.setupDialog}
        persistent={creating}
      >
        <form className={styles.modalForm} onSubmit={onLaunchWorkspace}>
          <div className={styles.setupTabs} role="tablist" aria-label="Start from">
            <button
              type="button"
              role="tab"
              aria-selected={setupTab === 'blank'}
              className={cn(styles.setupTab, setupTab === 'blank' && styles.setupTabActive)}
              onClick={() => { setSetupTab('blank'); setSetupFootage(null); }}
            >
              Blank
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={setupTab === 'video'}
              className={cn(styles.setupTab, setupTab === 'video' && styles.setupTabActive)}
              onClick={() => { setSetupTab('video'); if (!setupFootage) pickSetupVideo(); }}
            >
              From video file
            </button>
          </div>

          <div className={styles.setupGrid}>
            {setupTab === 'video' && (
              <div className={styles.setupFile}>
                <div className={styles.setupFileText}>
                  {setupFootage ? (
                    <>
                      <span className={styles.setupFileName} title={setupFootage.name}>{setupFootage.name}</span>
                      <span className={styles.setupFileMeta}>
                        {setupWidth} × {setupHeight} · {describeDuration(setupDuration)} · placed at full frame
                      </span>
                    </>
                  ) : (
                    <span className={styles.setupFileMeta}>
                      No file chosen. The project takes its size and length from the video.
                    </span>
                  )}
                </div>
                <button type="button" className={styles.setupFileChange} onClick={pickSetupVideo}>
                  {setupFootage ? 'Choose another…' : 'Choose a video file…'}
                </button>
              </div>
            )}

            <label className={styles.setupLabel} htmlFor="setup-name">Project name</label>
            <input
              id="setup-name"
              type="text"
              className={styles.formInput}
              value={setupTitle}
              onChange={(e) => setSetupTitle(e.target.value)}
              required
            />

            <div className={styles.setupRule} />

            {setupTab === 'blank' && (
              <>
                <label className={styles.setupLabel} htmlFor="setup-preset">Preset</label>
                <select
                  id="setup-preset"
                  className={styles.formSelect}
                  value={setupPresetId}
                  onChange={(e) => {
                    const preset = SIZE_PRESETS.find((p) => p.id === e.target.value);
                    setSetupPresetId(preset ? preset.id : 'custom');
                    if (preset) setSize(preset.width, preset.height);
                  }}
                >
                  <option value="custom">Custom</option>
                  {SIZE_GROUPS.map((group) => (
                    <optgroup key={group} label={group}>
                      {SIZE_PRESETS.filter((p) => p.group === group).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} · {p.width} × {p.height}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </>
            )}

            <label className={styles.setupLabel} htmlFor="setup-width">Width</label>
            <div className={styles.setupInline}>
              <input
                id="setup-width"
                type="number"
                className={cn(styles.formInput, styles.formInputNumber)}
                value={setupWidth}
                onChange={(e) => changeWidth(Number(e.target.value))}
                onBlur={() => setSize(clampDimension(setupWidth), clampDimension(setupHeight))}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                required
              />
              <span>px</span>
              <button
                type="button"
                className={styles.swapDimensionsBtn}
                onClick={swapDimensions}
                title="Swap width and height"
                aria-label="Swap width and height"
              >
                <Icon name="refresh" size="sm" />
              </button>
            </div>

            <label className={styles.setupLabel} htmlFor="setup-height">Height</label>
            <div className={styles.setupInline}>
              <input
                id="setup-height"
                type="number"
                className={cn(styles.formInput, styles.formInputNumber)}
                value={setupHeight}
                onChange={(e) => changeHeight(Number(e.target.value))}
                onBlur={() => setSize(clampDimension(setupWidth), clampDimension(setupHeight))}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                required
              />
              <span>px</span>
              <label className={styles.setupCheck}>
                <Checkbox
                  checked={lockAspect}
                  onChange={(e) => {
                    setLockAspect(e.target.checked);
                    if (e.target.checked && setupWidth > 0 && setupHeight > 0) setLockedRatio(setupWidth / setupHeight);
                  }}
                />
                <span>Lock aspect ratio to {aspectRatioLabel(setupWidth, setupHeight)}</span>
              </label>
            </div>

            <label className={styles.setupLabel} htmlFor="setup-fps">Frame rate</label>
            <div className={styles.setupInline}>
              <select
                id="setup-fps"
                className={styles.formSelect}
                style={{ width: 'auto', minWidth: 200 }}
                value={setupFps}
                onChange={(e) => setSetupFps(Number(e.target.value))}
              >
                {FPS_PRESETS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              {setupTab === 'video' && <span className={styles.setupHint}>The editor reads the exact rate on import.</span>}
            </div>

            <label className={styles.setupLabel} htmlFor="setup-duration">Duration</label>
            <div className={styles.setupInline}>
              <input
                id="setup-duration"
                type="number"
                className={cn(styles.formInput, styles.formInputNumber)}
                value={setupDuration}
                step="0.1"
                min={MIN_DURATION}
                max={MAX_DURATION}
                onChange={(e) => setSetupDuration(Number(e.target.value))}
                onBlur={(e) => setSetupDuration(clampDuration(Number(e.target.value)))}
                required
              />
              <span>seconds</span>
              <span className={styles.setupHint}>
                {timecodeOf(setupDuration, setupFps)} · {Math.round(setupDuration * setupFps)} frames
              </span>
            </div>

            <span className={styles.setupLabel}>Background colour</span>
            <div className={styles.setupInline}>
              <div className={styles.swatchGroup}>
                {[
                  { name: 'Dark slate', hex: '#101014' },
                  { name: 'Black', hex: '#000000' },
                  { name: 'White', hex: '#ffffff' },
                  { name: 'Chroma green', hex: '#00ff00' },
                ].map((sw) => (
                  <button
                    key={sw.hex}
                    type="button"
                    className={cn(
                      styles.colorSwatchBtn,
                      !setupTransparent && setupBg.toLowerCase() === sw.hex.toLowerCase() && styles.colorSwatchBtnActive
                    )}
                    style={{ background: sw.hex }}
                    title={sw.name}
                    aria-label={sw.name}
                    onClick={() => { setSetupBg(sw.hex); setSetupTransparent(false); }}
                  />
                ))}
              </div>
              <div className={styles.setupColor}>
                <ColorPicker
                  value={setupBg}
                  onChange={(c) => { setSetupBg(c); setSetupTransparent(false); }}
                  aria-label="Background colour"
                />
              </div>
              <label className={styles.setupCheck}>
                <Checkbox
                  checked={setupTransparent}
                  onChange={(e) => setSetupTransparent(e.target.checked)}
                />
                <span>Transparent</span>
              </label>
            </div>
          </div>

          {/*
            Said before Create, not after it fails: at the cap the server refuses
            the create with `project_limit`. Create stays enabled — the count
            here is a cached /auth/me, and the server is the one that decides.
          */}
          {projectCap !== null && account && account.projectCount >= projectCap && (
            <div className={styles.setupLimitNote} role="status">
              <Icon name="info" size="sm" />
              <span>
                You are using all {projectCap} cloud projects on the Free plan. Move one to the
                Trash to make room{salesOpen ? ', or upgrade for unlimited projects' : ''}.
              </span>
              {salesOpen && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSetupModalOpen(false);
                    openTab('billing');
                  }}
                >
                  View plans
                </Button>
              )}
            </div>
          )}

          <div className={styles.modalFooter} data-dialog-actions>
            <span className={styles.setupNote}>You can change these later in composition settings.</span>
            <Button variant="secondary" onClick={() => setSetupModalOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={creating || (setupTab === 'video' && !setupFootage)}
              loading={creating}
            >
              Create
            </Button>
          </div>
        </form>
      </Modal>

      {/* Renders nothing until the store opens it. At the root rather than
          inside a tab, so switching tabs cannot unmount a dialog mid-answer. */}
      <ReviewPrompt />
    </div>
  );
}

export default DashboardPage;
