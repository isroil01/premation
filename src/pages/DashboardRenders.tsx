/**
 * Renders — every render on this computer, from every project.
 *
 * The list is main's export queue (`exportQueueStore`), the same records the
 * editor's Render Queue and Export tabs read, but not narrowed to one project:
 * those tabs show the open project's renders and this page shows all of them,
 * running, waiting and finished.
 *
 * A new render starts from a project: Render opens it in the editor with the
 * Export dialog up, because a render is snapshotted from the open document.
 */

import { useEffect, useMemo, useState } from 'react';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { api, type ProjectSummary } from '@core/api/client';
import { cloudProjectIdOf } from '@core/export/renderProject';
import { describeProgress, isFinishedStatus, type ExportJobRecord } from '@core/export/exportSupervisorClient';
import { displayProjectName, looksLikeFilePath } from '@core/project/projectName';
import { t } from '@core/i18n';
import { orderForDisplay } from '@layout/Export/ExportQueueList';
import { failureAction, useExportQueueStore } from '@stores/exportQueueStore';
import { useRenderQueueStore, type RenderJob } from '@stores/renderQueueStore';
import { useUIStore } from '@stores/uiStore';
import pageStyles from './DashboardPage.module.css';
import styles from './DashboardRenders.module.css';

/** How many projects the Render menu lists before pointing at the Projects page. */
const RENDER_MENU_PROJECTS = 10;

export interface DashboardRendersProps {
  /** The loaded page of the library: the Render menu, and names without a fetch. */
  projects: ReadonlyArray<ProjectSummary>;
  /** The cloud render history is still loading, or has rows of its own under this list. */
  cloudLoading: boolean;
  hasCloudRenders: boolean;
  onRenderProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
  onBrowseProjects: () => void;
  timeAgo: (iso: string) => string;
}

/**
 * Names for the cloud projects in the list. A job holds only the project's id,
 * so a rename shows here and a project off the loaded page is asked for once.
 */
function useProjectNames(keys: ReadonlyArray<string>, projects: ReadonlyArray<ProjectSummary>): ReadonlyMap<string, string> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, string>>(new Map());
  const joined = [...new Set(keys)].sort().join('\n');
  useEffect(() => {
    const known = new Set(projects.map((p) => p.id));
    const missing = joined.split('\n').filter((id) => id && !known.has(id) && !fetched.has(id));
    if (missing.length === 0) return undefined;
    let cancelled = false;
    void Promise.all(missing.map(async (id): Promise<[string, string]> => {
      try {
        return [id, (await api.getProject(id)).name];
      } catch {
        return [id, t('dashboard.renders.deletedProject', 'Deleted project')];
      }
    })).then((rows) => {
      if (!cancelled) setFetched((prev) => new Map([...prev, ...rows]));
    });
    return () => { cancelled = true; };
  }, [joined, projects, fetched]);
  return useMemo(() => {
    const names = new Map(fetched);
    for (const p of projects) names.set(p.id, p.name);
    return names;
  }, [fetched, projects]);
}

function projectLabel(key: string | undefined, names: ReadonlyMap<string, string>): string {
  if (!key) return t('dashboard.renders.earlierRender', 'Earlier render');
  if (looksLikeFilePath(key)) return displayProjectName(key);
  return names.get(key) ?? t('dashboard.renders.unsavedProject', 'Unsaved project');
}

/** A desktop verb on a delivered file, saying so when the file has gone. */
async function openDelivered(job: ExportJobRecord): Promise<void> {
  const res = await window.motionEditor?.shell?.openFile?.(job.spec.outPath);
  if (res && !res.ok) reportMissing(job);
}

async function revealDelivered(job: ExportJobRecord): Promise<void> {
  const found = await window.motionEditor?.shell?.revealInFolder?.(job.spec.outPath);
  if (found === false) reportMissing(job);
}

function reportMissing(job: ExportJobRecord): void {
  useUIStore.getState().notify({
    level: 'warning',
    message: t('dashboard.renders.fileMissing', 'That file is not there any more: {path}', { path: job.spec.outPath }),
    durationMs: 6000,
  });
}

