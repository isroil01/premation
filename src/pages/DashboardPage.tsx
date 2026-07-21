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
import { api, type AccountRecord, type ImportedAssetDto, type RenderJobDto, type TrashedProject } from '@core/api/client';
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

type TabType = 'home' | 'projects' | 'assets' | 'renders' | 'trash' | 'settings'
  | 'cursors' | 'motion-graphics' | 'transitions' | 'sound-fx' | 'lottie';

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
      || t === 'cursors' || t === 'motion-graphics' || t === 'transitions' || t === 'sound-fx' || t === 'lottie'
      ? (t as TabType)
      : 'home';
  });

  // Library sub-filters
  const [cursorFilter, setCursorFilter] = useState<'all' | 'click' | 'trail' | 'spotlight' | 'hand'>('all');
  const [mgFilter, setMgFilter] = useState<'all' | 'lower-thirds' | 'callouts' | 'shapes' | 'titles'>('all');
  const [transFilter, setTransFilter] = useState<'all' | 'wipe' | 'zoom' | 'push' | 'glitch'>('all');
  const [sfxFilter, setSfxFilter] = useState<'all' | 'whoosh' | 'click' | 'impact' | 'ambient'>('all');
  const [lottieFilter, setLottieFilter] = useState<'all' | 'icons' | 'loaders' | 'illustrations' | 'stickers'>('all');

  // Search & Filter States for Projects
  const [searchQuery, setSearchQuery] = useState('');
  const [orientationFilter, setOrientationFilter] = useState<'all' | Orientation>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Assets & renders — both come from the backend. They used to be hardcoded
  // arrays (`intro_backdrop.mp4`, a job frozen at "Rendering 45%") that ignored
  // the real /assets and /render endpoints entirely.
  const [assetTypeFilter, setAssetTypeFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const [assetsList, setAssetsList] = useState<ImportedAssetDto[]>([]);
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
        const [assets, renders, me] = await Promise.all([
          api.listAssets(undefined, { limit: 100 }),
          api.listRenders({ limit: 50 }),
          api.me(),
        ]);
        if (!live) return;
        setAssetsList(assets.items);
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
  const handleImportAsset = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setAssetsBusy(true);
    setDataError('');
    try {
      const uploaded = await Promise.all([...files].map((f) => api.uploadAsset(f)));
      setAssetsList((prev) => [...uploaded, ...prev]);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setAssetsBusy(false);
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
      void load(searchQuery); // it belongs back in the live list
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not restore that project.');
    }
  };

  const handleDestroy = async (id: string, name: string): Promise<void> => {
    // The one place in the app where "cannot be undone" is actually true, so
    // it says so — and it takes two deliberate steps to get here.
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

  const handleDeleteAsset = async (id: string, name: string): Promise<void> => {
    if (!await customConfirm('Delete Asset', `Delete “${name}”? This cannot be undone.`, { isDanger: true, confirmLabel: 'Delete' })) return;
    try {
      await api.deleteAsset(id);
      setAssetsList((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Could not delete that asset.');
    }
  };

  const filteredAssets = useMemo(() => {
    if (assetTypeFilter === 'all') return assetsList;
    return assetsList.filter((a) => a.type === assetTypeFilter);
  }, [assetsList, assetTypeFilter]);

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
                  {/* Summed from the real asset records, not a literal. */}
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
                    void handleImportAsset(e.currentTarget.files);
                    e.currentTarget.value = '';
                  }}
                />
              </label>
            </div>

            {dataError ? <p className={styles.emptyHint}>{dataError}</p> : null}

            {filteredAssets.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="folder" size={28} />
                <p>{assetsList.length === 0 ? 'No assets yet. Import an image, video, or audio file to use in your compositions.' : 'No assets of this type.'}</p>
              </div>
            ) : (
              <div className={styles.assetsGrid}>
                {filteredAssets.map((asset) => (
                  <div key={asset.id} className={styles.assetCard}>
                    <div className={styles.assetPreview}>
                      {/* A real thumbnail when the file is an image; the icon
                          is the fallback, not the whole story. */}
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
                {/* Real jobs from /render. This table used to list four
                    hardcoded ones, including a job pinned at "45%" forever. */}
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
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Deleted</th>
                    <th>Purges in</th>
                    <th style={{ width: '150px', textAlign: 'center' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {trash.map((p) => (
                    <tr key={p.id}>
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
                        {/* The server counts this down, so the warning is real. */}
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
                  ))}
                </tbody>
              </table>
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
                  {/* The real plan, from /auth/me. This badge used to read
                      "Active Node: AE-9 Enterprise" — an invented tier. */}
                  <div className={styles.profileNodeBadge}>
                    {account ? `${account.plan === 'pro' ? 'Pro' : 'Free'} plan · member since ${new Date(account.createdAt).toLocaleDateString()}` : '—'}
                  </div>
                </div>
              </div>

              {/* Real storage: the sum of this account's stored assets. There
                  is no quota to show against yet, so we don't invent one. */}
              <div className={styles.storageBarSection}>
                <div className={styles.storageBarHeader}>
                  <span>Cloud Workspace Storage</span>
                  <span className={styles.monoValue}>
                    {formatBytes(account?.storageBytes ?? 0)} across {account?.assetCount ?? 0} {account?.assetCount === 1 ? 'asset' : 'assets'}
                  </span>
                </div>
              </div>
            </div>

            {/* Assistant — how the AI is powered (platform AI or your own key). */}
            <div className={styles.settingsCard} id="ai-settings">
              <h3 className={styles.settingsLabel}>Assistant</h3>
              <AiSettingsSection />
            </div>

            {/* Plan & credits — sits right under the AI setup it meters. */}
            <div className={styles.settingsCard} id="billing">
              <h3 className={styles.settingsLabel}>Plan & Credits</h3>
              <BillingSection />
            </div>

            {/* Editor preferences — every control here is backed by
                usePreferenceStore, which persists and applies to the DOM.
                The cards that used to sit here ("Auto-save compositions",
                "Hardware GPU Acceleration", "Default Resolution/Frame Rate",
                "Audio Sample Rate", "Viewport & Render Cache") were pure
                useState: never saved, never read, and autosave ignored its
                own checkbox entirely. */}
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
                  <span>Interface Scale</span>
                  <select
                    value={String(prefs.uiScale)}
                    onChange={(e) => setPref('uiScale', Number(e.target.value))}
                    className={styles.filterDropdown}
                  >
                    <option value="0.9">90% High density</option>
                    <option value="1">100% Native (default)</option>
                    <option value="1.1">110% Comfortable</option>
                    <option value="1.25">125% Large</option>
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

      case 'cursors':
        return renderCursorLibrary();

      case 'motion-graphics':
        return renderMotionGraphicsLibrary();

      case 'transitions':
        return renderTransitionsLibrary();

      case 'sound-fx':
        return renderSoundFxLibrary();

      case 'lottie':
        return renderLottieLibrary();

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
              {/* Every column below is a fact the server stores. The previous
                  version derived Category/Resolution/Status from `revision %`,
                  so a 4K comp displayed as 1080×1920 and its category changed
                  each time it was saved. */}
              {filteredProjects.map((p) => {
                const isSelected = selectedIds.has(p.id);
                const orientation = orientationOf(p);
                // The server hands us a URL; building one from a storage key
                // here meant knowing where files live, which is its business.
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

        {/* The list is a page, so say how much of it you're looking at —
            "20 of 143" is honest where a bare 20 pretends to be everything. */}
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

  // ── Cursor Library ────────────────────────────────────────────────────────
  const CURSOR_ITEMS = [
    { id: 'c1', name: 'Default Arrow', category: 'click', tag: 'FREE', preview: '#2988ff', animated: false },
    { id: 'c2', name: 'Click Ripple', category: 'click', tag: 'FREE', preview: '#8b5cf6', animated: true },
    { id: 'c3', name: 'Double Click Burst', category: 'click', tag: 'FREE', preview: '#f59e0b', animated: true },
    { id: 'c4', name: 'Glow Trail', category: 'trail', tag: 'PRO', preview: '#10b981', animated: true },
    { id: 'c5', name: 'Neon Trail', category: 'trail', tag: 'PRO', preview: '#ec4899', animated: true },
    { id: 'c6', name: 'Particle Trail', category: 'trail', tag: 'PRO', preview: '#6366f1', animated: true },
    { id: 'c7', name: 'Spotlight Circle', category: 'spotlight', tag: 'FREE', preview: '#f97316', animated: false },
    { id: 'c8', name: 'Soft Spotlight', category: 'spotlight', tag: 'FREE', preview: '#84cc16', animated: false },
    { id: 'c9', name: 'Hand Pointer', category: 'hand', tag: 'FREE', preview: '#14b8a6', animated: false },
    { id: 'c10', name: 'Hand Click', category: 'hand', tag: 'FREE', preview: '#a78bfa', animated: true },
    { id: 'c11', name: 'Crosshair', category: 'click', tag: 'PRO', preview: '#fb7185', animated: false },
    { id: 'c12', name: 'Magnetic Pull', category: 'trail', tag: 'PRO', preview: '#38bdf8', animated: true },
  ] as const;

  const renderCursorLibrary = () => (
    <div className={styles.libraryContainer}>
      <div className={styles.libraryFilterBar}>
        {(['all', 'click', 'trail', 'spotlight', 'hand'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.libraryPill} ${cursorFilter === f ? styles.libraryPillActive : ''}`}
            onClick={() => setCursorFilter(f)}
          >
            {f === 'all' ? 'All Cursors' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className={styles.libraryPillSpacer} />
        <span className={styles.libraryHint}>Drag into timeline to overlay on any layer</span>
      </div>
      <div className={styles.libraryGrid}>
        {CURSOR_ITEMS
          .filter((c) => cursorFilter === 'all' || c.category === cursorFilter)
          .map((item) => (
            <div key={item.id} className={styles.libraryCard}>
              <div
                className={styles.cursorPreview}
                style={{ background: `radial-gradient(ellipse at 40% 40%, ${item.preview}33 0%, transparent 70%), linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)` }}
              >
                <div className={styles.cursorDot} style={{ background: item.preview, boxShadow: `0 0 12px ${item.preview}` }} />
                {item.animated && <div className={styles.cursorRipple} style={{ borderColor: item.preview }} />}
              </div>
              <div className={styles.libraryCardMeta}>
                <div className={styles.libraryCardName}>{item.name}</div>
                <div className={styles.libraryCardBadgeRow}>
                  <span className={`${styles.libraryBadge} ${item.tag === 'PRO' ? styles.libraryBadgePro : styles.libraryBadgeFree}`}>
                    {item.tag}
                  </span>
                  {item.animated && <span className={styles.libraryBadgeAnimated}>ANIMATED</span>}
                </div>
              </div>
              <button
                type="button"
                className={styles.libraryCardAdd}
                title="Add to timeline"
                onClick={() => useUIStore.getState().notify({ level: 'info', message: `"${item.name}" added to timeline`, durationMs: 2000 })}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );

  // ── Motion Graphics Library ───────────────────────────────────────────────
  const MG_ITEMS = [
    { id: 'mg1', name: 'Clean Lower Third', category: 'lower-thirds', tag: 'FREE', color: '#2988ff', duration: '3s' },
    { id: 'mg2', name: 'Bold Name Plate', category: 'lower-thirds', tag: 'FREE', color: '#8b5cf6', duration: '4s' },
    { id: 'mg3', name: 'News Ticker', category: 'lower-thirds', tag: 'PRO', color: '#f59e0b', duration: 'Loop' },
    { id: 'mg4', name: 'Speech Bubble', category: 'callouts', tag: 'FREE', color: '#10b981', duration: '2s' },
    { id: 'mg5', name: 'Arrow Callout', category: 'callouts', tag: 'FREE', color: '#ec4899', duration: '1.5s' },
    { id: 'mg6', name: 'Highlight Box', category: 'callouts', tag: 'FREE', color: '#6366f1', duration: '2s' },
    { id: 'mg7', name: 'Geometric Circle', category: 'shapes', tag: 'FREE', color: '#f97316', duration: 'Loop' },
    { id: 'mg8', name: 'Particle Burst', category: 'shapes', tag: 'PRO', color: '#84cc16', duration: '2s' },
    { id: 'mg9', name: 'Grid Reveal', category: 'shapes', tag: 'PRO', color: '#14b8a6', duration: '1.5s' },
    { id: 'mg10', name: 'Kinetic Title', category: 'titles', tag: 'FREE', color: '#a78bfa', duration: '3s' },
    { id: 'mg11', name: 'Glitch Title', category: 'titles', tag: 'PRO', color: '#fb7185', duration: '2s' },
    { id: 'mg12', name: 'Neon Glow Title', category: 'titles', tag: 'PRO', color: '#38bdf8', duration: '4s' },
  ] as const;

  const renderMotionGraphicsLibrary = () => (
    <div className={styles.libraryContainer}>
      <div className={styles.libraryFilterBar}>
        {(['all', 'lower-thirds', 'callouts', 'shapes', 'titles'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.libraryPill} ${mgFilter === f ? styles.libraryPillActive : ''}`}
            onClick={() => setMgFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'lower-thirds' ? 'Lower Thirds' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className={styles.libraryPillSpacer} />
        <span className={styles.libraryHint}>Drag to composition timeline</span>
      </div>
      <div className={styles.libraryGrid}>
        {MG_ITEMS
          .filter((m) => mgFilter === 'all' || m.category === mgFilter)
          .map((item) => (
            <div key={item.id} className={styles.libraryCard}>
              <div
                className={styles.mgPreview}
                style={{ background: `linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%)` }}
              >
                <div className={styles.mgBar} style={{ background: item.color }} />
                <div className={styles.mgTextLines}>
                  <div className={styles.mgTextLine1} style={{ background: item.color }} />
                  <div className={styles.mgTextLine2} />
                </div>
              </div>
              <div className={styles.libraryCardMeta}>
                <div className={styles.libraryCardName}>{item.name}</div>
                <div className={styles.libraryCardBadgeRow}>
                  <span className={`${styles.libraryBadge} ${item.tag === 'PRO' ? styles.libraryBadgePro : styles.libraryBadgeFree}`}>
                    {item.tag}
                  </span>
                  <span className={styles.libraryDuration}>{item.duration}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.libraryCardAdd}
                title="Add to timeline"
                onClick={() => useUIStore.getState().notify({ level: 'info', message: `"${item.name}" added to timeline`, durationMs: 2000 })}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );

  // ── Transitions Library ───────────────────────────────────────────────────
  const TRANSITION_ITEMS = [
    { id: 't1', name: 'Clean Cut', category: 'wipe', tag: 'FREE', fromColor: '#2988ff', toColor: '#8b5cf6' },
    { id: 't2', name: 'Horizontal Wipe', category: 'wipe', tag: 'FREE', fromColor: '#1a1a2e', toColor: '#2988ff' },
    { id: 't3', name: 'Diagonal Wipe', category: 'wipe', tag: 'FREE', fromColor: '#10b981', toColor: '#1a1a2e' },
    { id: 't4', name: 'Zoom In', category: 'zoom', tag: 'FREE', fromColor: '#f59e0b', toColor: '#1a1a2e' },
    { id: 't5', name: 'Zoom Out', category: 'zoom', tag: 'FREE', fromColor: '#ec4899', toColor: '#1a1a2e' },
    { id: 't6', name: 'Whip Pan Zoom', category: 'zoom', tag: 'PRO', fromColor: '#6366f1', toColor: '#f97316' },
    { id: 't7', name: 'Push Left', category: 'push', tag: 'FREE', fromColor: '#84cc16', toColor: '#1a1a2e' },
    { id: 't8', name: 'Push Right', category: 'push', tag: 'FREE', fromColor: '#14b8a6', toColor: '#1a1a2e' },
    { id: 't9', name: 'Push Down', category: 'push', tag: 'PRO', fromColor: '#a78bfa', toColor: '#1a1a2e' },
    { id: 't10', name: 'Glitch Slice', category: 'glitch', tag: 'PRO', fromColor: '#fb7185', toColor: '#38bdf8' },
    { id: 't11', name: 'RGB Split', category: 'glitch', tag: 'PRO', fromColor: '#f43f5e', toColor: '#06b6d4' },
    { id: 't12', name: 'VHS Glitch', category: 'glitch', tag: 'PRO', fromColor: '#ef4444', toColor: '#22c55e' },
  ] as const;

  const renderTransitionsLibrary = () => (
    <div className={styles.libraryContainer}>
      <div className={styles.libraryFilterBar}>
        {(['all', 'wipe', 'zoom', 'push', 'glitch'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.libraryPill} ${transFilter === f ? styles.libraryPillActive : ''}`}
            onClick={() => setTransFilter(f)}
          >
            {f === 'all' ? 'All Transitions' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className={styles.libraryPillSpacer} />
        <span className={styles.libraryHint}>Drop between two clips on timeline</span>
      </div>
      <div className={styles.libraryGrid}>
        {TRANSITION_ITEMS
          .filter((t) => transFilter === 'all' || t.category === transFilter)
          .map((item) => (
            <div key={item.id} className={styles.libraryCard}>
              <div className={styles.transPreview}>
                <div className={styles.transLeft} style={{ background: item.fromColor }} />
                <div className={styles.transRight} style={{ background: item.toColor }} />
                <div className={styles.transDivider} />
              </div>
              <div className={styles.libraryCardMeta}>
                <div className={styles.libraryCardName}>{item.name}</div>
                <div className={styles.libraryCardBadgeRow}>
                  <span className={`${styles.libraryBadge} ${item.tag === 'PRO' ? styles.libraryBadgePro : styles.libraryBadgeFree}`}>
                    {item.tag}
                  </span>
                  <span className={styles.libraryDuration}>{item.category.toUpperCase()}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.libraryCardAdd}
                title="Add to timeline"
                onClick={() => useUIStore.getState().notify({ level: 'info', message: `"${item.name}" transition added`, durationMs: 2000 })}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );

  // ── Sound FX Library ──────────────────────────────────────────────────────
  const SFX_ITEMS = [
    { id: 's1', name: 'UI Click', category: 'click', tag: 'FREE', duration: '0.1s', waveColor: '#2988ff' },
    { id: 's2', name: 'Button Pop', category: 'click', tag: 'FREE', duration: '0.2s', waveColor: '#8b5cf6' },
    { id: 's3', name: 'Toggle Switch', category: 'click', tag: 'FREE', duration: '0.15s', waveColor: '#10b981' },
    { id: 's4', name: 'Fast Whoosh', category: 'whoosh', tag: 'FREE', duration: '0.4s', waveColor: '#f59e0b' },
    { id: 's5', name: 'Heavy Whoosh', category: 'whoosh', tag: 'FREE', duration: '0.6s', waveColor: '#ec4899' },
    { id: 's6', name: 'Wind Sweep', category: 'whoosh', tag: 'PRO', duration: '0.8s', waveColor: '#6366f1' },
    { id: 's7', name: 'Hit Impact', category: 'impact', tag: 'FREE', duration: '0.3s', waveColor: '#f97316' },
    { id: 's8', name: 'Thud', category: 'impact', tag: 'FREE', duration: '0.5s', waveColor: '#ef4444' },
    { id: 's9', name: 'Cinematic Boom', category: 'impact', tag: 'PRO', duration: '1.2s', waveColor: '#7c3aed' },
    { id: 's10', name: 'Room Tone', category: 'ambient', tag: 'FREE', duration: 'Loop', waveColor: '#14b8a6' },
    { id: 's11', name: 'City Noise', category: 'ambient', tag: 'FREE', duration: 'Loop', waveColor: '#84cc16' },
    { id: 's12', name: 'Studio Hum', category: 'ambient', tag: 'PRO', duration: 'Loop', waveColor: '#38bdf8' },
  ] as const;

  const renderSoundFxLibrary = () => (
    <div className={styles.libraryContainer}>
      <div className={styles.libraryFilterBar}>
        {(['all', 'click', 'whoosh', 'impact', 'ambient'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.libraryPill} ${sfxFilter === f ? styles.libraryPillActive : ''}`}
            onClick={() => setSfxFilter(f)}
          >
            {f === 'all' ? 'All SFX' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className={styles.libraryPillSpacer} />
        <span className={styles.libraryHint}>Sync to keyframe or drop on audio track</span>
      </div>
      <div className={styles.libraryGrid}>
        {SFX_ITEMS
          .filter((s) => sfxFilter === 'all' || s.category === sfxFilter)
          .map((item) => (
            <div key={item.id} className={styles.libraryCard}>
              <div className={styles.sfxPreview}>
                {[4, 7, 12, 9, 14, 8, 11, 6, 10, 13, 5, 9, 7].map((h, i) => (
                  <div
                    key={i}
                    className={styles.sfxBar}
                    style={{ height: `${h * 3}px`, background: item.waveColor, opacity: 0.6 + (i % 3) * 0.15 }}
                  />
                ))}
              </div>
              <div className={styles.libraryCardMeta}>
                <div className={styles.libraryCardName}>{item.name}</div>
                <div className={styles.libraryCardBadgeRow}>
                  <span className={`${styles.libraryBadge} ${item.tag === 'PRO' ? styles.libraryBadgePro : styles.libraryBadgeFree}`}>
                    {item.tag}
                  </span>
                  <span className={styles.libraryDuration}>{item.duration}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.libraryCardAdd}
                title="Add to timeline"
                onClick={() => useUIStore.getState().notify({ level: 'info', message: `"${item.name}" added to audio track`, durationMs: 2000 })}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );

  // ── Lottie & JSON Library ─────────────────────────────────────────────────
  const LOTTIE_ITEMS = [
    { id: 'l1', name: 'Success Check', category: 'icons', tag: 'FREE', color: '#10b981', frames: 60, size: '4.2 KB' },
    { id: 'l2', name: 'Loading Spinner', category: 'loaders', tag: 'FREE', color: '#2988ff', frames: 120, size: '2.8 KB' },
    { id: 'l3', name: 'Warning Alert', category: 'icons', tag: 'FREE', color: '#f59e0b', frames: 90, size: '3.5 KB' },
    { id: 'l4', name: 'Heart Like', category: 'icons', tag: 'FREE', color: '#ec4899', frames: 45, size: '5.1 KB' },
    { id: 'l5', name: 'Dots Loader', category: 'loaders', tag: 'FREE', color: '#8b5cf6', frames: 60, size: '1.9 KB' },
    { id: 'l6', name: 'Progress Ring', category: 'loaders', tag: 'PRO', color: '#6366f1', frames: 90, size: '3.2 KB' },
    { id: 'l7', name: 'Globe Spin', category: 'illustrations', tag: 'PRO', color: '#14b8a6', frames: 180, size: '22 KB' },
    { id: 'l8', name: 'Rocket Launch', category: 'illustrations', tag: 'PRO', color: '#f97316', frames: 120, size: '18 KB' },
    { id: 'l9', name: 'Thumbs Up', category: 'stickers', tag: 'FREE', color: '#84cc16', frames: 60, size: '8.4 KB' },
    { id: 'l10', name: 'Fire Flame', category: 'stickers', tag: 'FREE', color: '#ef4444', frames: 120, size: '6.7 KB' },
    { id: 'l11', name: 'Star Burst', category: 'stickers', tag: 'PRO', color: '#fbbf24', frames: 45, size: '5.2 KB' },
    { id: 'l12', name: 'Confetti Pop', category: 'illustrations', tag: 'PRO', color: '#a78bfa', frames: 150, size: '14 KB' },
  ] as const;

  const renderLottieLibrary = () => (
    <div className={styles.libraryContainer}>
      <div className={styles.libraryFilterBar}>
        {(['all', 'icons', 'loaders', 'illustrations', 'stickers'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.libraryPill} ${lottieFilter === f ? styles.libraryPillActive : ''}`}
            onClick={() => setLottieFilter(f)}
          >
            {f === 'all' ? 'All Lottie' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className={styles.libraryPillSpacer} />
        <span className={styles.libraryHint}>Import JSON · plays in comp at native FPS</span>
      </div>
      <div className={styles.libraryGrid}>
        {LOTTIE_ITEMS
          .filter((l) => lottieFilter === 'all' || l.category === lottieFilter)
          .map((item) => (
            <div key={item.id} className={styles.libraryCard}>
              <div
                className={styles.lottiePreview}
                style={{ background: `radial-gradient(circle at 50% 45%, ${item.color}22 0%, transparent 65%), #0f0f1a` }}
              >
                <div
                  className={styles.lottieOrb}
                  style={{ background: `conic-gradient(from 0deg, ${item.color}, ${item.color}44, ${item.color})`, boxShadow: `0 0 20px ${item.color}55` }}
                />
                <span className={styles.lottieJsonBadge}>JSON</span>
              </div>
              <div className={styles.libraryCardMeta}>
                <div className={styles.libraryCardName}>{item.name}</div>
                <div className={styles.libraryCardBadgeRow}>
                  <span className={`${styles.libraryBadge} ${item.tag === 'PRO' ? styles.libraryBadgePro : styles.libraryBadgeFree}`}>
                    {item.tag}
                  </span>
                  <span className={styles.libraryDuration}>{item.frames}f · {item.size}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.libraryCardAdd}
                title="Import Lottie"
                onClick={() => useUIStore.getState().notify({ level: 'info', message: `"${item.name}" Lottie imported`, durationMs: 2000 })}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          ))}
      </div>
    </div>
  );

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
      case 'cursors':
        return {
          title: 'Cursor Library',
          desc: 'Animated cursor overlays, click ripples, trails and spotlights — perfect for screen recordings & tutorials.',
        };
      case 'motion-graphics':
        return {
          title: 'Motion Graphics',
          desc: 'Pre-built animated lower-thirds, callouts, shape bursts and kinetic title cards.',
        };
      case 'transitions':
        return {
          title: 'Transitions',
          desc: 'Wipe, push, zoom and glitch transitions. Drop between two clips on the timeline.',
        };
      case 'sound-fx':
        return {
          title: 'Sound FX',
          desc: 'Short motion-accent sounds — UI clicks, whooshes, impacts and ambient loops.',
        };
      case 'lottie':
        return {
          title: 'Lottie & JSON',
          desc: 'Import Lottie JSON animations directly into your composition — icons, loaders, illustrations and stickers.',
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
            <Icon name="layout" size={16} className={styles.navIcon} />
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

          {/* ── Asset Libraries section ─────────────────────────────── */}
          <div className={styles.navSectionLabel}>Libraries</div>

          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'cursors' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('cursors')}
          >
            <Icon name="mouse-pointer" size={16} className={styles.navIcon} />
            <span>Cursors</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'motion-graphics' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('motion-graphics')}
          >
            <Icon name="layers" size={16} className={styles.navIcon} />
            <span>Motion Graphics</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'transitions' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('transitions')}
          >
            <Icon name="scissors" size={16} className={styles.navIcon} />
            <span>Transitions</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'sound-fx' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('sound-fx')}
          >
            <Icon name="zap" size={16} className={styles.navIcon} />
            <span>Sound FX</span>
          </button>
          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'lottie' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('lottie')}
          >
            <Icon name="ease" size={16} className={styles.navIcon} />
            <span>Lottie & JSON</span>
          </button>

          <button
            type="button"
            className={`${styles.navLink} ${activeTab === 'renders' ? styles.navLinkActive : ''}`}
            onClick={() => setActiveTab('renders')}
          >
            <Icon name="video" size={16} className={styles.navIcon} />
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
