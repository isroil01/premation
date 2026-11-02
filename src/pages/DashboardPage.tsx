import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
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
import { setPendingRender } from '@core/project/pendingRender';
import { isFinishedStatus } from '@core/export/exportSupervisorClient';
import { useExportQueueStore } from '@stores/exportQueueStore';
import { DashboardRenders } from './DashboardRenders';
import { DashboardSettings } from './DashboardSettings';
import { DashboardConnections } from './DashboardConnections';
import { newProjectDocument } from '@core/project/newProjectDocument';
import { NativePluginsPage } from '@layout/Plugins/NativePluginsPage';
import { RegistryPluginsNotice } from '@layout/Plugins/RegistryPluginsNotice';
import { BILLING_QUERY_KEY, BillingSection, checkoutReturnState, fetchBillingPage } from '@layout/Settings/BillingSection';
import { SESSIONS_QUERY_KEY } from '@layout/Settings/AccountSection';
import { billingEnabled } from '@core/config/edition';
import { t } from '@core/i18n';
import { getUiPlatform, hasDesktopChrome } from '@core/config/uiPlatform';
import { TITLE_BAR_ROUTE_SLOT_ID } from '@layout/TitleBar/routeSlot';
import { ColorPicker } from '@components/ColorPicker';
import { cn } from '@utils/cn';
import {
  SIZE_PRESETS, SIZE_GROUPS, FPS_PRESETS,
  MIN_DIMENSION, MAX_DIMENSION, MIN_DURATION, MAX_DURATION,
  clampDimension, clampFps, clampDuration, describeSize, describeDuration,
  aspectRatioLabel, sizeGroupLabel,
} from '@core/composition/presets';
import { purgeStoredAssets, type AssetFolder, type ImportedAsset } from '@stores/assetStore';
import { useMirrorAssetRecords, useMirrorFolders } from '@hooks/useAssetRecords';
import { edit } from '@core/engine/uiEdits';
import { engine, hasEngine } from '@core/engine/engineInstance';
import { getAssetVisualInfo, FOLDER_COLOR } from '@layout/Assets/assetVisuals';
import { createFolderEdit, createFolderTreeEdit, importBrowserFilesEdit, renameItemEdit } from '@layout/Assets/assetEdits';
import {
  api,
  isAuthenticated,
  type AccountRecord,
  type ProjectSummary,
  type RenderJobDto,
  type TrashedProject,
} from '@core/api/client';
import { projectLimitDetail } from '@core/api/transport';
import { usePagedList } from '@hooks/usePagedList';
import { prefetchQuery, useCachedQuery } from '@hooks/useCachedQuery';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import { useCloudOffer } from '@hooks/useCloudOffer';
import { clearRecovery } from '@core/persistence/recovery';
import { DashboardPreferencePage, normalizePreferencePage, preferencePages, type PreferencePage } from './DashboardCustomizeTab';
import { DashboardTemplates } from './DashboardTemplates';
import { setPendingTemplate } from '@core/project/pendingTemplate';
import type { PremiumCatalogItem } from '@core/library/premium/packFormat';
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
      title={t('dashboard.readOnly.tooltip', "Past your plan's cloud project limit. It opens and exports, but does not save to the cloud.")}
    >
      <Icon name="lock" size="sm" />
      {t('dashboard.readOnly.label', 'Read-only')}
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
  if (s < 60) return t('dashboard.time.justNowLower', 'just now');
  const m = Math.round(s / 60);
  if (m < 60) return t('dashboard.time.minutesShort', '{n}m ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('dashboard.time.hoursShort', '{n}h ago', { n: h });
  return t('dashboard.time.daysShort', '{n}d ago', { n: Math.round(h / 24) });
}

/**
 * When a project was last touched, the way a file browser says it: relative
 * while that is the useful answer, a date once it is not.
 */