function statusBadge(status: ExportJobRecord['status']): string {
  switch (status) {
    case 'completed': return pageStyles.badgeSuccess ?? '';
    case 'failed': return pageStyles.badgeDanger ?? '';
    case 'preparing':
    case 'rendering':
    case 'encoding': return pageStyles.badgeProgress ?? '';
    default: return pageStyles.badgeDefault ?? '';
  }
}

function statusLabel(status: ExportJobRecord['status']): string {
  switch (status) {
    case 'queued': return t('dashboard.renders.status.queued', 'Queued');
    case 'completed': return t('dashboard.renders.status.completed', 'Done');
    case 'failed': return t('dashboard.renders.status.failed', 'Failed');
    case 'cancelled': return t('dashboard.renders.status.canceled', 'Cancelled');
    default: return t('dashboard.renders.status.running', 'Rendering');
  }
}

function JobRow({ job, project, onRenderProject, onOpenProject, timeAgo }: {
  job: ExportJobRecord;
  project: string;
} & Pick<DashboardRendersProps, 'onRenderProject' | 'onOpenProject' | 'timeAgo'>): JSX.Element {
  const cancel = useExportQueueStore((s) => s.cancel);
  const retry = useExportQueueStore((s) => s.retry);
  const remove = useExportQueueStore((s) => s.remove);
  const finished = isFinishedStatus(job.status);
  const waiting = job.status === 'queued';
  const running = !finished && !waiting;
  const pct = Math.round(job.progress.fraction * 100);
  const cloudId = cloudProjectIdOf(job.spec.projectKey);
  const size = job.spec.width && job.spec.height ? ` · ${job.spec.width}×${job.spec.height}` : '';

  const menu: DropdownItem[] = [];
  if (job.status === 'completed') {
    menu.push({ type: 'item', id: 'reveal', label: t('dashboard.renders.showInFolder', 'Show in folder'), icon: 'folder', onSelect: () => { void revealDelivered(job); } });
  }
  if (cloudId) {
    menu.push(
      { type: 'item', id: 'render', label: t('dashboard.renders.renderAgain', 'Render again…'), icon: 'export', onSelect: () => onRenderProject(cloudId) },
      { type: 'item', id: 'open', label: t('dashboard.renders.openProject', 'Open project'), icon: 'folder', onSelect: () => onOpenProject(cloudId) },
    );
  }
  if (finished) {
    menu.push({ type: 'item', id: 'remove', label: t('dashboard.renders.remove', 'Remove from list'), icon: 'trash', onSelect: () => { void remove(job.id); } });
  }

  return (
    <tr data-status={job.status}>
      <td>
        <div className={styles.jobName}>
          <span className={styles.project} title={project}>{project}</span>
          <span className={styles.output} title={job.spec.outPath}>{job.spec.label}</span>
        </div>
      </td>
      <td className={pageStyles.monoCell}>{job.spec.format.toUpperCase()}{size}</td>
      <td>
        {running ? (
          <div className={pageStyles.progressCellWrapper}>
            <div className={pageStyles.progressBar}>
              <div className={pageStyles.progressFill} style={{ '--fill': Math.min(1, job.progress.fraction) } as React.CSSProperties} />
            </div>
            <span className={pageStyles.progressText}>{pct}%</span>
          </div>
        ) : (
          <span className={pageStyles.progressIdle}>—</span>
        )}
      </td>
      <td>
        <span className={`${pageStyles.badge} ${statusBadge(job.status)}`} title={describeProgress(job)}>
          {running && <span className={pageStyles.pulseDot} />}
          {statusLabel(job.status)}
        </span>
        {job.status === 'failed' && job.error && <span className={pageStyles.jobError} title={job.error}>{job.error}</span>}
      </td>
      <td className={pageStyles.monoCell}>{timeAgo(new Date(job.createdAt).toISOString())}</td>
      <td>
        <div className={styles.actions}>
          {!finished && (
            <button type="button" className={pageStyles.actionBtn} title={t('dashboard.renders.cancel', 'Cancel render')} onClick={() => void cancel(job.id)}>
              <Icon name="close" size="md" />
            </button>
          )}
          {job.status === 'completed' && (
            <button type="button" className={styles.rowBtn} title={job.spec.outPath} onClick={() => void openDelivered(job)}>
              <Icon name="play" size="sm" />
              <span>{t('dashboard.renders.openFile', 'Open file')}</span>
            </button>
          )}
          {job.errorCode === 'ffmpeg-unavailable' ? (
            <button type="button" className={styles.rowBtn} title={t('export.queue.fixTitle', 'Repair video export, then render this again')} onClick={() => failureAction(job).action?.onSelect()}>
              <span>{t('export.queue.fix', 'Fix')}</span>
            </button>
          ) : (job.status === 'failed' || job.status === 'cancelled') && (
            <button type="button" className={styles.rowBtn} title={t('export.queue.retryTitle', 'Render this export again, from the first frame')} onClick={() => void retry(job.id)}>
              <Icon name="loop" size="sm" />
              <span>{t('export.queue.retry', 'Retry')}</span>
            </button>
          )}
          {menu.length > 0 && (
            <Dropdown
              placement="bottom-end"
              items={menu}
              trigger={
                <button
                  type="button"
                  className={pageStyles.moreBtn}
                  title={t('dashboard.projects.more', 'More')}
                  aria-label={t('dashboard.renders.actionsFor', 'Actions for {name}', { name: job.spec.label })}
                >
                  <Icon name="more-horizontal" size="md" />
                </button>
              }
            />
          )}
        </div>
      </td>
    </tr>
  );
}

