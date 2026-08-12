import { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { useProjectLibrary, type OrientationFilter } from '@stores/projectLibraryStore';
import { Icon } from '@components/Icon';
import { Logo } from '@components/Logo';
import { Checkbox } from '@components/Checkbox';
import { Pagination } from '@components/Pagination';
import { Modal, customConfirm } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { useUIStore } from '@stores/uiStore';
import { AiSettingsSection } from '@layout/Settings/AiSettingsSection';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import {
  SIZE_PRESETS, SIZE_GROUPS, FPS_PRESETS, DURATION_PRESETS,
  MIN_DIMENSION, MAX_DIMENSION, MIN_FPS, MAX_FPS, MIN_DURATION, MAX_DURATION,
  clampDimension, clampFps, clampDuration, describeSize, describeDuration, findSizePreset,
} from '@core/composition/presets';
import { useAssetStore, type AssetFolder } from '@stores/assetStore';
import {
  api,
  type AccountRecord,
  type ProjectSummary,
  type RenderJobDto,
  type TrashedProject,
} from '@core/api/client';
import { usePagedList } from '@core/api/usePagedList';
import { clearRecovery } from '@core/persistence/recovery';
import { useCompositionStore, type CompositionSettings } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import type { EditorDocument } from '@core/api/cloudDocument';
import { DashboardPluginsTab } from './DashboardPluginsTab';
import styles from './DashboardPage.module.css';

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

type TabType = 'home' | 'projects' | 'assets' | 'plugins' | 'renders' | 'trash' | 'settings';

type Orientation = 'landscape' | 'portrait' | 'square';

/** Rows per page for the queue and the trash — both are read, not browsed. */
const TABLE_PAGE_SIZE = 20;
/** Cards per page in the asset grid. */
const ASSET_PAGE_SIZE = 24;

/**
 * A project's shape, from its real comp size.
 *
 * This replaces a "Category" badge that was computed as `revision % 3` —
 * meaning a project was a "Social Video" or a "Cinematic Intro" depending on
 * how many times it had been saved. Orientation is the axis that actually
 * distinguishes a reel from a YouTube cut, and it comes from the document.
 */
function orientationOf(p: { width: number; height: number }): Orientation {
  if (p.width === p.height) return 'square';
  return p.width > p.height ? 'landscape' : 'portrait';
}

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

function openUpgradeProModal(): void {
  openModal({
    id: 'upgrade-pro',
    title: (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Icon name="sparkles" size="md" style={{ color: 'var(--color-warning)' }} />
        <span>Upgrade to Motion Studio Pro</span>
      </div>
    ),
    size: 'md',
    render: () => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: '24px', alignItems: 'center' }}>
          <div>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: '1.5', margin: 0 }}>
              Take your motion design workflow to the cloud. Unlock ultimate performance, AI neural assets, and collaborate with your team.
            </p>
          </div>
          <div style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-dialog, 4px)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h4 style={{ margin: 0, fontSize: '0.85rem', fontWeight: '600' }}>Pro Features include:</h4>
            <ul style={{ margin: 0, paddingLeft: '16px', color: 'var(--color-text-secondary)', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <li>8K Cloud Rendering & Exports</li>
              <li>Neural Engine AI Background Removal</li>
              <li>Unlimited Storage for Media & Audio</li>
              <li>Version History for up to 90 days</li>
              <li>Team Collaboration & Shared Libraries</li>
            </ul>
          </div>
        </div>
      </div>
    ),
    footer: (close: () => void) => (
      <>
        <Button variant="ghost" onClick={close}>
          Maybe Later
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            close();
            useUIStore.getState().notify({ level: 'success', message: 'Opening subscription portal...', durationMs: 2600 });
          }}
        >
          Upgrade Now
        </Button>
      </>
    )
  });
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
    return t === 'settings' || t === 'projects' || t === 'assets' || t === 'renders' || t === 'trash'
      ? (t as TabType)
      : 'home';
  });

  // Search & Filter States for Projects. The orientation filter lives in the
  // store because it is part of the server query, not a view of loaded rows.
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<string>>(new Set());

  // Shared AssetStore (synchronized with Editor Assets tab)
  const storeAssets = useAssetStore((s) => s.assets);
  const folders = useAssetStore((s) => s.folders);
  const addAssetsBatch = useAssetStore((s) => s.addAssetsBatch);
  const removeAsset = useAssetStore((s) => s.removeAsset);
  const createFolder = useAssetStore((s) => s.createFolder);
  const renameFolder = useAssetStore((s) => s.renameFolder);
  const removeFolder = useAssetStore((s) => s.removeFolder);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);

  // Assets & renders — both come from the backend. They used to be hardcoded
  // arrays (`intro_backdrop.mp4`, a job frozen at "Rendering 45%") that ignored
  // the real /assets and /render endpoints entirely.
  const [assetTypeFilter, setAssetTypeFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const [assetsBusy, setAssetsBusy] = useState(false);
  const [assetPage, setAssetPage] = useState({ limit: ASSET_PAGE_SIZE, offset: 0 });
  const [dataError, setDataError] = useState('');
  /** Plan + credits, from /auth/me. The UI must not guess these. */
  const [account, setAccount] = useState<AccountRecord | null>(null);

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
    recent: ProjectSummary | null;
  }>({ projects: 0, activeRenders: 0, recent: null });

  const refreshOverview = useCallback(async (): Promise<void> => {
    try {
      const [me, newest, active] = await Promise.all([
        api.me(),
        api.listProjects({ limit: 1 }),
        api.listRenders({ limit: 1, status: 'active' }),
      ]);
      setAccount(me);
      setOverview({
        projects: newest.total,
        activeRenders: active.total,
        recent: newest.items[0] ?? null,
      });
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not load your library.');
    }
  }, []);

  // Workspace Setup Modal State
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [setupTitle, setSetupTitle] = useState('New Video Composition');
  const [setupWidth, setSetupWidth] = useState(1920);
  const [setupHeight, setSetupHeight] = useState(1080);
  const [setupFps, setSetupFps] = useState(30);
  const [setupDuration, setSetupDuration] = useState(10);
  const [setupBg, setSetupBg] = useState('#101014');
  const [setupTransparent, setSetupTransparent] = useState(false);

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

  // A different folder or media type is a different list — start it at page 1
  // rather than on whatever page number the previous one happened to be.
  useEffect(() => {
    setAssetPage((p) => (p.offset === 0 ? p : { ...p, offset: 0 }));
  }, [currentFolderId, assetTypeFilter]);

  const PRESET_TEMPLATES = [
    {
      id: 'reel',
      title: 'Social Reel / Story',
      desc: '1080 × 1920 · 60 fps · 15s',
      icon: 'camera' as const,
      width: 1080,
      height: 1920,
      fps: 60,
      duration: 15,
      badge: '9:16 Portrait',
      color: 'var(--color-primary)',
    },
    {
      id: 'youtube',
      title: 'YouTube 4K Video',
      desc: '3840 × 2160 · 30 fps · 30s',
      icon: 'video' as const,
      width: 3840,
      height: 2160,
      fps: 30,
      duration: 30,
      badge: '16:9 4K',
      color: 'var(--color-primary)',
    },
    {
      id: 'lottie',
      title: 'Vector Lottie',
      desc: '512 × 512 · 60 fps · 5s',
      icon: 'sparkles' as const,
      width: 512,
      height: 512,
      fps: 60,
      duration: 5,
      badge: '1:1 Square',
      color: 'var(--color-success)',
    },
    {
      id: 'mograph',
      title: 'Motion Graphic HD',
      desc: '1920 × 1080 · 60 fps · 10s',
      icon: 'layout' as const,
      width: 1920,
      height: 1080,
      fps: 60,
      duration: 10,
      badge: '16:9 HD',
      color: 'var(--color-warning)',
    },
  ];

  const onQuickCreatePreset = async (title: string, width: number, height: number, fps: number, durationSeconds: number) => {
    setCreating(true);
    try {
      clearRecovery();
      const initialComp: CompositionSettings = {
        id: `comp_${Date.now()}`,
        name: title,
        width,
        height,
        fps,
        durationSeconds,
        background: '#101014',
        transparent: false,
        startFrame: 0,
      };
      useCompositionStore.setState(initialComp);
      getTimelineController().setFrameRate(fps);
      getTimelineController().setDurationSeconds(durationSeconds);
      const initialDoc: EditorDocument = {
        version: '1.0.0',
        scene: sceneProjectIO.createEmpty(title),
        animation: { tracks: {}, expressions: {} },
        comp: initialComp,
      };
      const p = await create(title, initialDoc);
      if (!p?.id) throw new Error('Failed to create project.');
      navigate(`/editor/${p.id}`);
    } catch (err) {
      useUIStore.getState().notify({
        level: 'error',
        message: `Failed to launch preset: ${(err as Error).message}`,
        durationMs: 4000,
      });
    } finally {
      setCreating(false);
    }
  };

  // The newest project in the LIBRARY, not the newest on this page: sorting the
  // loaded rows meant "pick up where you left off" pointed at whatever was on
  // page 3 of a filtered search.
  const mostRecentProject = overview.recent;

  const onCreate = () => {
    setSetupTitle('Untitled composition');
    setSetupWidth(1920);
    setSetupHeight(1080);
    setSetupFps(30);
    setSetupDuration(10);
    setSetupBg('#101014');
    setSetupTransparent(false);
    setSetupModalOpen(true);
  };

  const onLaunchWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      clearRecovery();
      const compName = setupTitle.trim() || 'Untitled composition';
      // Clamp to valid ranges so a half-typed value (onChange fires before the
      // onBlur clamp) can never produce an out-of-range comp the backend rejects.
      const width = clampDimension(setupWidth);
      const height = clampDimension(setupHeight);
      const fps = clampFps(setupFps);
      const durationSeconds = clampDuration(setupDuration);
      const initialComp: CompositionSettings = {
        id: `comp_${Date.now()}`,
        name: compName,
        width,
        height,
        fps,
        durationSeconds,
        background: setupBg,
        transparent: setupTransparent,
        startFrame: 0,
      };
      const initialDoc: EditorDocument = {
        version: '1.0.0',
        scene: sceneProjectIO.createEmpty(compName),
        animation: { tracks: {}, expressions: {} },
        comp: initialComp,
      };
      const p = await create(compName, initialDoc);
      if (!p?.id) throw new Error('The server did not return a project id.');
      useCompositionStore.getState().update(initialComp);
      getTimelineController().setFrameRate(fps);
      getTimelineController().setDurationSeconds(durationSeconds);
      getTimelineController().seekSeconds(0);
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
      useUIStore.getState().notify({ level: 'error', message, durationMs: 5000 });
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
      await addAssetsBatch(items);
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
      const pathToId = new Map<string, string | null>();
      pathToId.set('', currentFolderId);
      const ensureFolder = (segments: string[]): string | null => {
        let parentId = currentFolderId;
        let key = '';
        for (const seg of segments) {
          key = key ? `${key}/${seg}` : seg;
          if (!pathToId.has(key)) {
            const created = createFolder(seg, parentId);
            pathToId.set(key, created.id);
          }
          parentId = pathToId.get(key) ?? null;
        }
        return parentId;
      };
      const items: Array<{ file: File; folderId: string | null }> = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file) continue;
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const parts = rel.split('/');
        const folderSegments = parts.slice(0, -1);
        const targetFolder = ensureFolder(folderSegments);
        items.push({ file, folderId: targetFolder });
      }
      if (items.length > 0) {
        await addAssetsBatch(items);
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Folder import failed.');
    } finally {
      setAssetsBusy(false);
    }
  };

  const handleNewFolder = () => {
    const siblings = folders.filter((f) => f.parentId === currentFolderId);
    const base = 'New Folder';
    let name = base;
    let n = 2;
    while (siblings.some((f) => f.name === name)) name = `${base} ${n++}`;
    const created = createFolder(name, currentFolderId);
    setRenamingFolderId(created.id);
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
    if (ok) removeFolder(folder.id);
  };

  const handleDeleteAsset = async (id: string, name: string): Promise<void> => {
    if (!await customConfirm('Delete Asset', `Delete “${name}”? This cannot be undone.`, { isDanger: true, confirmLabel: 'Delete' })) return;
    try {
      removeAsset(id);
      await api.deleteAsset(id).catch(() => undefined);
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

  const subfoldersInView = folders.filter((f) => f.parentId === currentFolderId);
  const visibleAssetsInView = storeAssets.filter((a) => {
    const matchesType = assetTypeFilter === 'all' || a.type === assetTypeFilter;
    const inFolder = (a.folderId ?? null) === currentFolderId;
    return matchesType && inFolder;
  });

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
      case 'plugins':
        return <DashboardPluginsTab />;
      case 'home':
        return (
          <>
            {/* Continue Editing Hero Banner */}
            {mostRecentProject && (
              <div className={styles.heroBanner}>
                <div className={styles.heroBadge}>
                  <Icon name="sparkles" size="sm" />
                  <span>Pick up where you left off</span>
                </div>
                <h2 className={styles.heroTitle}>{mostRecentProject.name}</h2>
                <p className={styles.heroSubtitle}>
                  Edited {timeAgo(mostRecentProject.updatedAt)} · {describeSize(mostRecentProject.width, mostRecentProject.height)} · {mostRecentProject.fps} fps · {mostRecentProject.layerCount} {mostRecentProject.layerCount === 1 ? 'layer' : 'layers'}
                </p>
                <div className={styles.heroActions}>
                  <button
                    type="button"
                    className={styles.heroBtnPrimary}
                    onClick={() => navigate(`/editor/${mostRecentProject.id}`)}
                  >
                    <Icon name="play" size="md" />
                    <span>Resume Editing</span>
                  </button>
                </div>
              </div>
            )}

            {/* Quick Start Presets Launchpad */}
            <div className={styles.launchpadSection}>
              <div className={styles.sectionHeaderRow}>
                <h2 className={styles.sectionTitle}>
                  Quick Start Launchpad
                  <span className={styles.sectionHint}>1-click composition setup</span>
                </h2>
              </div>
              <div className={styles.launchpadGrid}>
                {PRESET_TEMPLATES.map((tmpl) => (
                  <div
                    key={tmpl.id}
                    className={styles.launchpadCard}
                    onClick={() => void onQuickCreatePreset(tmpl.title, tmpl.width, tmpl.height, tmpl.fps, tmpl.duration)}
                  >
                    <div className={styles.launchpadHeader}>
                      <div className={styles.launchpadIcon} style={{ background: `color-mix(in srgb, ${tmpl.color} 15%, transparent)`, color: tmpl.color }}>
                        <Icon name={tmpl.icon} size="md" />
                      </div>
                      <span className={styles.launchpadBadge}>{tmpl.badge}</span>
                    </div>
                    <div className={styles.launchpadTitle}>{tmpl.title}</div>
                    <div className={styles.launchpadDesc}>{tmpl.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Stats Summary Cards Row */}
            <div className={styles.statsGrid}>
              <div className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: 'rgba(41, 136, 255, 0.1)', color: 'var(--color-primary)' }}>
                  <Icon name="folder" size="md" />
                </div>
                <div className={styles.statMeta}>
                  <div className={styles.statValue}>{overview.projects.toLocaleString()}</div>
                  <div className={styles.statLabel}>Total Projects</div>
                </div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: 'rgba(245, 184, 75, 0.1)', color: 'var(--color-warning)' }}>
                  <Icon name="video" size="md" />
                </div>
                <div className={styles.statMeta}>
                  <div className={styles.statValue}>{overview.activeRenders.toLocaleString()}</div>
                  <div className={styles.statLabel}>Active Renders</div>
                </div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--color-success)' }}>
                  <Icon name="image" size="md" />
                </div>
                <div className={styles.statMeta}>
                  <div className={styles.statValue}>{formatBytes(account?.storageBytes ?? 0)}</div>
                  <div className={styles.statLabel}>Storage Used</div>
                </div>
              </div>
            </div>

            {/* Quick list of projects */}
            <div className={styles.sectionHeaderRow}>
              <h2 className={styles.sectionTitle}>Recent Compositions</h2>
            </div>
            {renderProjectsTable()}
          </>
        );

      case 'projects':
        return renderProjectsTable();

      case 'assets':
        return (
          <div className={styles.assetsContainer}>
            <div className={styles.assetsHeader}>
              <div className={styles.assetTabs}>
                <button
                  type="button"
                  className={`${styles.assetTab} ${assetTypeFilter === 'all' ? styles.assetTabActive : ''}`}
                  onClick={() => setAssetTypeFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`${styles.assetTab} ${assetTypeFilter === 'video' ? styles.assetTabActive : ''}`}
                  onClick={() => setAssetTypeFilter('video')}
                >
                  Videos
                </button>
                <button
                  type="button"
                  className={`${styles.assetTab} ${assetTypeFilter === 'image' ? styles.assetTabActive : ''}`}
                  onClick={() => setAssetTypeFilter('image')}
                >
                  Images
                </button>
                <button
                  type="button"
                  className={`${styles.assetTab} ${assetTypeFilter === 'audio' ? styles.assetTabActive : ''}`}
                  onClick={() => setAssetTypeFilter('audio')}
                >
                  Audio
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={handleNewFolder}
                  title="Create new folder"
                >
                  <Icon name="folder-plus" size="md" />
                  <span>New Folder</span>
                </button>

                <label className={styles.btnSecondary} style={{ cursor: assetsBusy ? 'default' : 'pointer' }}>
                  <Icon name="folder-open" size="md" />
                  <span>Import Folder</span>
                  <input
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    disabled={assetsBusy}
                    onChange={(e) => {
                      void handleImportFolder(e.currentTarget.files);
                      e.currentTarget.value = '';
                    }}
                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  />
                </label>

                <label className={styles.btnPrimary} style={{ cursor: assetsBusy ? 'default' : 'pointer' }}>
                  <Icon name="plus" size="md" />
                  <span>{assetsBusy ? 'Uploading…' : 'Import Asset'}</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*,audio/*"
                    style={{ display: 'none' }}
                    disabled={assetsBusy}
                    onChange={(e) => {
                      void handleImportAssetFiles(e.currentTarget.files);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
              </div>
            </div>

            {/* Breadcrumb Navigation */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--color-text-secondary)', padding: '4px 0' }}>
              <button
                type="button"
                className={currentFolderId === null ? styles.assetTabActive : styles.assetTab}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: currentFolderId === null ? '#fff' : 'var(--color-text-secondary)' }}
                onClick={() => setCurrentFolderId(null)}
              >
                All Assets
              </button>
              {currentBreadcrumb.map((f, i) => (
                <span key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span>/</span>
                  <button
                    type="button"
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: i === currentBreadcrumb.length - 1 ? '#fff' : 'var(--color-text-secondary)', fontWeight: i === currentBreadcrumb.length - 1 ? 600 : 400 }}
                    onClick={() => setCurrentFolderId(f.id)}
                  >
                    {f.name}
                  </button>
                </span>
              ))}
            </div>

            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}

            {subfoldersInView.length === 0 && visibleAssetsInView.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="folder" size="lg" />
                <p>{currentFolderId === null ? 'No assets yet. Import files, upload a folder, or create a new folder.' : 'This folder is empty. Import assets or create subfolders here.'}</p>
              </div>
            ) : (
              <>
              <div className={styles.assetsGrid}>
                {/* Render folders first */}
                {pagedFolders.map((folder) => {
                  const count = storeAssets.filter((a) => a.folderId === folder.id).length
                    + folders.filter((f) => f.parentId === folder.id).length;
                  return (
                    <div
                      key={folder.id}
                      className={styles.assetCard}
                      style={{ cursor: 'pointer' }}
                      onClick={() => { if (renamingFolderId !== folder.id) setCurrentFolderId(folder.id); }}
                    >
                      <div className={styles.assetPreview} style={{ color: 'var(--color-primary)' }}>
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
                            onBlur={(e) => { renameFolder(folder.id, e.target.value); setRenamingFolderId(null); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { renameFolder(folder.id, (e.target as HTMLInputElement).value); setRenamingFolderId(null); }
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
                {pagedAssets.map((asset) => (
                  <div key={asset.id} className={styles.assetCard}>
                    <div className={styles.assetPreview}>
                      {asset.type === 'image' ? (
                        <img src={asset.src} alt="" className={styles.assetPreviewImg} />
                      ) : (
                        <Icon
                          name={asset.type === 'video' ? 'video' : 'audio'}
                          size="lg"
                          className={styles.assetPreviewIcon}
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
                ))}
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
                  onClick={() => setActiveTab('projects')}
                  style={{ marginTop: '8px' }}
                >
                  <Icon name="folder" size="md" />
                  <span>Go to Projects</span>
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
                          <div className={styles.progressCellWrapper}>
                            <div className={styles.progressBar}>
                              <div className={styles.progressFill} style={{ width: `${Math.round(job.progress * 100)}%` }} />
                            </div>
                            <span className={styles.progressText}>{Math.round(job.progress * 100)}%</span>
                          </div>
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
                            title={job.error ?? undefined}
                          >
                            {job.status === 'running' && <span className={styles.pulseDot} />}
                            {job.status.toUpperCase()}
                          </span>
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
                <Icon name="trash" size="lg" />
                <p>The trash is empty. Deleted projects rest here for 30 days before they're gone for good.</p>
              </div>
            ) : (
              <>
                {selectedTrashIds.size > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 16px', background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border-strong)' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
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
                              <div className={styles.projectThumb}>
                                {p.thumbnailUrl
                                  ? <img src={p.thumbnailUrl} alt="" className={styles.thumbImg} />
                                  : <Icon name="video" size="md" className={styles.thumbIcon} />}
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

      case 'settings':
        return (
          <div className={styles.settingsPanel}>
            {/* Account & Workspace Profile Card */}
            <div className={styles.settingsCard}>
              <div className={styles.profileHeaderRow}>
                <div className={styles.profileAvatarLarge}>
                  <Icon name="user" size="lg" />
                </div>
                <div className={styles.profileMetaInfo}>
                  <div className={styles.profileDisplayName}>
                    {user?.name || user?.email?.split('@')[0] || 'Account'}
                  </div>
                  <div className={styles.profileEmailText}>{user?.email}</div>
                  <div className={styles.profileNodeBadge}>
                    {account ? `${account.plan === 'pro' ? 'Pro' : 'Free'} plan · member since ${new Date(account.createdAt).toLocaleDateString()}` : '—'}
                  </div>
                </div>
              </div>

              <div className={styles.storageBarSection}>
                <div className={styles.storageBarHeader}>
                  <span>Cloud Workspace Storage</span>
                  <span className={styles.monoValue}>
                    {formatBytes(account?.storageBytes ?? 0)} across {account?.assetCount ?? 0} {account?.assetCount === 1 ? 'asset' : 'assets'}
                  </span>
                </div>
              </div>
            </div>

            {/* Assistant — how the AI is powered */}
            <div className={styles.settingsCard} id="ai-settings">
              <h3 className={styles.settingsLabel}>Assistant</h3>
              <AiSettingsSection />
            </div>

            {/*
              Editor preferences live in ONE place: the Customize dialog.

              This card used to restate four of them — confirm-on-close,
              auto-keyframe, reduce-motion and sidebar density — while the same
              four also sat in Customize → Appearance. Two controls for one
              value is two chances to disagree about which is authoritative, and
              the reason to reach for any of them is "I am editing and want this
              different", which is exactly when the dashboard is not on screen.

              So this is a pointer now, not a second copy.
            */}
            <div className={styles.settingsCard}>
              <h3 className={styles.settingsLabel}>Editor Preferences</h3>
              <p className={styles.optionDesc} style={{ marginBottom: 'var(--space-4)' }}>
                Appearance, interface scale, panel layout, editing behaviour and keyboard
                shortcuts are all set from Customize — available here and from anywhere in
                the editor.
              </p>
              <div className={styles.settingsRow}>
                <Button
                  variant="secondary"
                  onClick={() => openCustomizeDialog()}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Icon name="settings" size="md" style={{ marginRight: 8 }} />
                  Open Customize…
                </Button>
              </div>
            </div>

          </div>
        );
    }
  };

  const renderProjectsTable = () => {
    return (
      <div className={styles.tableCard}>
        {status === 'loading' && (
          <div className={styles.loadingState}>
            <p>Loading projects...</p>
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

        {status === 'ready' && projects.length === 0 && (
          <div className={styles.emptyState}>
            <Icon name="folder" size={48} className={styles.emptyStateIcon} />
            <h3>No projects found</h3>
            <p>Start by creating a new video project or adjusting your filters.</p>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={onCreate}
              disabled={creating}
            >
              <Icon name="plus" size="md" />
              <span>Create a project</span>
            </button>
          </div>
        )}

        {status === 'ready' && projects.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>
                  <Checkbox
                    checked={selectedIds.size === projects.length && projects.length > 0}
                    indeterminate={selectedIds.size > 0 && selectedIds.size < projects.length}
                    onChange={toggleSelectAll}
                    title="Select every project on this page"
                  />
                </th>
                <th>Project</th>
                <th>Format</th>
                <th>Resolution</th>
                <th>Length</th>
                <th style={{ width: '60px', textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const isSelected = selectedIds.has(p.id);
                const orientation = orientationOf(p);
                const thumb = p.thumbnailUrl;

                return (
                  <tr key={p.id} className={isSelected ? styles.rowSelected : ''}>
                    <td style={{ textAlign: 'center' }}>
                      <Checkbox
                        checked={isSelected}
                        onChange={() => toggleSelectOne(p.id)}
                      />
                    </td>
                    <td>
                      <div className={styles.projectCell}>
                        <div
                          className={styles.projectThumb}
                          onClick={() => navigate(`/editor/${p.id}`)}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" className={styles.thumbImg} />
                          ) : (
                            <Icon name="video" size="md" className={styles.thumbIcon} />
                          )}
                        </div>
                        <div>
                          <div
                            className={styles.projectName}
                            onClick={() => navigate(`/editor/${p.id}`)}
                          >
                            {p.name}
                          </div>
                          <div className={styles.projectTime}>
                            Edited {timeAgo(p.updatedAt)} · {p.layerCount} {p.layerCount === 1 ? 'layer' : 'layers'} · rev {p.revision}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={styles.categoryBadge}>{ORIENTATION_LABEL[orientation]}</span>
                    </td>
                    <td className={styles.monoCell}>{describeSize(p.width, p.height)}</td>
                    <td className={styles.monoCell}>
                      {describeDuration(p.durationSeconds)} · {p.fps} fps
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => onDelete(p.id, p.name)}
                        title="Delete project"
                      >
                        <Icon name="trash" size="md" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {status === 'ready' && (
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
          title: 'Home overview',
          desc: 'Your project health center. View stats and edit recent compositions.',
        };
      case 'projects':
        return {
          title: 'Projects & drafts',
          desc: 'Your full editing library. Open, search, and manage project revisions.',
        };
      case 'trash':
        return {
          title: 'Trash',
          desc: 'Deleted projects, recoverable for 30 days. After that they are removed for good.',
        };
      case 'assets':
        return {
          title: 'Assets library',
          desc: 'Upload and organize media, audio backdrops, and overlays for your timelines.',
        };
      case 'plugins':
        return {
          title: 'Plugins',
          desc: 'Find, install and manage plugins. They run sandboxed, and can only reach websites you approve by name.',
        };
      case 'renders':
        return {
          title: 'Render queue',
          desc: 'Monitor export rendering progress, completed videos, and queued exports.',
        };
      case 'settings':
        return {
          title: 'Dashboard settings',
          desc: 'Configure application preferences, auto-save settings, and project defaults.',
        };
    }
  }, [activeTab]);

  return (
    <div className={styles.root}>
      {/* 1. Left Sidebar Navigation */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}>
          <Logo variant="lockup" size={26} />
        </div>
        <nav className={styles.sidebarNav}>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'home' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('home')}
          >
            <Icon name="home" size="md" className={styles.navIcon} />
            <span>Home</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'projects' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <Icon name="folder" size="md" className={styles.navIcon} />
            <span>Projects & Drafts</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'assets' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('assets')}
          >
            <Icon name="image" size="md" className={styles.navIcon} />
            <span>Assets Library</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'plugins' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('plugins')}
          >
            <Icon name="plugin" size="md" className={styles.navIcon} />
            <span>Plugins</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'renders' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('renders')}
          >
            <Icon name="queue" size="md" className={styles.navIcon} />
            <span>Render Queue</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'trash' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('trash')}
          >
            <Icon name="trash" size="md" className={styles.navIcon} />
            <span>Trash</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'settings' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Icon name="settings" size="md" className={styles.navIcon} />
            <span>Settings</span>
          </button>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.upgradeCardBox}>
            <div className={styles.upgradeCardHeader}>
              <div className={styles.upgradeCardBadge}>
                <Icon name="sparkles" size="sm" />
              </div>
              <span className={styles.upgradeCardTitle}>Upgrade to Pro</span>
            </div>
            <p className={styles.upgradeCardDesc}>
              Unlock 8K cloud rendering, AI neural tools & unlimited storage.
            </p>
            <button
              type="button"
              className={styles.upgradeCardActionBtn}
              onClick={openUpgradeProModal}
            >
              <span>Upgrade Now</span>
            </button>
          </div>

          <button
            type="button"
            className={styles.logoutSidebarBtn}
            onClick={logout}
            title="Sign out of account"
          >
            <Icon name="lock" size="md" className={styles.logoutIcon} />
            <span>Log out</span>
          </button>
        </div>
      </aside>

      {/* 2. Main Area */}
      <div className={styles.container}>

        {/* Main Content Workspace */}
        <main className={styles.mainContent}>
          <div className={`${styles.pageTitleRow} ${activeTab === 'settings' ? styles.settingsTitleRow : ''}`}>
            <div>
              <h1 className={styles.pageTitle}>{headerDetails.title}</h1>
              <p className={styles.pageSubtitle}>{headerDetails.desc}</p>
            </div>
          </div>

          {/* Action & Filter Bar (Only visible on home / projects view) */}
          {(activeTab === 'home' || activeTab === 'projects') && (
            <div className={styles.actionBar}>
              <div className={styles.filterGroup}>
                <div className={styles.searchWrapper}>
                  <Icon name="search" size="md" className={styles.inputSearchIcon} />
                  <input
                    type="text"
                    placeholder="Search projects..."
                    className={styles.projectSearchInput}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                {/* Filters on a real, stored fact, server-side — see the note
                    on `filteredProjects`' removal. The Category and Status
                    dropdowns that used to sit here filtered on values invented
                    from the revision counter. */}
                <select
                  value={orientation}
                  onChange={(e) => {
                    setSelectedIds(new Set());
                    void load({ orientation: e.target.value as OrientationFilter });
                  }}
                  className={styles.filterDropdown}
                >
                  <option value="all">Format: All</option>
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                  <option value="square">Square</option>
                </select>
              </div>

              <div className={styles.actionButtons}>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    className={styles.btnDanger}
                    onClick={async () => {
                      if (await customConfirm('Move to Trash', `Move ${selectedIds.size} projects to the trash? You can restore them for 30 days.`, { confirmLabel: 'Move to Trash' })) {
                        // One refetch for the batch — `remove` per id would
                        // reload the page between every deletion.
                        await removeMany(selectedIds);
                        setSelectedIds(new Set());
                        void refreshOverview();
                      }
                    }}
                  >
                    <Icon name="trash" size="md" />
                    <span>Move to trash ({selectedIds.size})</span>
                  </button>
                )}

                <button type="button" className={styles.btnSecondary} disabled>
                  <span>Actions</span>
                  <Icon name="chevron-down" size="sm" />
                </button>

                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={onCreate}
                  disabled={creating}
                >
                  <Icon name="plus" size="md" />
                  <span>{creating ? 'Creating…' : 'Create project'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Renders Tab Content */}
          {renderTabContent()}
        </main>
      </div>

      {/* Workspace Setup Popup Modal */}
      <Modal
        open={setupModalOpen}
        onClose={() => !creating && setSetupModalOpen(false)}
        title="Workspace Setup"
        description="Customize composition dimensions, frame rate & canvas settings before opening editor"
        size="md"
        persistent={creating}
      >
        <form className={styles.modalForm} onSubmit={onLaunchWorkspace}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Project / Composition Name</label>
            <input
              type="text"
              className={styles.formInput}
              value={setupTitle}
              onChange={(e) => setSetupTitle(e.target.value)}
              placeholder="e.g. Cinematic Promo Video"
              required
            />
          </div>

          {/* Presets grouped by destination — people pick "Instagram Reel",
              not "1080×1920". Every value stays editable below. */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Preset</label>
            {SIZE_GROUPS.map((group) => (
              <div key={group} style={{ marginBottom: 8 }}>
                <div className={styles.presetGroupLabel}>{group}</div>
                <div className={styles.presetPills}>
                  {SIZE_PRESETS.filter((p) => p.group === group).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      title={`${p.width}×${p.height}${p.note ? ` — ${p.note}` : ''}`}
                      className={`${styles.presetPill} ${setupWidth === p.width && setupHeight === p.height ? styles.presetPillActive : ''}`}
                      onClick={() => { setSetupWidth(p.width); setSetupHeight(p.height); }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Width (px)</label>
              <input
                type="number"
                className={styles.formInput}
                value={setupWidth}
                onChange={(e) => setSetupWidth(Number(e.target.value))}
                onBlur={(e) => setSetupWidth(clampDimension(Number(e.target.value)))}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                required
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Height (px)</label>
              <input
                type="number"
                className={styles.formInput}
                value={setupHeight}
                onChange={(e) => setSetupHeight(Number(e.target.value))}
                onBlur={(e) => setSetupHeight(clampDimension(Number(e.target.value)))}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                required
              />
            </div>
          </div>
          <div className={styles.fieldNote}>
            {describeSize(setupWidth, setupHeight)}
            {findSizePreset(setupWidth, setupHeight)?.note ? ` · ${findSizePreset(setupWidth, setupHeight)!.note}` : ' · custom size'}
          </div>

          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Frame Rate (fps)</label>
              <input
                type="number"
                className={styles.formInput}
                list="fps-presets"
                value={setupFps}
                step="0.001"
                min={MIN_FPS}
                max={MAX_FPS}
                onChange={(e) => setSetupFps(Number(e.target.value))}
                onBlur={(e) => setSetupFps(clampFps(Number(e.target.value)))}
                required
              />
              <datalist id="fps-presets">
                {FPS_PRESETS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </datalist>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Duration (seconds)</label>
              <input
                type="number"
                className={styles.formInput}
                value={setupDuration}
                step="0.1"
                min={MIN_DURATION}
                max={MAX_DURATION}
                onChange={(e) => setSetupDuration(Number(e.target.value))}
                onBlur={(e) => setSetupDuration(clampDuration(Number(e.target.value)))}
                required
              />
            </div>
          </div>
          <div className={styles.presetPills} style={{ marginTop: -4 }}>
            {DURATION_PRESETS.map((d) => (
              <button
                key={d.seconds}
                type="button"
                className={`${styles.presetPill} ${setupDuration === d.seconds ? styles.presetPillActive : ''}`}
                onClick={() => setSetupDuration(d.seconds)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className={styles.fieldNote}>
            Timeline length: {describeDuration(setupDuration)} · {Math.round(setupDuration * setupFps)} frames
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Background Color</label>
            <div className={styles.colorRow}>
              <button
                type="button"
                className={`${styles.colorSwatchBtn} ${!setupTransparent && setupBg === '#101014' ? styles.colorSwatchBtnActive : ''}`}
                style={{ background: '#101014' }}
                title="Dark Slate (Default)"
                onClick={() => { setSetupBg('#101014'); setSetupTransparent(false); }}
              />
              <button
                type="button"
                className={`${styles.colorSwatchBtn} ${!setupTransparent && setupBg === '#000000' ? styles.colorSwatchBtnActive : ''}`}
                style={{ background: '#000000' }}
                title="Pure Black"
                onClick={() => { setSetupBg('#000000'); setSetupTransparent(false); }}
              />
              <button
                type="button"
                className={`${styles.colorSwatchBtn} ${!setupTransparent && setupBg === '#ffffff' ? styles.colorSwatchBtnActive : ''}`}
                style={{ background: '#ffffff' }}
                title="Pure White"
                onClick={() => { setSetupBg('#ffffff'); setSetupTransparent(false); }}
              />
              <button
                type="button"
                className={`${styles.colorSwatchBtn} ${!setupTransparent && setupBg === '#00ff00' ? styles.colorSwatchBtnActive : ''}`}
                style={{ background: '#00ff00' }}
                title="Chroma Green screen"
                onClick={() => { setSetupBg('#00ff00'); setSetupTransparent(false); }}
              />
              <input
                type="color"
                value={setupBg}
                onChange={(e) => { setSetupBg(e.target.value); setSetupTransparent(false); }}
                style={{ width: 36, height: 26, border: 'none', background: 'transparent', cursor: 'pointer' }}
                title="Custom Hex Picker"
              />
              <input
                type="text"
                className={styles.colorHexInput}
                value={setupBg}
                onChange={(e) => { setSetupBg(e.target.value); setSetupTransparent(false); }}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--color-text-secondary)', cursor: 'pointer', marginLeft: 'auto' }}>
                <Checkbox
                  checked={setupTransparent}
                  onChange={(e) => setSetupTransparent(e.target.checked)}
                />
                Transparent Canvas
              </label>
            </div>
          </div>
          <div className={styles.modalFooter}>
            <Button
              variant="secondary"
              onClick={() => setSetupModalOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={creating}
              loading={creating}
              leftIcon={<Icon name="check" size="md" />}
            >
              Create & Launch Editor
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default DashboardPage;
