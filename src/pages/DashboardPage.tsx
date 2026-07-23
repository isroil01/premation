import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useProjectLibrary } from '@stores/projectLibraryStore';
import { Icon } from '@components/Icon';
import { Checkbox } from '@components/Checkbox';
import { Modal, customConfirm } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { useUIStore } from '@stores/uiStore';
import { AiSettingsSection } from '@layout/Settings/AiSettingsSection';
import { BillingSection } from '@layout/Settings/BillingSection';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import {
  SIZE_PRESETS, SIZE_GROUPS, FPS_PRESETS, DURATION_PRESETS,
  MIN_DIMENSION, MAX_DIMENSION, MIN_FPS, MAX_FPS, MIN_DURATION, MAX_DURATION,
  clampDimension, clampFps, clampDuration, describeSize, describeDuration, findSizePreset,
} from '@core/composition/presets';
import { useAssetStore, type AssetFolder } from '@stores/assetStore';
import { api, type AccountRecord, type RenderJobDto, type TrashedProject } from '@core/api/client';
import { clearRecovery } from '@core/persistence/recovery';
import { useCompositionStore, type CompositionSettings } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import type { EditorDocument } from '@core/api/cloudDocument';
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

type TabType = 'home' | 'projects' | 'assets' | 'renders' | 'trash' | 'settings';

