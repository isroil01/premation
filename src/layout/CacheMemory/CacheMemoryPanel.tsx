/**
 * Cache & Memory — where the preview cache lives, what it holds, and what the
 * engine's memory is doing (Window ▸ Cache & Memory, or the transport bar's
 * memory meter).
 *
 * After Effects spreads this over Preferences ▸ Memory & Performance,
 * Preferences ▸ Media & Disk Cache, Edit ▸ Purge and the Info panel, and shows
 * none of it while you work. Here it is one dockable panel, three views:
 *
 *   • Overview     the tiers against their budgets (RAM tier, the graphics
 *                  card as the OS shares it out — Premation's frame cache and
 *                  layers against what other apps hold — and the disk tier),
 *                  this composition's coverage with Cache
 *                  Work Area Now, the preview switches (idle render-ahead, cache
 *                  before playback, resolution) and the RAM budget;
 *   • Location     the disk cache's folder, its size limit and measured read
 *                  speed, and every drive with its free space;
 *   • Health       Project Health (ProjectHealthView.tsx): the active comp's
 *                  cache, video layers, layer errors and missing footage, and
 *                  one suggestion + action per problem (create proxies, cache
 *                  the work area, purge…) — the status bar's dot opens it;
 *   • Diagnostics  this frame's build / GPU / decode time against the frame
 *                  budget, the heaviest layers (one frame's GPU time per
 *                  layer, GpuViews.tsx), engine memory over 30 minutes, memory outside the
 *                  caches (the leak signal), what happened this session, and
 *                  Restart Engine to Free Memory.
 *
 * Every figure is the engine's (`getRenderStats`, `getCacheCoverage`), read by
 * `engineMemory.ts` and `usePreviewCacheStats`; every setting is a preference
 * `diskCacheSync.ts` sends as `setCacheBudget`, or the shared render quality.
 * Nothing here re-renders per played frame: both readers sample at 2 Hz or less.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Segmented, type SegmentedOption } from '@components/Segmented';
import { Switch } from '@components/Switch';
import { customConfirm } from '@components/Modal/Dialogs';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useRenderQualityStore, resolutionChoiceOf, setResolutionChoice, type ResolutionChoice } from '@stores/renderQualityStore';
import { useActiveMirrorComp, compFps } from '@hooks/useMirror';
import { formatBytes, type MemoryReadout, type MemorySample } from '@core/perf/memoryHealth';
import { t } from '@core/i18n';
import { cn } from '@utils/cn';
import { usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import {
  cacheWorkAreaNow,
  cacheWorkAreaUnavailable,
  canCacheWorkArea,
  purgeDiskCache,
  purgeRamPreview,
} from '@layout/Timeline/previewCacheCommands';
import { DISK_CACHE_MAX_GB, DISK_CACHE_MIN_GB, defaultDiskCacheFolder } from '@layout/Timeline/diskCacheSync';
import { engineMemorySnapshot, refreshEngineMemory, subscribeEngineMemory, type EngineMemorySnapshot, type MemoryEvent } from './engineMemory';
import { healthCopy, healthTone } from './memoryCopy';
import { setCacheMemoryView, useCacheMemoryView, type CacheMemoryView } from './cacheMemoryView';
import { ProjectHealthView } from './ProjectHealthView';
import { GraphicsMemory, HeaviestLayers } from './GpuViews';
import styles from './CacheMemoryPanel.module.css';

type View = CacheMemoryView;

const GiB = 1024 ** 3;

function views(): ReadonlyArray<SegmentedOption<View>> {
  return [
    { value: 'overview', label: t('cacheMemory.view.overview', 'Overview') },
    { value: 'health', label: t('cacheMemory.view.health', 'Health') },
    { value: 'location', label: t('cacheMemory.view.location', 'Location') },
    { value: 'diagnostics', label: t('cacheMemory.view.diagnostics', 'Diagnostics') },
  ];
}

export function useEngineMemory(): EngineMemorySnapshot {
  return useSyncExternalStore(subscribeEngineMemory, engineMemorySnapshot);
}

export function CacheMemoryPanel(): JSX.Element {
  const mem = useEngineMemory();
  // Module state, so the status bar's health dot can open the panel on Health.
  const view = useCacheMemoryView();
  const setView = setCacheMemoryView;
  const copy = healthCopy(mem.health, mem.readout);

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <div className={styles.banner} data-tone={healthTone(mem.health)} role="status">
          <span className={styles.dot} aria-hidden />
          <div className={styles.bannerText}>
            <span className={styles.bannerTitle}>{copy.title}</span>
            <span className={styles.help}>{copy.body}</span>
          </div>
        </div>
        <Segmented
          size="sm"
          fullWidth
          aria-label={t('cacheMemory.view.aria', 'Cache and memory view')}
          options={views()}
          value={view}
          onChange={setView}
        />
      </div>
      <div className={styles.body}>
        {view === 'overview' && <Overview readout={mem.readout} />}
        {view === 'health' && <ProjectHealthView />}
        {view === 'location' && <Location readout={mem.readout} />}
        {view === 'diagnostics' && <Diagnostics mem={mem} />}
      </div>
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────

interface TierProps {
  name: string;
  tone: 'ram' | 'vram' | 'disk';
  used: number;
  budget: number | null;
  /** What the bar's full width stands for (installed memory, the drive); null = the budget. */
  scale: number | null;
  detail: string;
  onPurge?: () => void;
  purgeLabel?: string;
}