function lastEditedLabel(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const minutes = Math.round((Date.now() - d) / 60000);
  if (minutes < 1) return t('dashboard.time.justNow', 'Just now');
  if (minutes < 60) {
    return minutes === 1
      ? t('dashboard.time.minutesOne', '{n} minute ago', { n: minutes })
      : t('dashboard.time.minutesOther', '{n} minutes ago', { n: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1
      ? t('dashboard.time.hoursOne', '{n} hour ago', { n: hours })
      : t('dashboard.time.hoursOther', '{n} hours ago', { n: hours });
  }
  const days = Math.round(hours / 24);
  if (days === 1) return t('dashboard.time.yesterday', 'Yesterday');
  if (days < 7) return t('dashboard.time.daysOther', '{n} days ago', { n: days });
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
 *
 * Plan, Connections and Settings are also in the account menu. They are in
 * the sidebar so they stay visible without opening that menu.
 */
type TabType =
  | 'home'
  | 'projects'
  | 'templates'
  | 'assets'
  | 'renders'
  | 'trash'
  | 'customize'
  | 'billing'
  | 'plugins'
  | 'connections'
  | 'settings';

const TABS: readonly TabType[] = [
  'home', 'projects', 'templates', 'assets', 'renders', 'trash', 'customize', 'billing', 'plugins', 'connections', 'settings',
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
function navLibrary(): readonly NavItem[] {
  return [
    { tab: 'home', label: t('dashboard.nav.home', 'Home'), icon: 'home' },
    { tab: 'projects', label: t('dashboard.nav.projects', 'Projects'), icon: 'folder' },
    { tab: 'templates', label: t('dashboard.nav.library', 'Library'), icon: 'sparkles' },
    { tab: 'assets', label: t('dashboard.nav.assets', 'Assets'), icon: 'image' },
    { tab: 'renders', label: t('dashboard.nav.renders', 'Render queue'), icon: 'queue' },
    { tab: 'trash', label: t('dashboard.nav.trash', 'Trash'), icon: 'trash' },
  ];
}

/** The app's own setup. */
function navApp(): readonly NavItem[] {
  return [
    { tab: 'plugins', label: t('dashboard.nav.plugins', 'Plugins'), icon: 'plugin' },
    { tab: 'customize', label: t('dashboard.nav.preferences', 'Preferences'), icon: 'sliders-h' },
  ];
}

/** Account pages. Also listed in the profile menu. */
function accountNav(): NavItem[] {
  const items: NavItem[] = [];
  if (billingEnabled()) items.push({ tab: 'billing', label: t('dashboard.nav.plan', 'Plan'), icon: 'star' });
  items.push({ tab: 'connections', label: t('dashboard.nav.connections', 'Connections'), icon: 'link' });
  items.push({ tab: 'settings', label: t('dashboard.nav.settings', 'Settings'), icon: 'settings' });
  return items;
}

/** One line under the Home greeting: which plan, and how much of it is in use. */
function planGlance(account: AccountRecord): string {
  if (account.access.reason === 'beta') return t('dashboard.plan.beta', 'Cloud saving is open during beta');
  if (account.plan === 'pro') return t('dashboard.plan.unlimited', 'Unlimited cloud projects');
  const cap = account.access.limits?.cloudProjects;
  if (typeof cap === 'number') {
    return t('dashboard.plan.usage', '{used} of {cap} cloud projects', { used: account.projectCount.toLocaleString(), cap: cap.toLocaleString() });
  }
  return t('dashboard.plan.free', 'The editor is free');
}

/**
 * Render statuses, as a person would say them.
 *
 * `job.status.toUpperCase()` shouted RUNNING / QUEUED / FAILED at the reader
 * and, for `canceled`, spelled it the American way in a UI that is otherwise
 * British. A table maps the wire value to the label once.
 */
function renderStatusLabel(status: RenderJobDto['status']): string {
  switch (status) {
    case 'queued': return t('dashboard.renders.status.queued', 'Queued');
    case 'running': return t('dashboard.renders.status.running', 'Rendering');
    case 'completed': return t('dashboard.renders.status.completed', 'Done');
    case 'failed': return t('dashboard.renders.status.failed', 'Failed');
    case 'canceled': return t('dashboard.renders.status.canceled', 'Cancelled');
  }
}

const VIDEO_ACCEPT = 'video/*,.mp4,.mov,.webm,.m4v,.mxf,.avi,.mts,.m2ts,.mpg,.wmv,.mkv';

/** Rows per page for the queue and the trash — both are read, not browsed. */
const TABLE_PAGE_SIZE = 20;
/** Cards per page in the asset grid. */
const ASSET_PAGE_SIZE = 24;

/**
 * Library-wide numbers for the Home tab.
 *
 * Deliberately NOT derived from the loaded page: "Total Projects" counted the
 * rows in the browser, so it showed 24 for a 143-project account, and
 * "Active Renders" counted the running jobs among the newest 50. Both are now
 * a `total` from a one-row query, which is the count the server actually has.
 */
interface HomeOverview {
  projects: number;
  activeRenders: number;
  /** Renders that ended badly and the user has not looked at yet. */
  failedRenders: number;
  recent: ProjectSummary | null;
}

const EMPTY_OVERVIEW: HomeOverview = { projects: 0, activeRenders: 0, failedRenders: 0, recent: null };
const OVERVIEW_QUERY_KEY = 'dashboard:overview';

/**
 * Warm a page's data while the pointer is on its nav link, so the click lands
 * on content. Each read goes through `cachedGet`: a warm one costs nothing and
 * a cold one is the request the click was about to make anyway. Failures are
 * left for the page itself to report.
 */
function prefetchTab(tab: TabType): void {
  if (!isAuthenticated()) return;
  const quiet = (p: Promise<unknown>): void => void p.catch(() => undefined);
  switch (tab) {
    case 'billing':
      if (billingEnabled()) quiet(prefetchQuery(BILLING_QUERY_KEY, fetchBillingPage, ['billing', 'account']));
      break;
    case 'settings':
      quiet(prefetchQuery(SESSIONS_QUERY_KEY, api.listSessions, ['sessions']));
      break;
    case 'renders':
      quiet(api.listRenders({ limit: TABLE_PAGE_SIZE, offset: 0 }));
      break;
    case 'trash':
      quiet(api.listTrash({ limit: TABLE_PAGE_SIZE, offset: 0 }));
      break;
    default:
      break;
  }
}

async function fetchOverview(): Promise<{ account: AccountRecord; overview: HomeOverview }> {
  // Four one-row queries rather than four lists: every number here is a
  // `total` the server already knows, and asking for the rows to count them
  // would download a library to display one integer.
  const [me, newest, active, failed] = await Promise.all([
    api.me(),
    api.listProjects({ limit: 1 }),
    api.listRenders({ limit: 1, status: 'active' }),
    api.listRenders({ limit: 1, status: 'failed' }),
  ]);
  return {
    account: me,
    overview: {
      projects: newest.total,
      activeRenders: active.total,
      failedRenders: failed.total,
      recent: newest.items[0] ?? null,
    },
  };
}

/**
 * The format filter's labels. Orientation is the axis that actually
 * distinguishes a reel from a YouTube cut, and it comes from the comp's own
 * size (the server filters on it — see projectLibraryStore).
 */
function orientationLabel(o: Orientation): string {
  switch (o) {
    case 'landscape': return t('dashboard.orientation.landscape', 'Landscape');
    case 'portrait': return t('dashboard.orientation.portrait', 'Portrait');
    case 'square': return t('dashboard.orientation.square', 'Square');
  }
}

/** The empty-list line for one orientation filter. */
function noOrientationProjects(o: Orientation): string {
  switch (o) {
    case 'landscape': return t('dashboard.projects.noneLandscape', 'No landscape projects yet.');
    case 'portrait': return t('dashboard.projects.nonePortrait', 'No portrait projects yet.');
    case 'square': return t('dashboard.projects.noneSquare', 'No square projects yet.');
  }
}

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
    // Back from a web checkout: only the Plan page reads what the address says.
    if (checkoutReturnState(searchParams)) return 'billing';
    const tab = searchParams.get('tab');
    return isTab(tab) ? tab : 'home';
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
  /** `?section=` picks the Preferences page; the other tabs ignore it. */
  const prefPage = normalizePreferencePage(searchParams.get('section'));
  const openPreference = useCallback((page: PreferencePage): void => {
    setActiveTab('customize');
    navigate(`/dashboard?tab=customize&section=${page}`);
  }, [navigate]);

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
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Ctrl/Cmd+K: the search, from anywhere on the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
  /**
   * Plan + credits (from /auth/me) and the Home numbers, kept across visits
   * (useCachedQuery): back from the editor or another tab, Home paints its last
   * numbers at once and corrects them in the background. A create, delete or
   * render invalidates the tags below, which refetches it.
   */
  const overviewQuery = useCachedQuery(OVERVIEW_QUERY_KEY, fetchOverview, {
    tags: ['account', 'projects', 'renders'],
  });
  const account: AccountRecord | null = overviewQuery.data?.account ?? null;
  const serverOverview = overviewQuery.data?.overview ?? EMPTY_OVERVIEW;
  // Renders on this computer count beside the server's: they are the ones
  // that really run. Numbers, so a progress tick re-renders nothing here.
  const connectRenders = useExportQueueStore((s) => s.connect);
  useEffect(() => { void connectRenders(); }, [connectRenders]);
  const localActive = useExportQueueStore((s) => s.jobs.filter((j) => !isFinishedStatus(j.status)).length);
  const localFailed = useExportQueueStore((s) => s.jobs.filter((j) => j.status === 'failed').length);
  const overview = useMemo(() => ({
    ...serverOverview,
    activeRenders: serverOverview.activeRenders + localActive,
    failedRenders: serverOverview.failedRenders + localFailed,
  }), [serverOverview, localActive, localFailed]);
  /** The Home numbers could not be loaded — so Home states none, rather than zeroes. */
  const overviewFailed = !overviewQuery.data && overviewQuery.error !== null;
  const refreshOverview = overviewQuery.reload;
  // Pro sales can be closed server-side; the sidebar then stops saying "View plans".
  const salesOpen = useProSalesOpen();
  const offerLine = useCloudOffer();
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
    cacheKey: 'dashboard:renders',
    errorMessage: t('dashboard.renders.loadFailed', 'Could not load the render queue.'),
  });

  const fetchTrash = useCallback(
    (page: { limit: number; offset: number }) => api.listTrash(page),
    [],
  );
  const trash = usePagedList<TrashedProject>(fetchTrash, {
    pageSize: TABLE_PAGE_SIZE,
    enabled: activeTab === 'trash',
    cacheKey: 'dashboard:trash',
    errorMessage: t('dashboard.trash.loadFailed', 'Could not load the trash.'),
  });


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
    const timer = setTimeout(() => { void load({ query: searchQuery }); }, 250);
    return () => clearTimeout(timer);
  }, [load, searchQuery]);

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

  /**
   * Library page → a new project, opened in the editor, which inserts the item
   * into its still-empty comp. A scene template brings its own size; an
   * element, a Lottie animation or a sound gets the standard 1080p comp.
   */
  const onUseTemplate = async (item: PremiumCatalogItem): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      clearRecovery();
      // Only a scene template brings its own size; everything else lands in a standard comp.
      const scene = item.kind === 'template' && item.mode !== 'element';
      const fallback = item.kind !== 'template' ? [1920, 1080] : item.aspect === '9:16' ? [1080, 1920] : item.aspect === '1:1' ? [1080, 1080] : [1920, 1080];
      const width = clampDimension(scene && item.width ? item.width : fallback[0]!);
      const height = clampDimension(scene && item.height ? item.height : fallback[1]!);
      const durationSeconds = clampDuration(Math.max(scene ? 1 : 10, Math.ceil(item.durationSec)));
      const initialDoc = newProjectDocument({ name: item.name, width, height, fps: 30, durationSeconds, background: '#101014', transparent: false });
      const p = await create(item.name, initialDoc);
      if (!p?.id) throw new Error(t('dashboard.create.noId', 'The server did not return a project id.'));
      setPendingTemplate(item);
      navigate(`/editor/${p.id}`);
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : t('dashboard.create.failed', 'Could not create the composition. Check your connection and try again.');
      useUIStore.getState().notify({ level: 'error', message, durationMs: 6000 });
    } finally {
      setCreating(false);
    }
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
      // Shared with Claude's create_project (core/project/newProjectDocument).
      const initialDoc = newProjectDocument({
        name: compName,
        width,
        height,
        fps,
        durationSeconds,
        background: setupBg,
        transparent: setupTransparent,
      });
      const p = await create(compName, initialDoc);
      if (!p?.id) throw new Error(t('dashboard.create.noId', 'The server did not return a project id.'));
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
          : t('dashboard.create.failed', 'Could not create the composition. Check your connection and try again.');
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
    if (!await customConfirm(
      t('dashboard.projects.trashTitle', 'Move to Trash'),
      t('dashboard.projects.trashMessage', 'Move “{name}” to the trash? You can restore it for 30 days.', { name }),
      { confirmLabel: t('dashboard.projects.trashConfirm', 'Move to Trash') },
    )) return;
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
      setDataError(err instanceof Error ? err.message : t('dashboard.assets.uploadFailed', 'Upload failed.'));
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
      if (dirs.length > 0 && pathToId.size === 0) throw new Error(t('dashboard.assets.createFoldersFailed', 'Could not create the folders.'));
      const items = picked.map(({ file, dir }) => ({ file, folderId: dir ? pathToId.get(dir) ?? currentFolderId : currentFolderId }));
      if (items.length > 0) {
        await importBrowserFilesEdit(items);
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : t('dashboard.assets.folderImportFailed', 'Folder import failed.'));
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
    const countVars = { assets: assetCount, folders: subCount };
    const contents = subCount === 0
      ? assetCount === 1
        ? t('dashboard.assets.deleteFolderAssetsOne', 'This deletes the folder and everything inside it ({assets} asset). This can’t be undone.', countVars)
        : t('dashboard.assets.deleteFolderAssetsOther', 'This deletes the folder and everything inside it ({assets} assets). This can’t be undone.', countVars)
      : assetCount === 1
        ? subCount === 1
          ? t('dashboard.assets.deleteFolderAssetOneSubOne', 'This deletes the folder and everything inside it ({assets} asset, {folders} subfolder). This can’t be undone.', countVars)
          : t('dashboard.assets.deleteFolderAssetOneSubOther', 'This deletes the folder and everything inside it ({assets} asset, {folders} subfolders). This can’t be undone.', countVars)
        : subCount === 1
          ? t('dashboard.assets.deleteFolderAssetOtherSubOne', 'This deletes the folder and everything inside it ({assets} assets, {folders} subfolder). This can’t be undone.', countVars)
          : t('dashboard.assets.deleteFolderAssetOtherSubOther', 'This deletes the folder and everything inside it ({assets} assets, {folders} subfolders). This can’t be undone.', countVars);
    const ok = await customConfirm(
      t('dashboard.assets.deleteFolderTitle', 'Delete “{name}”', { name: folder.name }),
      assetCount || subCount
        ? contents
        : t('dashboard.assets.deleteEmptyFolder', 'Delete this empty folder?'),
      { confirmLabel: t('dashboard.delete', 'Delete'), isDanger: true }
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
    if (!await customConfirm(
      t('dashboard.assets.deleteAssetTitle', 'Delete Asset'),
      t('dashboard.assets.deleteAssetMessage', 'Delete “{name}”? This cannot be undone.', { name }),
      { isDanger: true, confirmLabel: t('dashboard.delete', 'Delete') },
    )) return;
    try {
      await deletePermanentlyEdit([id], storeAssets.filter((a) => a.id === id));
    } catch (err) {
      setDataError(err instanceof Error ? err.message : t('dashboard.assets.deleteFailed', 'Could not delete that asset.'));
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
      setDataError(err instanceof Error ? err.message : t('dashboard.trash.restoreFailed', 'Could not restore that project.'));
    }
  };

  const handleDestroy = async (id: string, name: string): Promise<void> => {
    if (!await customConfirm(
      t('dashboard.trash.destroyTitle', 'Permanently Delete Project'),
      t('dashboard.trash.destroyMessage', 'Permanently delete “{name}”? This cannot be undone — the project and all of its version history will be gone for good.', { name }),
      { isDanger: true, confirmLabel: t('dashboard.trash.destroyConfirm', 'Permanently Delete') }
    )) return;
    try {
      await api.destroyProject(id);
      trash.removeLocal([id]);
      void refreshOverview();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : t('dashboard.trash.destroyFailed', 'Could not delete that project.'));
    }
  };

  /** Render: the project opens with the Export dialog up (`pendingRender`). */
  const renderProject = (id: string): void => {
    setPendingRender(id);
    navigate(`/editor/${id}`);
  };

  const handleCancelRender = async (id: string): Promise<void> => {
    try {
      await api.cancelRender(id);
      // Refetch rather than patch the row in place: cancelling changes what the
      // Home tab's "active" count is, and the page may be stale in other ways.
      renders.reload();
      void refreshOverview();
    } catch (err) {
      setDataError(err instanceof Error ? err.message : t('dashboard.renders.cancelFailed', 'Could not cancel that render.'));
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
                  <h2 className={styles.newsTitle}>{t('dashboard.news.title', 'New in {release}: the native engine', { release: RELEASE_LABEL })}</h2>
                  <p className={styles.newsText}>
                    {t('dashboard.news.text', 'Playback, rendering and export now run in a new GPU engine. Your existing projects open as before.')}
                  </p>
                </div>
                <button type="button" className={styles.btnSecondary} onClick={openWhatsNew}>
                  {t('dashboard.news.seeWhatsNew', 'See what’s new')}
                </button>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={dismissNews}
                  title={t('dashboard.news.dismiss', 'Dismiss')}
                  aria-label={t('dashboard.news.dismiss', 'Dismiss')}
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
                      ? t('dashboard.home.rendersFailedOne', '1 render failed')
                      : t('dashboard.home.rendersFailedOther', '{n} renders failed', { n: overview.failedRenders.toLocaleString() })}
                  </button>
                )}
                {overview.activeRenders > 0 && (
                  <button
                    type="button"
                    className={styles.overviewSignal}
                    onClick={() => openTab('renders')}
                  >
                    {overview.activeRenders === 1
                      ? t('dashboard.home.rendersActiveOne', '1 render in progress')
                      : t('dashboard.home.rendersActiveOther', '{n} renders in progress', { n: overview.activeRenders.toLocaleString() })}
                  </button>
                )}
              </div>
            )}

            <div className={styles.sectionHeaderRow}>
              <h2 className={styles.sectionTitle}>{t('dashboard.home.recent', 'Recent')}</h2>
              <button type="button" className={styles.sectionLink} onClick={() => openTab('projects')}>
                {overviewFailed || overview.projects <= 6
                  ? t('dashboard.home.allProjects', 'All projects')
                  : t('dashboard.home.allProjectsCount', 'All {n} projects', { n: overview.projects.toLocaleString() })}
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
                  {t('dashboard.assets.filterAll', 'All')}
                </button>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'video' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('video')}
                >
                  {t('dashboard.assets.filterVideos', 'Videos')}
                </button>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'image' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('image')}
                >
                  {t('dashboard.assets.filterImages', 'Images')}
                </button>
                <button
                  type="button"
                  className={`${styles.segment} ${assetTypeFilter === 'audio' ? styles.segmentActive : ''}`}
                  onClick={() => setAssetTypeFilter('audio')}
                >
                  {t('dashboard.assets.filterAudio', 'Audio')}
                </button>
              </div>

              <div className={styles.assetToolbar}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => { void handleNewFolder(); }}
                  title={t('dashboard.assets.newFolderTooltip', 'Create new folder')}
                >
                  <Icon name="folder-plus" size="md" style={{ color: FOLDER_COLOR }} />
                  <span>{t('dashboard.assets.newFolder', 'New folder')}</span>
                </button>

                <label className={`${styles.btnSecondary} ${assetsBusy ? styles.fileLabelBusy : styles.fileLabel}`}>
                  <Icon name="folder-open" size="md" style={{ color: FOLDER_COLOR }} />
                  <span>{t('dashboard.assets.importFolder', 'Import folder')}</span>
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
                  <span>{assetsBusy ? t('dashboard.assets.uploading', 'Uploading…') : t('dashboard.assets.importAsset', 'Import asset')}</span>
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

            <nav className={styles.breadcrumb} aria-label={t('dashboard.assets.breadcrumbAria', 'Asset folder')}>
              <button
                type="button"
                className={`${styles.breadcrumbBtn} ${currentFolderId === null ? styles.breadcrumbBtnActive : ''}`}
                onClick={() => setCurrentFolderId(null)}
              >
                {t('dashboard.assets.allAssets', 'All assets')}
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
                <h3>{currentFolderId === null ? t('dashboard.assets.emptyTitle', 'No assets yet') : t('dashboard.assets.folderEmptyTitle', 'This folder is empty')}</h3>
                <p>
                  {currentFolderId === null
                    ? t('dashboard.assets.emptyText', 'Footage, stills and audio you import here are available to every project in your library.')
                    : t('dashboard.assets.folderEmptyText', 'Import media into this folder, or drop a subfolder inside it to keep things sorted.')}
                </p>
                <label className={`${styles.btnPrimary} ${assetsBusy ? styles.fileLabelBusy : styles.fileLabel}`}>
                  <Icon name="upload" size="md" />
                  <span>{assetsBusy ? t('dashboard.assets.uploading', 'Uploading…') : t('dashboard.assets.importAsset', 'Import asset')}</span>
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
                        <div className={styles.assetDetails}>
                          {count === 1
                            ? t('dashboard.assets.itemsOne', '{n} item', { n: count })
                            : t('dashboard.assets.itemsOther', '{n} items', { n: count })}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        title={t('dashboard.assets.deleteFolder', 'Delete folder')}
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
                        title={t('dashboard.assets.deleteAsset', 'Delete asset')}
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
          <div className={styles.rendersPage}>
            <DashboardRenders
              projects={projects}
              cloudLoading={renders.status === 'loading'}
              hasCloudRenders={renders.items.length > 0}
              onRenderProject={renderProject}
              onOpenProject={(id) => navigate(`/editor/${id}`)}
              onBrowseProjects={() => openTab('projects')}
              timeAgo={timeAgo}
            />
            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}
            {renders.status === 'error' ? <p className={styles.emptyHint}>{renders.error}</p> : null}
            {renders.items.length > 0 ? (
              <div className={styles.tableCard}>
              <h2 className={styles.sectionTitle}>{t('dashboard.renders.cloudTitle', 'Cloud renders')}</h2>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t('dashboard.renders.colJob', 'Job Name')}</th>
                    <th>{t('dashboard.renders.colFormat', 'Format')}</th>
                    <th>{t('dashboard.renders.colProgress', 'Progress')}</th>
                    <th>{t('dashboard.renders.colStatus', 'Status')}</th>
                    <th>{t('dashboard.renders.colCreated', 'Created')}</th>
                    <th style={{ width: '60px', textAlign: 'center' }}>{t('dashboard.renders.colActions', 'Actions')}</th>
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
                            <span style={{ fontWeight: 600 }}>{project?.name ?? t('dashboard.renders.untitled', 'Untitled render')}</span>
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
                            {renderStatusLabel(job.status)}
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
                              title={t('dashboard.renders.download', 'Download result')}
                            >
                              <Icon name="download" size="md" />
                            </a>
                          ) : job.status === 'queued' || job.status === 'running' ? (
                            <button
                              type="button"
                              className={styles.actionBtn}
                              title={t('dashboard.renders.cancel', 'Cancel render')}
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
              </div>
            ) : null}
          </div>
        );

      case 'trash':
        return (
          <div className={styles.tableCard}>
            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}
            {trash.status === 'error' ? <p className={styles.emptyHint}>{trash.error}</p> : null}
            {trash.status === 'loading' ? (
              <div className={styles.loadingState}>
                <p>{t('dashboard.trash.loading', 'Loading trash…')}</p>
              </div>
            ) : trash.items.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="trash" size={48} className={styles.emptyStateIcon} />
                <h3>{t('dashboard.trash.emptyTitle', 'Nothing in the trash')}</h3>
                <p>{t('dashboard.trash.emptyText', 'Deleted projects rest here for 30 days, and can be restored at any point before that.')}</p>
              </div>
            ) : (
              <>
                {selectedTrashIds.size > 0 && (
                  <div className={styles.selectionBar}>
                    <span className={styles.selectionCount}>
                      {selectedTrashIds.size === 1
                        ? t('dashboard.selectedOne', '{n} project selected', { n: selectedTrashIds.size })
                        : t('dashboard.selectedOther', '{n} projects selected', { n: selectedTrashIds.size })}
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
                      <span>{t('dashboard.trash.restoreSelected', 'Restore selected ({n})', { n: selectedTrashIds.size })}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.btnDanger}
                      onClick={async () => {
                        if (!await customConfirm(
                          t('dashboard.trash.destroyManyTitle', 'Permanently Delete Projects'),
                          t('dashboard.trash.destroyManyMessage', 'Permanently delete {n} selected projects? This cannot be undone.', { n: selectedTrashIds.size }),
                          { isDanger: true, confirmLabel: t('dashboard.trash.destroyConfirm', 'Permanently Delete') }
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
                      <span>{t('dashboard.trash.deleteSelected', 'Delete permanently ({n})', { n: selectedTrashIds.size })}</span>
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
                      <th>{t('dashboard.trash.colProject', 'Project')}</th>
                      <th>{t('dashboard.trash.colDeleted', 'Deleted')}</th>
                      <th>{t('dashboard.trash.colPurges', 'Purges in')}</th>
                      <th style={{ width: '150px', textAlign: 'center' }}>{t('dashboard.trash.colActions', 'Actions')}</th>
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
                              {p.purgesInDays === 1
                                ? t('dashboard.trash.daysOne', '{n} day', { n: p.purgesInDays })
                                : t('dashboard.trash.daysOther', '{n} days', { n: p.purgesInDays })}
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
                                <span>{t('dashboard.trash.restore', 'Restore')}</span>
                              </button>
                              <button
                                type="button"
                                className={styles.actionBtn}
                                title={t('dashboard.trash.deletePermanently', 'Delete permanently')}
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
        return (
          <div className={styles.pluginsPanel}>
            <NativePluginsPage />
          </div>
        );

      case 'customize':
        return <DashboardPreferencePage key={prefPage} page={prefPage} />;

      case 'templates':
        return <DashboardTemplates creating={creating} onUse={(item) => { void onUseTemplate(item); }} onOpenBilling={() => openTab('billing')} />;

      case 'connections':
        return (
          <div className={styles.connectionsPanel}>
            <DashboardConnections account={account} onOpenBilling={() => openTab('billing')} />
          </div>
        );

      case 'settings':
        return (
          <DashboardSettings
            user={user}
            account={account}
            onAccountChanged={refreshOverview}
            onOpenBilling={() => openTab('billing')}
            onOpenConnections={() => openTab('connections')}
            onOpenPreferences={() => openPreference('general')}
          />
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
          <div className={styles.skeletonTable} aria-busy="true" aria-label={t('dashboard.projects.loadingAria', 'Loading projects')}>
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
              {t('dashboard.projects.retry', 'Retry')}
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
                <h3>{t('dashboard.projects.noMatchTitle', 'No projects match')}</h3>
                <p>
                  {searchQuery.trim()
                    ? t('dashboard.projects.noMatchQuery', 'Nothing in your library is called “{query}”.', { query: searchQuery.trim() })
                    : orientation === 'all'
                      ? t('dashboard.projects.noMatchFilters', 'Nothing matched the current filters.')
                      : noOrientationProjects(orientation)}
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
                  {t('dashboard.projects.clearFilters', 'Clear filters')}
                </button>
              </>
            ) : (
              <>
                <Icon name="folder" size={48} className={styles.emptyStateIcon} />
                <h3>{t('dashboard.projects.emptyTitle', 'No projects yet')}</h3>
                <p>{t('dashboard.projects.emptyText', 'A project is one composition — its comps, layers and renders live inside it.')}</p>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={onCreate}
                  disabled={creating}
                >
                  <Icon name="plus" size="md" />
                  <span>{creating ? t('dashboard.projects.creating', 'Creating…') : t('dashboard.projects.createFirst', 'Create your first project')}</span>
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
                      title={t('dashboard.projects.selectPage', 'Select every project on this page')}
                    />
                  </th>
                )}
                <th className={styles.colName}>{t('dashboard.projects.colName', 'Name')}</th>
                <th>{t('dashboard.projects.colLastEdited', 'Last edited')}</th>
                <th className={styles.colOptional}>{t('dashboard.projects.colFrameSize', 'Frame size')}</th>
                <th>{t('dashboard.projects.colDuration', 'Duration')}</th>
                <th style={{ width: '44px' }} aria-label={t('dashboard.projects.colActions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const isSelected = selectable && selectedIds.has(p.id);
                const open = (): void => navigate(`/editor/${p.id}`);
                const menu: DropdownItem[] = [
                  { type: 'item', id: 'open', label: t('dashboard.projects.menuOpen', 'Open'), onSelect: open },
                  { type: 'item', id: 'render', label: t('dashboard.projects.menuRender', 'Render…'), onSelect: () => renderProject(p.id) },
                  { type: 'separator' },
                  { type: 'item', id: 'trash', label: t('dashboard.projects.trashTitle', 'Move to Trash'), danger: true, onSelect: () => { void onDelete(p.id, p.name); } },
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
                            title={t('dashboard.projects.more', 'More')}
                            aria-label={t('dashboard.projects.actionsFor', 'Actions for {name}', { name: p.name })}
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
          title: t('dashboard.nav.home', 'Home'),
          desc: '',
        };
      case 'projects':
        return {
          title: t('dashboard.nav.projects', 'Projects'),
          desc: '',
        };
      case 'trash':
        return {
          title: t('dashboard.nav.trash', 'Trash'),
          desc: t('dashboard.header.trashDesc', 'Restore deleted projects within 30 days, or remove them permanently.'),
        };
      case 'assets':
        return {
          title: t('dashboard.nav.assets', 'Assets'),
          desc: t('dashboard.header.assetsDesc', 'Import and organize media you’ll use across projects.'),
        };
      case 'renders':
        return {
          title: t('dashboard.nav.renders', 'Render queue'),
          desc: t('dashboard.header.rendersDesc', 'Everything rendered on this computer, from every project. Start a new render, or follow the ones in progress.'),
        };
      case 'billing':
        return {
          title: t('dashboard.nav.plan', 'Plan'),
          desc: t('dashboard.header.billingDesc', 'What’s included, and how to change or cancel.'),
        };
      case 'connections':
        return {
          title: t('dashboard.nav.connections', 'Connections'),
          desc: t('dashboard.header.connectionsDesc', 'Claude, Cursor, Antigravity and ChatGPT on this computer.'),
        };
      case 'plugins':
        return {
          title: t('dashboard.nav.plugins', 'Plugins'),
          desc: t('dashboard.header.pluginsDesc', 'Native plugins installed on this machine, and how to add more.'),
        };
      case 'customize': {
        const page = preferencePages().find((pg) => pg.id === prefPage);
        return {
          title: page?.label ?? t('dashboard.nav.preferences', 'Preferences'),
          desc: page?.desc ?? '',
          eyebrow: t('dashboard.nav.preferences', 'Preferences'),
        };
      }
      case 'templates':
        return {
          title: t('dashboard.nav.library', 'Library'),
          desc: t('dashboard.header.libraryDesc', 'Templates, transitions, Lottie animations and sounds. Preview anything, then start a project with it.'),
        };
      case 'settings':
        return {
          title: t('dashboard.nav.settings', 'Settings'),
          desc: t('dashboard.header.settingsDesc', 'Your account, and the devices signed in to it.'),
        };
    }
  }, [activeTab, prefPage]);

  const displayName = user?.name || user?.email?.split('@')[0] || t('dashboard.account.fallbackName', 'Account');
  const displayInitial = displayName.trim().charAt(0).toUpperCase() || '?';
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? '';

  const navButton = (item: NavItem): JSX.Element => (
    <button
      key={item.tab}
      type="button"
      className={`${styles.navLink} ${activeTab === item.tab ? styles.navLinkActive : ''}`}
      aria-current={activeTab === item.tab ? 'page' : undefined}
      onClick={() => openTab(item.tab)}
      onPointerEnter={() => prefetchTab(item.tab)}
      onFocus={() => prefetchTab(item.tab)}
    >
      <Icon name={item.icon} size="md" className={styles.navIcon} />
      <span>{item.label}</span>
      {item.tab === 'renders' && overview.activeRenders > 0 && (
        <span className={styles.navCount} title={t('dashboard.nav.rendersInProgress', 'Renders in progress')}>{overview.activeRenders}</span>
      )}
      {item.tab === 'billing' && account && (
        <span className={`${styles.navBadge} ${account.plan === 'pro' ? styles.navBadgePro : ''}`}>
          {account.plan === 'pro' ? t('dashboard.plan.badgePro', 'Pro') : t('dashboard.plan.badgeFree', 'Free')}
        </span>
      )}
    </button>
  );

  const accountMenu: DropdownItem[] = [
    {
      type: 'custom',
      id: 'who',
      render: (
        <div className={styles.accountMenuHead}>
          <span className={styles.accountName}>{displayName}</span>
          {user?.email ? <span className={styles.accountEmail}>{user.email}</span> : null}
          {account && billingEnabled() ? (
            <span className={styles.accountPlan}>{account.plan === 'pro' ? 'Premation Cloud' : t('dashboard.account.freePlan', 'Free plan')}</span>
          ) : null}
        </div>
      ),
    },
    { type: 'separator' },
    { type: 'item', id: 'settings', label: t('dashboard.nav.settings', 'Settings'), onSelect: () => openTab('settings') },
    { type: 'item', id: 'connections', label: t('dashboard.nav.connections', 'Connections'), onSelect: () => openTab('connections') },
    ...(billingEnabled()
      ? [{
          type: 'item' as const,
          id: 'billing',
          label: account?.plan && account.plan !== 'free'
            ? t('dashboard.account.managePlan', 'Manage plan')
            : salesOpen ? t('dashboard.account.viewPlans', 'View plans') : t('dashboard.account.yourPlan', 'Your plan'),
          onSelect: () => openTab('billing'),
        }]
      : []),
    { type: 'separator' },
    { type: 'item', id: 'signout', label: t('dashboard.account.signOut', 'Sign out'), onSelect: () => { void logout(); } },
  ];

  /*
    One search for the dashboard. It searches projects — the query is the
    server's — so typing from any page lands on the list it filters.
  */
  const searchField = (
    <div className={styles.topSearch}>
      <Icon name="search" size="sm" className={styles.topSearchIcon} />
      <input
        ref={searchRef}
        type="search"
        placeholder={t('dashboard.search.placeholder', 'Search projects')}
        className={styles.topSearchInput}
        value={searchQuery}
        onChange={(e) => {
          setSearchQuery(e.target.value);
          if (activeTab !== 'projects') openTab('projects');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setSearchQuery(''); e.currentTarget.blur(); }
        }}
        aria-label={t('dashboard.search.placeholder', 'Search projects')}
        aria-keyshortcuts="Control+K Meta+K"
      />
      {searchQuery ? null : <kbd className={styles.topSearchKey} aria-hidden>{getUiPlatform() === 'mac' ? '⌘K' : 'Ctrl K'}</kbd>}
    </div>
  );

  const topControls = (
    <>
      {searchField}
      <Dropdown
        placement="bottom-end"
        items={accountMenu}
        trigger={
          <button type="button" className={styles.accountButton} title={t('dashboard.account.button', 'Account')} aria-label={t('dashboard.account.button', 'Account')}>
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
            {topControls}
          </header>
        )
      )}

      <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.railCta}>
          <button type="button" className={styles.ctaPrimary} onClick={onCreate} disabled={creating}>
            {t('dashboard.newProject', 'New project')}
          </button>
          <button type="button" className={styles.ctaSecondary} onClick={onCreateFromVideo} disabled={creating}>
            {t('dashboard.newFromVideo', 'New from video')}
          </button>
        </div>

        <nav className={styles.sidebarNav} aria-label={t('dashboard.nav.aria', 'Dashboard')}>
          {navLibrary().map((item) => navButton(item))}
          <div className={styles.navDivider} role="separator" />
          {navApp().map((item) => (
            item.tab === 'customize' ? (
              <div key={item.tab} className={styles.navGroup}>
                <button
                  type="button"
                  className={styles.navLink}
                  aria-expanded={activeTab === 'customize'}
                  onClick={() => openTab('customize')}
                >
                  <Icon name={item.icon} size="md" className={styles.navIcon} />
                  <span>{item.label}</span>
                  <Icon name="chevron-down" size="sm" className={cn(styles.navChevron, activeTab === 'customize' && styles.navChevronOpen)} />
                </button>
                {activeTab === 'customize' && (
                  <div className={styles.navSub}>
                    {preferencePages().map((pg) => (
                      <button
                        key={pg.id}
                        type="button"
                        className={cn(styles.navSubLink, prefPage === pg.id && styles.navSubLinkActive)}
                        aria-current={prefPage === pg.id ? 'page' : undefined}
                        onClick={() => openPreference(pg.id)}
                      >
                        {pg.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : navButton(item)
          ))}
          <div className={styles.navDivider} role="separator" />
          {accountNav().map((item) => navButton(item))}
        </nav>

        <div className={styles.railFoot}>
          {hasEngine() && (
            <span className={styles.engineLine}>
              <span className={`${styles.engineDot} ${styles.engineDotReady}`} aria-hidden />
              {t('dashboard.engineReady', 'Engine ready')}
            </span>
          )}
          <span>{t('dashboard.version', 'Version {version}', { version: APP_VERSION })}</span>
        </div>
      </aside>

      <div className={styles.container}>
        <main className={styles.mainContent}>
          {activeTab === 'home' ? (
            <div className={styles.welcomeBlock}>
              <h1 className={styles.welcomeTitle}>
                {firstName
                  ? t('dashboard.home.welcomeNamed', 'Welcome to Premation, {name}', { name: firstName })
                  : t('dashboard.home.welcome', 'Welcome to Premation')}
              </h1>
              {account && billingEnabled() && (
                <button type="button" className={styles.planLine} onClick={() => openTab('billing')}>
                  <span className={styles.planMark} data-plan={account.plan === 'pro' ? 'pro' : 'free'}>
                    {account.plan === 'pro' ? t('dashboard.plan.badgePro', 'Pro') : t('dashboard.plan.badgeFree', 'Free')}
                  </span>
                  <span>{planGlance(account)}</span>
                </button>
              )}
            </div>
          ) : (
            <div className={styles.pageTitleRow}>
              <div className={styles.pageTitleBlock}>
                {'eyebrow' in headerDetails && headerDetails.eyebrow ? <span className={styles.pageEyebrow}>{headerDetails.eyebrow}</span> : null}
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
                        if (await customConfirm(
                          t('dashboard.projects.trashTitle', 'Move to Trash'),
                          t('dashboard.projects.trashManyMessage', 'Move {n} projects to the trash? You can restore them for 30 days.', { n: selectedIds.size }),
                          { confirmLabel: t('dashboard.projects.trashConfirm', 'Move to Trash') },
                        )) {
                          await removeMany(selectedIds);
                          setSelectedIds(new Set());
                          void refreshOverview();
                        }
                      }}
                    >
                      <Icon name="trash" size="md" />
                      <span>{t('dashboard.projects.trashSelected', 'Move to Trash ({n})', { n: selectedIds.size })}</span>
                    </button>
                  )}
                  <div className={styles.segmentedGroup} role="group" aria-label={t('dashboard.projects.filterAria', 'Filter by format')}>
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
                        {value === 'all' ? t('dashboard.projects.filterAll', 'All') : orientationLabel(value)}
                      </button>
                    ))}
                  </div>
                  <div className={styles.viewToggle} role="group" aria-label={t('dashboard.projects.viewAria', 'View')}>
                    <button
                      type="button"
                      className={`${styles.viewToggleBtn} ${projectView === 'list' ? styles.viewToggleBtnActive : ''}`}
                      aria-pressed={projectView === 'list'}
                      title={t('dashboard.projects.listView', 'List view')}
                      aria-label={t('dashboard.projects.listView', 'List view')}
                      onClick={() => chooseProjectView('list')}
                    >
                      <Icon name="menu" size="md" />
                    </button>
                    <button
                      type="button"
                      className={`${styles.viewToggleBtn} ${projectView === 'grid' ? styles.viewToggleBtnActive : ''}`}
                      aria-pressed={projectView === 'grid'}
                      title={t('dashboard.projects.gridView', 'Grid view')}
                      aria-label={t('dashboard.projects.gridView', 'Grid view')}
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
        title={t('dashboard.newProject', 'New project')}
        size="md"
        className={styles.setupDialog}
        persistent={creating}
      >
        <form className={styles.modalForm} onSubmit={onLaunchWorkspace}>
          <div className={styles.setupTabs} role="tablist" aria-label={t('dashboard.setup.startFromAria', 'Start from')}>
            <button
              type="button"
              role="tab"
              aria-selected={setupTab === 'blank'}
              className={cn(styles.setupTab, setupTab === 'blank' && styles.setupTabActive)}
              onClick={() => { setSetupTab('blank'); setSetupFootage(null); }}
            >
              {t('dashboard.setup.tabBlank', 'Blank')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={setupTab === 'video'}
              className={cn(styles.setupTab, setupTab === 'video' && styles.setupTabActive)}
              onClick={() => { setSetupTab('video'); if (!setupFootage) pickSetupVideo(); }}
            >
              {t('dashboard.setup.tabVideo', 'From video file')}
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
                        {t('dashboard.setup.fileMeta', '{width} × {height} · {duration} · placed at full frame', { width: setupWidth, height: setupHeight, duration: describeDuration(setupDuration) })}
                      </span>
                    </>
                  ) : (
                    <span className={styles.setupFileMeta}>
                      {t('dashboard.setup.noFile', 'No file chosen. The project takes its size and length from the video.')}
                    </span>
                  )}
                </div>
                <button type="button" className={styles.setupFileChange} onClick={pickSetupVideo}>
                  {setupFootage ? t('dashboard.setup.chooseAnother', 'Choose another…') : t('dashboard.setup.chooseVideo', 'Choose a video file…')}
                </button>
              </div>
            )}

            <label className={styles.setupLabel} htmlFor="setup-name">{t('dashboard.setup.projectName', 'Project name')}</label>
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
                <label className={styles.setupLabel} htmlFor="setup-preset">{t('dashboard.setup.preset', 'Preset')}</label>
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
                  <option value="custom">{t('dashboard.setup.presetCustom', 'Custom')}</option>
                  {SIZE_GROUPS.map((group) => (
                    <optgroup key={group} label={sizeGroupLabel(group)}>
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

            <label className={styles.setupLabel} htmlFor="setup-width">{t('dashboard.setup.width', 'Width')}</label>
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
                title={t('dashboard.setup.swap', 'Swap width and height')}
                aria-label={t('dashboard.setup.swap', 'Swap width and height')}
              >
                <Icon name="refresh" size="sm" />
              </button>
            </div>

            <label className={styles.setupLabel} htmlFor="setup-height">{t('dashboard.setup.height', 'Height')}</label>
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
                <span>{t('dashboard.setup.lockAspect', 'Lock aspect ratio to {ratio}', { ratio: aspectRatioLabel(setupWidth, setupHeight) })}</span>
              </label>
            </div>

            <label className={styles.setupLabel} htmlFor="setup-fps">{t('dashboard.setup.frameRate', 'Frame rate')}</label>
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
              {setupTab === 'video' && <span className={styles.setupHint}>{t('dashboard.setup.rateHint', 'The editor reads the exact rate on import.')}</span>}
            </div>

            <label className={styles.setupLabel} htmlFor="setup-duration">{t('dashboard.setup.duration', 'Duration')}</label>
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
              <span>{t('dashboard.setup.seconds', 'seconds')}</span>
              <span className={styles.setupHint}>
                {t('dashboard.setup.durationHint', '{timecode} · {frames} frames', { timecode: timecodeOf(setupDuration, setupFps), frames: Math.round(setupDuration * setupFps) })}
              </span>
            </div>

            <span className={styles.setupLabel}>{t('dashboard.setup.background', 'Background colour')}</span>
            <div className={styles.setupInline}>
              <div className={styles.swatchGroup}>
                {[
                  { name: t('dashboard.setup.swatchSlate', 'Dark slate'), hex: '#101014' },
                  { name: t('dashboard.setup.swatchBlack', 'Black'), hex: '#000000' },
                  { name: t('dashboard.setup.swatchWhite', 'White'), hex: '#ffffff' },
                  { name: t('dashboard.setup.swatchGreen', 'Chroma green'), hex: '#00ff00' },
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
                  aria-label={t('dashboard.setup.background', 'Background colour')}
                />
              </div>
              <label className={styles.setupCheck}>
                <Checkbox
                  checked={setupTransparent}
                  onChange={(e) => setSetupTransparent(e.target.checked)}
                />
                <span>{t('dashboard.setup.transparent', 'Transparent')}</span>
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
                {salesOpen
                  ? t('dashboard.setup.limitUpgrade', 'You are using all {cap} cloud projects on the Free plan. Move one to the Trash to make room, or upgrade for unlimited projects.', { cap: projectCap })
                  : t('dashboard.setup.limit', 'You are using all {cap} cloud projects on the Free plan. Move one to the Trash to make room.', { cap: projectCap })}
                {salesOpen && offerLine ? ` ${offerLine}` : null}
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
                  {t('dashboard.account.viewPlans', 'View plans')}
                </Button>
              )}
            </div>
          )}
          {/*
            Within two projects of the cap, and only while Cloud is on sale:
            someone starting their fourth cloud project is clearly building on
            the cloud, which is when the unlimited plan is worth one sentence.
          */}
          {projectCap !== null && account && salesOpen && projectCap > 2 &&
            account.projectCount >= projectCap - 2 && account.projectCount < projectCap && (
            <div className={styles.setupLimitNote} role="status">
              <Icon name="info" size="sm" />
              <span>
                {t('dashboard.setup.nearLimit', '{used} of {cap} free cloud projects used. Premation Cloud has no limit.', {
                  used: account.projectCount,
                  cap: projectCap,
                })}
                {offerLine ? ` ${offerLine}` : null}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSetupModalOpen(false);
                  openTab('billing');
                }}
              >
                {t('dashboard.account.viewPlans', 'View plans')}
              </Button>
            </div>
          )}

          <div className={styles.modalFooter} data-dialog-actions>
            <span className={styles.setupNote}>{t('dashboard.setup.changeLater', 'You can change these later in composition settings.')}</span>
            <Button variant="secondary" onClick={() => setSetupModalOpen(false)} disabled={creating}>
              {t('dashboard.setup.cancel', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={creating || (setupTab === 'video' && !setupFootage)}
              loading={creating}
            >
              {t('dashboard.setup.create', 'Create')}
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