type Orientation = 'landscape' | 'portrait' | 'square';

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
        <Icon name="sparkles" size={18} style={{ color: 'var(--color-warning)' }} />
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
          style={{ background: 'linear-gradient(135deg, var(--color-blue-600) 0%, var(--color-violet-500) 100%)', border: 'none' }}
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
  const { projects, total, status, error, load, loadMore, create, remove } = useProjectLibrary();
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

  // Search & Filter States for Projects
  const [searchQuery, setSearchQuery] = useState('');
  const [orientationFilter, setOrientationFilter] = useState<'all' | Orientation>('all');
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
  const [rendersList, setRendersList] = useState<RenderJobDto[]>([]);
  const [trash, setTrash] = useState<TrashedProject[]>([]);
  const [dataError, setDataError] = useState('');
  /** Plan + credits, from /auth/me. The UI must not guess these. */
  const [account, setAccount] = useState<AccountRecord | null>(null);

  // Workspace Setup Modal State
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [setupTitle, setSetupTitle] = useState('New Video Composition');
  const [setupWidth, setSetupWidth] = useState(1920);
  const [setupHeight, setSetupHeight] = useState(1080);
  const [setupFps, setSetupFps] = useState(30);
  const [setupDuration, setSetupDuration] = useState(10);
  const [setupBg, setSetupBg] = useState('#101014');
  const [setupTransparent, setSetupTransparent] = useState(false);

  // Real, persisted editor preferences — shared with the editor's own
  // Customize dialog, so the two can never disagree.
  const prefs = usePreferenceStore();
  const setPref = usePreferenceStore((s) => s.set);

  // Search is server-side (the list is paged, so filtering here would only
  // filter the loaded page). Debounced so typing doesn't fire a query a
  // keystroke.
  useEffect(() => {
    const t = setTimeout(() => { void load(searchQuery); }, 250);
    return () => clearTimeout(t);
  }, [load, searchQuery]);

  // Assets and renders are fetched once for the whole dashboard: the Home tab
  // counts them and the Assets/Renders tabs list them.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [renders, me] = await Promise.all([
          api.listRenders({ limit: 50 }),
          api.me(),
        ]);
        if (!live) return;
        setRendersList(renders.items);
        setAccount(me);
      } catch (err) {
        if (!live) return;
        setDataError(err instanceof Error ? err.message : 'Could not load your library.');
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (activeTab === 'trash') void loadTrash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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
      color: '#8b5cf6',
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
      color: '#3170e6',
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
      color: '#10b981',
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
      color: '#f5b84b',
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

  const mostRecentProject = useMemo(() => {
    if (projects.length === 0) return null;
    return [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  }, [projects]);

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
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredProjects.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProjects.map((p) => p.id)));
    }
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

  // Filter projects dynamically
  /**
   * Filter on facts the server actually stores.
   *
   * The previous version derived a "category" and a "status" from
   * `revision % 3` / `revision % 5` — so a project's category changed every
   * time you saved it, and the dropdowns filtered on pure noise. Orientation
   * is a real, useful axis because it comes from the comp itself.
   */
  const filteredProjects = useMemo(() => {
    if (orientationFilter === 'all') return projects;
    return projects.filter((p) => orientationOf(p) === orientationFilter);
  }, [projects, orientationFilter]);

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

  /** Trash contents. Loaded on demand — most visits never open the tab. */
  const loadTrash = async (): Promise<void> => {
    try {
      setTrash((await api.listTrash({ limit: 50 })).items);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not load the trash.');
    }
  };

  const handleRestore = async (id: string): Promise<void> => {
    try {
      await api.restoreProject(id);
      setTrash((t) => t.filter((p) => p.id !== id));
      void load(searchQuery);
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
      setTrash((t) => t.filter((p) => p.id !== id));
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not delete that project.');
    }
  };

  const handleCancelRender = async (id: string): Promise<void> => {
    try {
      const updated = await api.cancelRender(id);
      setRendersList((prev) => prev.map((j) => (j.id === id ? updated : j)));
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

  const activeRenders = useMemo(
    () => rendersList.filter((r) => r.status === 'queued' || r.status === 'running').length,
    [rendersList],
  );

  // Render Page Content based on selected sidebar Tab
  const renderTabContent = () => {
    switch (activeTab) {
      case 'home':
        return (
          <>
            {/* Continue Editing Hero Banner */}
            {mostRecentProject && (
              <div className={styles.heroBanner}>
                <div className={styles.heroBadge}>
                  <Icon name="sparkles" size={13} />
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
                    <Icon name="play" size={15} />
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
                        <Icon name={tmpl.icon} size={18} />
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
                  <Icon name="folder" size={16} />
                </div>
                <div className={styles.statMeta}>
                  <div className={styles.statValue}>{projects.length}</div>
                  <div className={styles.statLabel}>Total Projects</div>
                </div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: 'rgba(245, 184, 75, 0.1)', color: 'var(--color-warning)' }}>
                  <Icon name="video" size={16} />
                </div>
                <div className={styles.statMeta}>
                  <div className={styles.statValue}>{activeRenders}</div>
                  <div className={styles.statLabel}>Active Renders</div>
                </div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--color-success)' }}>
                  <Icon name="image" size={16} />
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
                  <Icon name="folder-plus" size={14} />
                  <span>New Folder</span>
                </button>

                <label className={styles.btnSecondary} style={{ cursor: assetsBusy ? 'default' : 'pointer' }}>
                  <Icon name="folder-open" size={14} />
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
                  <Icon name="plus" size={14} />
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
                <Icon name="folder" size={32} />
                <p>{currentFolderId === null ? 'No assets yet. Import files, upload a folder, or create a new folder.' : 'This folder is empty. Import assets or create subfolders here.'}</p>
              </div>
            ) : (
              <div className={styles.assetsGrid}>
                {/* Render folders first */}
                {subfoldersInView.map((folder) => {
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
                        <Icon name="folder" size={20} />
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
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  );
                })}

                {/* Render assets */}
                {visibleAssetsInView.map((asset) => (
                  <div key={asset.id} className={styles.assetCard}>
                    <div className={styles.assetPreview}>
                      {asset.type === 'image' ? (
                        <img src={asset.src} alt="" className={styles.assetPreviewImg} />
                      ) : (
                        <Icon
                          name={asset.type === 'video' ? 'video' : 'audio'}
                          size={24}
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
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'renders':
        return (
          <div className={styles.tableCard}>
            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}
            {rendersList.length === 0 ? (
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
                  <Icon name="folder" size={14} />
                  <span>Go to Projects</span>
                </button>
              </div>
            ) : (
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
                  {rendersList.map((job) => {
                    const project = projects.find((p) => p.id === job.projectId);
                    return (
                      <tr key={job.id}>
                        <td>
                          <div className={styles.jobCell}>
                            <Icon name="video" size={16} style={{ color: 'var(--color-primary)' }} />
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
                              <Icon name="download" size={14} />
                            </a>
                          ) : job.status === 'queued' || job.status === 'running' ? (
                            <button
                              type="button"
                              className={styles.actionBtn}
                              title="Cancel render"
                              onClick={() => void handleCancelRender(job.id)}
                            >
                              <Icon name="close" size={14} />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );

      case 'trash':
        return (
          <div className={styles.tableCard}>
            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}
            {trash.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="trash" size={28} />
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
                      <Icon name="undo" size={13} />
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
                        for (const id of selectedTrashIds) {
                          try {
                            await api.destroyProject(id);
                          } catch { /* ignore individual fail */ }
                        }
                        setTrash((t) => t.filter((p) => !selectedTrashIds.has(p.id)));
                        setSelectedTrashIds(new Set());
                      }}
                    >
                      <Icon name="trash" size={13} />
                      <span>Delete permanently ({selectedTrashIds.size})</span>
                    </button>
                  </div>
                )}
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}>
                        <Checkbox
                          checked={selectedTrashIds.size === trash.length && trash.length > 0}
                          indeterminate={selectedTrashIds.size > 0 && selectedTrashIds.size < trash.length}
                          onChange={() => {
                            if (selectedTrashIds.size === trash.length) {
                              setSelectedTrashIds(new Set());
                            } else {
                              setSelectedTrashIds(new Set(trash.map((p) => p.id)));
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
                    {trash.map((p) => {
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
                                  : <Icon name="video" size={18} className={styles.thumbIcon} />}
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
                                <Icon name="undo" size={13} />
                                <span>Restore</span>
                              </button>
                              <button
                                type="button"
                                className={styles.actionBtn}
                                title="Delete permanently"
                                onClick={() => void handleDestroy(p.id, p.name)}
                              >
                                <Icon name="trash" size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
                  <Icon name="user" size={24} />
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

            {/* Plan & credits */}
            <div className={styles.settingsCard} id="billing">
              <h3 className={styles.settingsLabel}>Plan & Credits</h3>
              <BillingSection />
            </div>

            {/* Editor preferences */}
            <div className={styles.settingsCard}>
              <h3 className={styles.settingsLabel}>Editor Preferences</h3>

              <div className={styles.settingsRow}>
                <label className={styles.settingsOption}>
                  <input
                    type="checkbox"
                    checked={prefs.confirmOnClose}
                    onChange={(e) => setPref('confirmOnClose', e.target.checked)}
                    className={styles.checkbox}
                  />
                  <div>
                    <div className={styles.optionTitle}>Confirm before discarding changes</div>
                    <div className={styles.optionDesc}>Ask for confirmation when a New/Open/Close would throw away unsaved work.</div>
                  </div>
                </label>
              </div>

              <div className={styles.settingsRow}>
                <label className={styles.settingsOption}>
                  <input
                    type="checkbox"
                    checked={prefs.timelineAutoKeyframe}
                    onChange={(e) => setPref('timelineAutoKeyframe', e.target.checked)}
                    className={styles.checkbox}
                  />
                  <div>
                    <div className={styles.optionTitle}>Auto-keyframe</div>
                    <div className={styles.optionDesc}>Record a keyframe automatically when you change a property with the playhead parked.</div>
                  </div>
                </label>
              </div>

              <div className={styles.settingsRow}>
                <label className={styles.settingsOption}>
                  <input
                    type="checkbox"
                    checked={prefs.editorReduceMotion}
                    onChange={(e) => setPref('editorReduceMotion', e.target.checked)}
                    className={styles.checkbox}
                  />
                  <div>
                    <div className={styles.optionTitle}>Reduce interface motion</div>
                    <div className={styles.optionDesc}>Disable UI transitions and animations. Applies immediately.</div>
                  </div>
                </label>
              </div>

              <div className={styles.settingsRowSelect}>
                <label className={styles.selectLabelField}>
                  <span>Sidebar Items Density</span>
                  <select
                    value={String(prefs.sidebarDensity || 'default')}
                    onChange={(e) => setPref('sidebarDensity', e.target.value as any)}
                    className={styles.filterDropdown}
                  >
                    <option value="compact">Compact</option>
                    <option value="default">Default</option>
                    <option value="comfortable">Comfortable</option>
                  </select>
                </label>
              </div>

              <div className={styles.settingsRow} style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-4)' }}>
                <Button
                  variant="secondary"
                  onClick={() => openCustomizeDialog()}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Icon name="settings" size={16} style={{ marginRight: 8 }} />
                  Customize Appearance, Shortcuts & Workspaces…
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
            <Icon name="warning" size={24} />
            <p>{error}</p>
            <button type="button" className={styles.btnSecondary} onClick={() => load()}>
              Retry
            </button>
          </div>
        )}

        {status === 'ready' && filteredProjects.length === 0 && (
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
              <Icon name="plus" size={14} />
              <span>Create a project</span>
            </button>
          </div>
        )}

        {status === 'ready' && filteredProjects.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>
                  <Checkbox
                    checked={
                      selectedIds.size === filteredProjects.length && filteredProjects.length > 0
                    }
                    indeterminate={
                      selectedIds.size > 0 && selectedIds.size < filteredProjects.length
                    }
                    onChange={toggleSelectAll}
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
              {filteredProjects.map((p) => {
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
                            <Icon name="video" size={18} className={styles.thumbIcon} />
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
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {status === 'ready' && total > 0 && (
          <div className={styles.pageFoot}>
            <span className={styles.pageCount}>
              Showing {projects.length} of {total} {total === 1 ? 'project' : 'projects'}
            </span>
            {projects.length < total && (
              <button type="button" className={styles.btnSecondary} onClick={() => void loadMore()}>
                <span>Load more</span>
              </button>
            )}
          </div>
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
        <nav className={styles.sidebarNav}>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'home' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('home')}
          >
            <Icon name="home" size={16} className={styles.navIcon} />
            <span>Home</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'projects' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <Icon name="folder" size={16} className={styles.navIcon} />
            <span>Projects & Drafts</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'assets' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('assets')}
          >
            <Icon name="image" size={16} className={styles.navIcon} />
            <span>Assets Library</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'renders' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('renders')}
          >
            <Icon name="queue" size={16} className={styles.navIcon} />
            <span>Render Queue</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'trash' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('trash')}
          >
            <Icon name="trash" size={16} className={styles.navIcon} />
            <span>Trash</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'settings' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Icon name="settings" size={16} className={styles.navIcon} />
            <span>Settings</span>
          </button>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.upgradeCardBox}>
            <div className={styles.upgradeCardHeader}>
              <div className={styles.upgradeCardBadge}>
                <Icon name="sparkles" size={13} />
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
            <Icon name="lock" size={15} className={styles.logoutIcon} />
            <span>Log out</span>
          </button>
        </div>
      </aside>

      {/* 2. Main Area */}
      <div className={styles.container}>

        {/* Main Content Workspace */}
        <main className={styles.mainContent}>
          <div className={styles.pageTitleRow}>
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
                  <Icon name="search" size={14} className={styles.inputSearchIcon} />
                  <input
                    type="text"
                    placeholder="Search projects..."
                    className={styles.projectSearchInput}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                {/* Filters on a real, stored fact. The Category and Status
                    dropdowns that used to sit here filtered on values invented
                    from the revision counter. */}
                <select
                  value={orientationFilter}
                  onChange={(e) => setOrientationFilter(e.target.value as 'all' | Orientation)}
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
                        for (const id of selectedIds) {
                          await remove(id).catch(() => undefined);
                        }
                        setSelectedIds(new Set());
                      }
                    }}
                  >
                    <Icon name="trash" size={14} />
                    <span>Move to trash ({selectedIds.size})</span>
                  </button>
                )}

                <button type="button" className={styles.btnSecondary} disabled>
                  <span>Actions</span>
                  <Icon name="chevron-down" size={12} />
                </button>

                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={onCreate}
                  disabled={creating}
                >
                  <Icon name="plus" size={14} />
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
              leftIcon={<Icon name="check" size={14} />}
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