function Tier({ name, tone, used, budget, scale, detail, onPurge, purgeLabel }: TierProps): JSX.Element {
  const full = scale ?? budget ?? 0;
  const usedPct = full > 0 ? Math.min(100, (used / full) * 100) : 0;
  const budgetPct = budget && full > 0 ? Math.min(100, (budget / full) * 100) : null;
  return (
    <div className={styles.tier}>
      <div className={styles.tierHead}>
        <span className={styles.swatch} data-tone={tone} aria-hidden />
        <span className={styles.label}>{name}</span>
        <span className={styles.value} data-numeric>
          {budget ? `${formatBytes(used)} / ${formatBytes(budget)}` : formatBytes(used)}
        </span>
        {onPurge && (
          <Button variant="ghost" size="xs" iconOnly icon={<Icon name="trash" size="sm" />} title={purgeLabel} disabled={used <= 0} onClick={onPurge}>
            {purgeLabel}
          </Button>
        )}
      </div>
      <div className={styles.track} role="img" aria-label={t('cacheMemory.tier.bar', '{name}: {used} used of {budget}', { name, used: formatBytes(used), budget: budget ? formatBytes(budget) : '—' })}>
        <span className={styles.fill} data-tone={tone} style={{ width: `${usedPct}%` }} />
        {budgetPct !== null && scale !== null && <span className={styles.budgetMark} style={{ left: `${budgetPct}%` }} />}
      </div>
      <span className={styles.help}>{detail}</span>
    </div>
  );
}

function ramBudgetItems(physical: number | null, current: number): DropdownItem[] {
  const options = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128].filter((gb) => physical === null || gb * GiB < physical * 0.9);
  return [
    {
      type: 'checkbox', id: 'ram-auto', checked: current === 0,
      label: t('cacheMemory.ramBudget.auto', 'Auto — sized from this machine'),
      onChange: () => usePreferenceStore.getState().set('ramCacheGb', 0),
    },
    { type: 'separator' },
    ...options.map<DropdownItem>((gb) => ({
      type: 'checkbox', id: `ram-${gb}`, checked: current === gb, label: `${gb} GB`,
      onChange: () => usePreferenceStore.getState().set('ramCacheGb', gb),
    })),
  ];
}

function resolutions(): ReadonlyArray<SegmentedOption<ResolutionChoice>> {
  return [
    { value: 'auto', label: t('inspector.preview.resAuto', 'Auto') },
    { value: '1', label: t('inspector.preview.resFull', 'Full') },
    { value: '2', label: '½', ariaLabel: t('inspector.preview.resHalf', 'Half') },
    { value: '3', label: '⅓', ariaLabel: t('inspector.preview.resThird', 'Third') },
    { value: '4', label: '¼', ariaLabel: t('inspector.preview.resQuarter', 'Quarter') },
  ];
}