/** A job added to the window's queue and not handed to main yet: it needs its project open. */
function PendingRow({ job, project, onOpenProject }: {
  job: RenderJob;
  project: string;
  onOpenProject: (projectId: string) => void;
}): JSX.Element {
  const removeJob = useRenderQueueStore((s) => s.removeJob);
  const cloudId = cloudProjectIdOf(job.projectKey);
  return (
    <tr data-status="pending">
      <td>
        <div className={styles.jobName}>
          <span className={styles.project} title={project}>{project}</span>
          <span className={styles.output} title={job.outputPath}>{job.compositionName} → {job.outputPath}</span>
        </div>
      </td>
      <td className={pageStyles.monoCell}>{job.format.toUpperCase()} · {job.width}×{job.height}</td>
      <td><span className={pageStyles.progressIdle}>—</span></td>
      <td>
        <span className={`${pageStyles.badge} ${pageStyles.badgeDefault}`}>{t('dashboard.renders.notStarted', 'Not started')}</span>
      </td>
      <td className={pageStyles.monoCell}>—</td>
      <td>
        <div className={styles.actions}>
          {cloudId && (
            <button type="button" className={styles.rowBtn} title={t('dashboard.renders.pendingHint', 'Open the project and press Render in its Render Queue tab')} onClick={() => onOpenProject(cloudId)}>
              <span>{t('dashboard.renders.openProject', 'Open project')}</span>
            </button>
          )}
          <button type="button" className={pageStyles.actionBtn} title={t('renderQueue.row.removeTitle', 'Remove job')} onClick={() => removeJob(job.id)}>
            <Icon name="close" size="md" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export function DashboardRenders({
  projects,
  cloudLoading,
  hasCloudRenders,
  onRenderProject,
  onOpenProject,
  onBrowseProjects,
  timeAgo,
}: DashboardRendersProps): JSX.Element {
  const jobs = useExportQueueStore((s) => s.jobs);
  const connect = useExportQueueStore((s) => s.connect);
  const remove = useExportQueueStore((s) => s.remove);
  const pending = useRenderQueueStore((s) => s.jobs);
  const restorePending = useRenderQueueStore((s) => s.restoreFromLastSession);
  useEffect(() => {
    void connect();
    void restorePending();
  }, [connect, restorePending]);

  const ordered = useMemo(() => orderForDisplay(jobs), [jobs]);
  const cloudIds = useMemo(
    () => [...jobs.map((j) => j.spec.projectKey), ...pending.map((j) => j.projectKey)]
      .map(cloudProjectIdOf)
      .filter((id): id is string => id !== null),
    [jobs, pending],
  );
  const names = useProjectNames(cloudIds, projects);

  const live = jobs.filter((j) => !isFinishedStatus(j.status)).length;
  const done = jobs.filter((j) => j.status === 'completed');
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const total = jobs.length + pending.length;
  const summary = [
    live > 0 ? t('dashboard.renders.summaryActive', '{n} in progress', { n: live }) : '',
    done.length > 0 ? t('renderQueue.summary.done', '{n} done', { n: done.length }) : '',
    failed > 0 ? t('renderQueue.summary.failed', '{n} failed', { n: failed }) : '',
  ].filter(Boolean).join(' · ');

  const renderMenu = (): DropdownItem[] => [
    { type: 'label', label: t('dashboard.renders.pickProject', 'Choose a project to render') },
    ...projects.slice(0, RENDER_MENU_PROJECTS).map((p): DropdownItem => ({
      type: 'item',
      id: `render-${p.id}`,
      label: p.name,
      icon: 'video',
      onSelect: () => onRenderProject(p.id),
    })),
    { type: 'separator' },
    { type: 'item', id: 'all-projects', label: t('dashboard.renders.allProjects', 'All projects…'), icon: 'folder', onSelect: onBrowseProjects },
  ];

  return (
    <div className={pageStyles.tableCard} data-dashboard-renders="">
      <div className={styles.toolbar}>
        <span className={styles.summary}>{summary}</span>
        <button
          type="button"
          className={pageStyles.btnSecondary}
          disabled={done.length === 0}
          title={t('renderQueue.clearDone.title', 'Remove finished items from the list')}
          onClick={() => { for (const j of done) void remove(j.id); }}
        >
          <span>{t('renderQueue.clearDone.button', 'Clear done')}</span>
        </button>
        <Dropdown
          placement="bottom-end"
          items={renderMenu}
          trigger={
            <button type="button" className={pageStyles.btnPrimary}>
              <Icon name="export" size="md" />
              <span>{t('dashboard.renders.render', 'Render')}</span>
            </button>
          }
        />
      </div>

      {total === 0 ? (
        hasCloudRenders ? null : cloudLoading ? (
          <div className={pageStyles.loadingState}>
            <p>{t('dashboard.renders.loading', 'Loading render queue…')}</p>
          </div>
        ) : (
          <div className={pageStyles.emptyState}>
            <Icon name="queue" size={48} className={pageStyles.emptyStateIcon} />
            <h3>{t('dashboard.renders.emptyTitle', 'No renders in queue')}</h3>
            <p>{t('dashboard.renders.emptyHint', 'Press Render to pick a project. Everything you render, from any project, is listed here.')}</p>
          </div>
        )
      ) : (
        <table className={pageStyles.table}>
          <thead>
            <tr>
              <th>{t('dashboard.renders.colJob', 'Job Name')}</th>
              <th>{t('dashboard.renders.colFormat', 'Format')}</th>
              <th>{t('dashboard.renders.colProgress', 'Progress')}</th>
              <th>{t('dashboard.renders.colStatus', 'Status')}</th>
              <th>{t('dashboard.renders.colCreated', 'Created')}</th>
              <th aria-label={t('dashboard.renders.colActions', 'Actions')} />
            </tr>
          </thead>
          <tbody>
            {ordered.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                project={projectLabel(job.spec.projectKey, names)}
                onRenderProject={onRenderProject}
                onOpenProject={onOpenProject}
                timeAgo={timeAgo}
              />
            ))}
            {pending.map((job) => (
              <PendingRow key={job.id} job={job} project={projectLabel(job.projectKey, names)} onOpenProject={onOpenProject} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