function Overview({ readout }: { readout: MemoryReadout | null }): JSX.Element {
  const { stats: cache, refresh } = usePreviewCacheStats();
  const idleRenderAhead = usePreferenceStore((s) => s.idleRenderAhead);
  const cacheBeforePlayback = usePreferenceStore((s) => s.cacheBeforePlayback);
  const ramCacheGb = usePreferenceStore((s) => s.ramCacheGb);
  const diskEnabled = usePreferenceStore((s) => s.diskCacheEnabled);
  const setPref = usePreferenceStore((s) => s.set);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const resolution = useRenderQualityStore((s) => s.resolution);

  const r = readout;
  const physical = r?.physicalBytes ?? null;
  const ramPct = cache.total > 0 ? (cache.cached / cache.total) * 100 : 0;
  const diskPct = cache.total > 0 ? (cache.onDisk / cache.total) * 100 : 0;
  const full = cache.total > 0 && cache.cached >= cache.total;
  const canCache = canCacheWorkArea();

  const purgeRam = (): void => {
    purgeRamPreview();
    refresh();
    refreshEngineMemory();
  };
  const purgeDisk = (): void => {
    purgeDiskCache();
    refresh();
    refreshEngineMemory();
  };

  return (
    <>
      <section className={styles.section} aria-label={t('cacheMemory.memory', 'Memory')}>
        <span className={styles.group}>{t('cacheMemory.memory', 'Memory')}</span>
        <Tier
          name={t('cacheMemory.tier.ram', 'RAM previews')}
          tone="ram"
          used={r?.ramBytes ?? 0}
          budget={r?.ramBudget ?? null}
          scale={physical}
          detail={physical
            ? t('cacheMemory.tier.ramDetail', '{installed} installed · {free} free now', { installed: formatBytes(physical), free: formatBytes(r?.availableBytes ?? 0) })
            : t('cacheMemory.tier.ramDetailNoMachine', 'Frames video memory let go of, kept in system memory')}
          onPurge={purgeRam}
          purgeLabel={t('cacheMemory.purgeRam', 'Purge RAM and video memory previews')}
        />
        <GraphicsMemory readout={r} />
        <Tier
          name={t('cacheMemory.tier.disk', 'Disk cache')}
          tone="disk"
          used={r?.diskBytes ?? 0}
          budget={r?.diskBudget ? r.diskBudget : null}
          scale={null}
          detail={diskEnabled && r?.diskBudget
            ? t('cacheMemory.tier.diskDetail', 'Frames slower to render than to read back, kept between sessions')
            : t('cacheMemory.tier.diskOff', 'Off — turn it on in Location')}
          onPurge={purgeDisk}
          purgeLabel={t('cacheMemory.purgeDisk', 'Empty the disk cache')}
        />
        {(r?.simBytes ?? 0) + (r?.simDiskBytes ?? 0) > 0 ? (
          <>
            <div className={styles.rowHead}>
              <span className={styles.group}>{t('cacheMemory.sims', 'Plugin simulations')}</span>
              <span className={styles.value} data-numeric>
                {t('cacheMemory.simsValue', '{ram} in memory · {disk} on disk', { ram: formatBytes(r?.simBytes ?? 0), disk: formatBytes(r?.simDiskBytes ?? 0) })}
              </span>
            </div>
            <span className={styles.help}>
              {t('cacheMemory.simsHelp', 'Simulation steps kept so scrubbing back and playing on do not run them again. An edit re-runs only the frames after it.')}
            </span>
          </>
        ) : null}
        {(r?.mlModels ?? 0) > 0 ? (
          <>
            <div className={styles.rowHead}>
              <span className={styles.group}>{t('cacheMemory.ml', 'Plugin ML models')}</span>
              <span className={styles.value} data-numeric>
                {t('cacheMemory.mlValue', '{count} open · {size}', { count: r?.mlModels ?? 0, size: formatBytes(r?.mlBytes ?? 0) })}
              </span>
            </div>
            <span className={styles.help}>
              {t('cacheMemory.mlHelp', 'Models plugins run on the GPU. When video memory runs short, the ones not used lately are closed and load again when next needed.')}
            </span>
          </>
        ) : null}
      </section>

      <section className={styles.section} aria-label={t('cacheMemory.comp', 'This composition')}>
        <div className={styles.rowHead}>
          <span className={styles.group}>{t('cacheMemory.comp', 'This composition')}</span>
          <span className={styles.value} data-numeric>
            {cache.total > 0 ? t('cacheMemory.compFrames', '{cached} / {total} frames', { cached: cache.cached, total: cache.total }) : '—'}
          </span>
        </div>
        <div className={styles.coverage} aria-hidden>
          <span className={styles.coverDisk} style={{ width: `${diskPct}%` }} />
          <span className={styles.coverRam} style={{ width: `${ramPct}%` }} />
        </div>
        <span className={styles.help}>
          {t('cacheMemory.compHelp', 'Green: in memory. Blue: on disk. Zooming or panning the viewer keeps them; an edit re-renders only the frames it touches.')}
        </span>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size="sm" />}
            disabled={!canCache || cache.total === 0 || full}
            title={canCache ? undefined : cacheWorkAreaUnavailable()}
            onClick={() => { cacheWorkAreaNow(); refresh(); }}
          >
            {full
              ? t('cacheMemory.cached', 'All cached')
              : cache.workArea
                ? t('timeline.cache.cacheWorkAreaNow', 'Cache Work Area Now')
                : t('timeline.cache.cacheCompositionNow', 'Cache Composition Now')}
          </Button>
          <Button variant="secondary" size="sm" disabled={cache.ramMb <= 0} onClick={purgeRam}>
            {t('timeline.cache.purgeRamPreview', 'Purge RAM Preview')}
          </Button>
        </div>
      </section>

      <section className={styles.section} aria-label={t('cacheMemory.preview', 'Preview')}>
        <span className={styles.group}>{t('cacheMemory.preview', 'Preview')}</span>
        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            <span className={styles.label}>{t('cacheMemory.idle', 'Fill the cache while idle')}</span>
            <span className={styles.help}>{t('cacheMemory.idleHelp', 'With playback stopped, frames around the playhead render in the background.')}</span>
          </span>
          <Switch checked={idleRenderAhead} onChange={(e) => setPref('idleRenderAhead', e.currentTarget.checked)} aria-label={t('cacheMemory.idle', 'Fill the cache while idle')} />
        </label>
        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            <span className={styles.label}>{t('cacheMemory.cacheFirst', 'Cache before playback')}</span>
            <span className={styles.help}>{t('cacheMemory.cacheFirstHelp', 'Play renders the range first, then plays every frame on time. Off: play at once and skip frames that are not ready.')}</span>
          </span>
          <Switch checked={cacheBeforePlayback} onChange={(e) => setPref('cacheBeforePlayback', e.currentTarget.checked)} aria-label={t('cacheMemory.cacheFirst', 'Cache before playback')} />
        </label>
        <div className={styles.field}>
          <span className={styles.label}>{t('inspector.preview.resolution', 'Resolution')}</span>
          <Segmented
            size="sm"
            fullWidth
            aria-label={t('inspector.preview.resolution', 'Resolution')}
            options={resolutions()}
            value={resolutionChoiceOf({ adaptive, resolution })}
            onChange={setResolutionChoice}
          />
        </div>
        <div className={styles.fieldInline}>
          <span className={styles.label}>{t('cacheMemory.ramBudget', 'RAM for previews')}</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.select}>
                <span data-numeric>
                  {ramCacheGb === 0
                    ? t('cacheMemory.ramBudget.autoShort', 'Auto{budget}', { budget: r?.ramBudget ? ` · ${formatBytes(r.ramBudget)}` : '' })
                    : `${ramCacheGb} GB`}
                </span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={ramBudgetItems(physical, ramCacheGb)}
          />
        </div>
      </section>
    </>
  );
}

// ── Location ──────────────────────────────────────────────────────────

interface Drive {
  root: string;
  freeBytes: number;
  totalBytes: number;
}

function useDrives(): { drives: Drive[] | null; reload: () => void } {
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const ask = window.motionEditor?.diskCache?.drives;
    if (!ask) {
      setDrives([]);
      return;
    }
    void ask().then((d) => { if (alive) setDrives(d); }, () => { if (alive) setDrives([]); });
    return () => { alive = false; };
  }, [tick]);
  return { drives, reload: () => setTick((n) => n + 1) };
}

/** The drive a folder lives on: the longest root it starts with (case-blind on Windows). */
function driveOf(folder: string | null, drives: readonly Drive[]): Drive | null {
  if (!folder) return null;
  const norm = (p: string): string => (/^[a-z]:/i.test(p) ? p.toLowerCase().replace(/\//g, '\\') : p);
  const f = norm(folder);
  let best: Drive | null = null;
  for (const d of drives) {
    if (f.startsWith(norm(d.root)) && (!best || d.root.length > best.root.length)) best = d;
  }
  return best;
}

/** A cache folder on `root`: the app's own folder name, so only its files are ever touched. */
function folderOnDrive(root: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.endsWith(sep) ? root : root + sep}Premation Disk Cache`;
}

/** Read cost of one 1920×1080 frame from the measured ms per megapixel. */
function frameReadMs(msPerMp: number): number {
  return msPerMp * (1920 * 1080) / 1e6;
}

function Location({ readout }: { readout: MemoryReadout | null }): JSX.Element {
  const enabled = usePreferenceStore((s) => s.diskCacheEnabled);
  const folder = usePreferenceStore((s) => s.diskCacheFolder);
  const maxGb = usePreferenceStore((s) => s.diskCacheMaxGb);
  const setPref = usePreferenceStore((s) => s.set);
  const { drives, reload } = useDrives();
  const comp = useActiveMirrorComp();
  const fps = compFps(comp) || 30;

  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void defaultDiskCacheFolder().then((f) => { if (alive) setFallback(f); });
    return () => { alive = false; };
  }, []);
  const shown = folder ?? fallback;
  const current = useMemo(() => driveOf(shown, drives ?? []), [shown, drives]);

  const [sizeDraft, setSizeDraft] = useState(String(maxGb));
  useEffect(() => setSizeDraft(String(maxGb)), [maxGb]);
  const commitSize = (raw: string): void => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setSizeDraft(String(maxGb));
      return;
    }
    setPref('diskCacheMaxGb', Math.min(DISK_CACHE_MAX_GB, Math.max(DISK_CACHE_MIN_GB, n)));
  };

  const pick = window.motionEditor?.shell?.pickFolder;
  const reveal = window.motionEditor?.shell?.revealInFolder;
  const chooseFolder = async (): Promise<void> => {
    if (!pick) return;
    const dir = await pick().catch(() => null);
    if (dir) setPref('diskCacheFolder', dir);
  };

  const readMs = readout?.diskReadMsPerMp ? frameReadMs(readout.diskReadMsPerMp) : null;
  const frameBudgetMs = 1000 / fps;

  return (
    <>
      <section className={styles.section} aria-label={t('cacheMemory.diskFolder', 'Disk cache folder')}>
        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            <span className={styles.label}>{t('settings.diskCache.title', 'Disk Cache')}</span>
            <span className={styles.help}>{t('cacheMemory.diskHelp', 'Keeps rendered frames on disk too, so they come back after video memory lets go of them and in later sessions.')}</span>
          </span>
          <Switch checked={enabled} onChange={(e) => setPref('diskCacheEnabled', e.currentTarget.checked)} aria-label={t('settings.diskCache.enable', 'Enable Disk Cache')} />
        </label>
        <code className={styles.path} title={shown ?? undefined}>{shown ?? t('cacheMemory.noFolder', 'No folder (desktop app only)')}</code>
        <div className={styles.actions}>
          {pick && (
            <Button variant="secondary" size="sm" icon={<Icon name="folder-open" size="sm" />} disabled={!enabled} onClick={() => void chooseFolder()}>
              {t('settings.diskCache.chooseFolder', 'Choose Folder…')}
            </Button>
          )}
          {folder && (
            <Button variant="secondary" size="sm" disabled={!enabled} onClick={() => setPref('diskCacheFolder', null)}>
              {t('settings.diskCache.useDefault', 'Use Default')}
            </Button>
          )}
          {reveal && shown && (
            <Button variant="secondary" size="sm" onClick={() => void reveal(shown)}>
              {t('cacheMemory.reveal', 'Show in Folder')}
            </Button>
          )}
        </div>
        <div className={styles.fieldInline}>
          <span className={styles.label}>{t('settings.diskCache.maxSize', 'Maximum Disk Cache Size')}</span>
          <Input
            size="sm"
            type="number"
            min={DISK_CACHE_MIN_GB}
            max={DISK_CACHE_MAX_GB}
            step={1}
            value={sizeDraft}
            disabled={!enabled}
            onChange={(e) => setSizeDraft(e.currentTarget.value)}
            onBlur={(e) => commitSize(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSize(e.currentTarget.value); }}
            suffix="GB"
            className={styles.sizeInput}
            aria-label={t('settings.diskCache.maxSizeAria', 'Maximum disk cache size in gigabytes')}
            data-enter-safe=""
          />
        </div>
        {current && enabled && current.freeBytes < maxGb * GiB && (
          <span className={styles.warn} role="note">
            {t('cacheMemory.notEnoughSpace', 'Only {free} free on this drive — the cache stops growing there before {max} GB.', { free: formatBytes(current.freeBytes), max: maxGb })}
          </span>
        )}
        <div className={styles.rowHead}>
          <span className={styles.label}>{t('cacheMemory.readSpeed', 'Read-back speed')}</span>
          <span className={styles.value} data-numeric data-tone={readMs !== null && readMs > frameBudgetMs ? 'warn' : undefined}>
            {readMs !== null
              ? t('cacheMemory.readSpeedValue', '{ms} ms per 1080p frame', { ms: readMs.toFixed(readMs < 10 ? 1 : 0) })
              : t('cacheMemory.readSpeedPending', 'Measured once frames are on disk')}
          </span>
        </div>
        {readMs !== null && readMs > frameBudgetMs && (
          <span className={styles.warn} role="note">
            {t('cacheMemory.slowDrive', 'Slower than one frame at {fps} fps ({budget} ms): frames from this folder cannot play in real time. A local SSD is best.', { fps: Math.round(fps), budget: frameBudgetMs.toFixed(0) })}
          </span>
        )}
      </section>

      <section className={styles.section} aria-label={t('cacheMemory.drives', 'Drives')}>
        <div className={styles.rowHead}>
          <span className={styles.group}>{t('cacheMemory.drives', 'Drives')}</span>
          <Button variant="ghost" size="xs" iconOnly icon={<Icon name="refresh" size="sm" />} title={t('cacheMemory.drivesRefresh', 'Refresh drives')} onClick={reload}>
            {t('cacheMemory.drivesRefresh', 'Refresh drives')}
          </Button>
        </div>
        {drives === null && <span className={styles.help}>{t('cacheMemory.drivesLoading', 'Reading drives…')}</span>}
        {drives !== null && drives.length === 0 && <span className={styles.help}>{t('cacheMemory.drivesNone', 'Drive information is available in the desktop app.')}</span>}
        {drives?.map((d) => {
          const isCurrent = current?.root === d.root;
          const usedPct = d.totalBytes > 0 ? ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100 : 0;
          return (
            <div key={d.root} className={cn(styles.drive, isCurrent && styles.driveCurrent)}>
              <div className={styles.tierHead}>
                <Icon name="box" size="sm" />
                <span className={styles.label}>{d.root}</span>
                {isCurrent && <span className={styles.badge}>{t('cacheMemory.inUse', 'In use')}</span>}
                <span className={styles.value} data-numeric>
                  {t('cacheMemory.driveFree', '{free} free of {total}', { free: formatBytes(d.freeBytes), total: formatBytes(d.totalBytes) })}
                </span>
              </div>
              <div className={styles.track} aria-hidden>
                <span className={styles.fill} data-tone="drive" style={{ width: `${usedPct}%` }} />
              </div>
              {!isCurrent && (
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={!enabled || d.freeBytes < DISK_CACHE_MIN_GB * GiB}
                    onClick={() => setPref('diskCacheFolder', folderOnDrive(d.root))}
                  >
                    {t('cacheMemory.useDrive', 'Use this drive')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}

// ── Diagnostics ───────────────────────────────────────────────────────

/** The chart's two lines as SVG points over a 30-minute window. */
function chartPoints(history: readonly MemorySample[], pick: (p: MemorySample) => number, w: number, h: number, max: number, now: number): string {
  const span = 30 * 60_000;
  return history
    .map((p) => {
      const x = Math.max(0, Math.min(w, w - ((now - p.at) / span) * w));
      const y = h - (Math.min(max, pick(p)) / max) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function eventText(e: MemoryEvent): string {
  switch (e.kind) {
    case 'restarted':
      return e.cause === 'requested'
        ? t('cacheMemory.event.restartedRequested', 'Engine restarted on request. The project stayed open.')
        : e.cause === 'hang'
          ? t('cacheMemory.event.restartedHang', 'Engine stopped answering and was restarted. The project stayed open.')
          : t('cacheMemory.event.restartedCrash', 'Engine crashed and was restarted. The project stayed open.');
    case 'pressure':
      return t('cacheMemory.event.pressure', 'Memory got tight — the oldest frames make way first.');
    case 'growing':
      return t('cacheMemory.event.growing', 'Engine memory outside the caches kept growing.');
    case 'recovered':
      return t('cacheMemory.event.recovered', 'Memory back to normal.');
  }
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Diagnostics({ mem }: { mem: EngineMemorySnapshot }): JSX.Element {
  const comp = useActiveMirrorComp();
  const fps = compFps(comp) || 30;
  const budgetMs = 1000 / fps;
  const s = mem.stats;
  const r = mem.readout;
  const [restarting, setRestarting] = useState(false);
  const canRestart = typeof window.motionEditor?.engine?.restartToFreeMemory === 'function';

  const timings = s
    ? [
      { id: 'build', label: t('cacheMemory.timing.build', 'Frame build (scene, expressions)'), ms: s.cpuFrameMs },
      { id: 'gpu', label: t('cacheMemory.timing.gpu', 'GPU draw (layers, effects)'), ms: s.gpuFrameMs },
      { id: 'decode', label: t('cacheMemory.timing.decode', 'Footage decode'), ms: s.decodeMs },
    ]
    : [];
  const worst = Math.max(budgetMs, ...timings.map((x) => x.ms));

  const now = mem.history.length ? mem.history[mem.history.length - 1]!.at : Date.now();
  const chartMax = Math.max(GiB, ...mem.history.map((p) => p.engineBytes)) * 1.1;
  const W = 300;
  const H = 96;

  const restart = async (): Promise<void> => {
    const ok = await customConfirm(
      t('cacheMemory.restartTitle', 'Restart the engine?'),
      t('cacheMemory.restartBody', 'The engine starts again with its memory freed. Your project stays open and nothing is lost; frames in RAM and video memory are rendered again as you play (frames on disk stay).'),
      { confirmLabel: t('cacheMemory.restartConfirm', 'Restart Engine') },
    );
    if (!ok) return;
    setRestarting(true);
    try {
      await window.motionEditor?.engine?.restartToFreeMemory?.();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <section className={styles.section} aria-label={t('cacheMemory.frameCost', 'This frame')}>
        <div className={styles.rowHead}>
          <span className={styles.group}>{t('cacheMemory.frameCost', 'This frame')}</span>
          <span className={styles.helpRight}>
            {t('cacheMemory.frameBudget', '{ms} ms per frame at {fps} fps', { ms: budgetMs.toFixed(0), fps: Math.round(fps) })}
          </span>
        </div>
        {!s && <span className={styles.help}>{t('cacheMemory.waiting', 'Waiting for the engine…')}</span>}
        {timings.map((x) => (
          <div key={x.id} className={styles.tier}>
            <div className={styles.tierHead}>
              <span className={styles.label}>{x.label}</span>
              <span className={styles.value} data-numeric data-tone={x.ms > budgetMs ? 'warn' : undefined}>{`${x.ms.toFixed(x.ms < 10 ? 1 : 0)} ms`}</span>
            </div>
            <div className={styles.track} aria-hidden>
              <span className={styles.fill} data-tone={x.ms > budgetMs ? 'warn' : 'time'} style={{ width: `${Math.min(100, (x.ms / worst) * 100)}%` }} />
              <span className={styles.budgetMark} style={{ left: `${Math.min(100, (budgetMs / worst) * 100)}%` }} />
            </div>
          </div>
        ))}
        {s && s.droppedFrames > 0 && (
          <span className={styles.help}>{t('cacheMemory.dropped', '{n} frames dropped in playback this session.', { n: s.droppedFrames })}</span>
        )}
      </section>

      <HeaviestLayers stats={s} budgetMs={budgetMs} />

      <section className={styles.section} aria-label={t('cacheMemory.engineMemory', 'Engine memory')}>
        <div className={styles.rowHead}>
          <span className={styles.group}>{t('cacheMemory.engineMemory', 'Engine memory')}</span>
          <span className={styles.value} data-numeric>{r?.engineBytes ? formatBytes(r.engineBytes) : '—'}</span>
        </div>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('cacheMemory.chartAria', 'Engine memory and RAM previews over the last 30 minutes')}
        >
          <polyline className={styles.lineRam} points={chartPoints(mem.history, (p) => p.ramTierBytes, W, H, chartMax, now)} />
          <polyline className={styles.lineTotal} data-tone={mem.health.kind === 'growing' ? 'bad' : undefined} points={chartPoints(mem.history, (p) => p.engineBytes, W, H, chartMax, now)} />
        </svg>
        <div className={styles.legend}>
          <span><span className={styles.legendKey} data-tone="total" aria-hidden />{t('cacheMemory.legendTotal', 'Engine total')}</span>
          <span><span className={styles.legendKey} data-tone="ram" aria-hidden />{t('cacheMemory.legendRam', 'RAM previews')}</span>
          <span className={styles.legendSpan}>{t('cacheMemory.legendSpan', 'last 30 min')}</span>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.help}>{t('cacheMemory.stat.ram', 'RAM previews')}</span>
            <span className={styles.value} data-numeric>{formatBytes(r?.ramBytes ?? 0)}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.help}>{t('cacheMemory.stat.outside', 'Outside the caches')}</span>
            <span className={styles.value} data-numeric data-tone={mem.health.kind === 'growing' ? 'bad' : undefined}>
              {r?.outsideCachesBytes !== null && r?.outsideCachesBytes !== undefined ? formatBytes(r.outsideCachesBytes) : '—'}
              {mem.health.kind === 'growing' ? ' ↑' : ''}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.help}>{t('cacheMemory.stat.machineFree', 'Free on this machine')}</span>
            <span className={styles.value} data-numeric>{r?.availableBytes ? formatBytes(r.availableBytes) : '—'}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.help}>{t('cacheMemory.stat.installed', 'Installed')}</span>
            <span className={styles.value} data-numeric>{r?.physicalBytes ? formatBytes(r.physicalBytes) : '—'}</span>
          </div>
        </div>
        <span className={styles.help}>
          {t('cacheMemory.outsideHelp', 'Outside the caches is the scene, layer rasters, footage decoders, fonts and plugins. If it keeps climbing while you work, restart the engine below and send a diagnostics report.')}
        </span>
      </section>

      <section className={styles.section} aria-label={t('cacheMemory.events', 'This session')}>
        <span className={styles.group}>{t('cacheMemory.events', 'This session')}</span>
        {mem.events.length === 0 && <span className={styles.help}>{t('cacheMemory.noEvents', 'No restarts or memory warnings.')}</span>}
        {mem.events.length > 0 && (
          <ul className={styles.events}>
            {mem.events.map((e) => (
              <li key={`${e.at}-${e.kind}`}>
                <span className={styles.eventTime} data-numeric>{clock(e.at)}</span>
                <span>{eventText(e)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.actions}>
          {canRestart && (
            <Button variant="secondary" size="sm" icon={<Icon name="rotate-cw" size="sm" />} loading={restarting} onClick={() => void restart()}>
              {t('cacheMemory.restart', 'Restart Engine to Free Memory')}
            </Button>
          )}
          {window.motionEditor?.diag?.copyReport && (
            <Button variant="secondary" size="sm" icon={<Icon name="copy" size="sm" />} onClick={() => void window.motionEditor?.diag?.copyReport?.()}>
              {t('cacheMemory.copyReport', 'Copy Diagnostics Report')}
            </Button>
          )}
          {window.motionEditor?.diag?.openLogs && (
            <Button variant="secondary" size="sm" icon={<Icon name="folder-open" size="sm" />} onClick={() => void window.motionEditor?.diag?.openLogs?.()}>
              {t('cacheMemory.openLogs', 'Open Logs Folder')}
            </Button>
          )}
        </div>
      </section>
    </>
  );
}

export default CacheMemoryPanel;
