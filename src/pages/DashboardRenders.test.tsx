/**
 * The dashboard's Renders page lists every project's renders, names the project
 * each came from, and starts new renders from a project.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DashboardRenders, type DashboardRendersProps } from './DashboardRenders';
import { resetExportQueueForTest, useExportQueueStore } from '@stores/exportQueueStore';
import { useRenderQueueStore } from '@stores/renderQueueStore';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';
import type { ProjectSummary } from '@core/api/client';

const getProject = jest.fn(async (id: string) => ({ id, name: `Fetched ${id}` }));
jest.mock('@core/api/client', () => ({
  api: { getProject: (id: string) => getProject(id) },
}));

function job(over: Partial<ExportJobRecord> & { key?: string } = {}): ExportJobRecord {
  const { key, ...rest } = over;
  return {
    id: 'a',
    status: 'completed',
    priority: 0,
    createdAt: 1_700_000_000_000,
    attempts: 0,
    spec: {
      projectPath: 'C:\\s\\p.motion',
      outPath: 'C:\\o\\x.mp4',
      format: 'mp4',
      label: 'Comp → x.mp4',
      totalFrames: 48,
      ...(key ? { projectKey: key } : {}),
    },
    progress: { fraction: 0.5, frame: 24, totalFrames: 48, fps: 12, etaSec: 2 },
    ...rest,
  };
}

function props(over: Partial<DashboardRendersProps> = {}): DashboardRendersProps {
  return {
    projects: [{ id: 'p1', name: 'Launch film' } as ProjectSummary],
    cloudLoading: false,
    hasCloudRenders: false,
    onRenderProject: jest.fn(),
    onOpenProject: jest.fn(),
    onBrowseProjects: jest.fn(),
    timeAgo: () => '1h ago',
    ...over,
  };
}

beforeEach(() => {
  resetExportQueueForTest();
  useRenderQueueStore.setState({ jobs: [], _restored: true });
  getProject.mockClear();
});

it('lists renders from every project, each under its own project name', async () => {
  useExportQueueStore.setState({
    jobs: [
      job({ id: 'a', key: 'p1', status: 'rendering' }),
      job({ id: 'b', key: 'p2' }),
      job({ id: 'c', key: 'C:\\work\\promo.motion' }),
      job({ id: 'd' }),
    ],
  });
  render(<DashboardRenders {...props()} />);
  expect(screen.getByText('Launch film')).toBeTruthy();
  expect(screen.getByText('promo')).toBeTruthy();
  expect(screen.getByText('Earlier render')).toBeTruthy();
  // Off the loaded page: asked for once, by id.
  await waitFor(() => expect(screen.getByText('Fetched p2')).toBeTruthy());
  expect(getProject.mock.calls.map((c) => c[0])).toEqual(['p2']);
  expect(screen.getByText(/1 in progress · 3 done/)).toBeTruthy();
});

it('says so when a project has been deleted, rather than showing nothing', async () => {
  getProject.mockRejectedValueOnce(new Error('404'));
  useExportQueueStore.setState({ jobs: [job({ key: 'gone' })] });
  render(<DashboardRenders {...props()} />);
  await waitFor(() => expect(screen.getByText('Deleted project')).toBeTruthy());
});

it('offers what each state can do: Cancel while live, Open file when done, Retry when it failed', () => {
  const cancel = jest.fn(async () => {});
  const retry = jest.fn(async () => {});
  const openFile = jest.fn(async () => ({ ok: true as const, path: 'C:\\o\\x.mp4' }));
  window.motionEditor = { shell: { openFile } } as unknown as typeof window.motionEditor;
  useExportQueueStore.setState({
    jobs: [
      job({ id: 'live', key: 'p1', status: 'rendering' }),
      job({ id: 'ok', key: 'p1', status: 'completed' }),
      job({ id: 'bad', key: 'p1', status: 'failed', error: 'disk full' }),
    ],
    cancel,
    retry,
  });
  render(<DashboardRenders {...props()} />);
  fireEvent.click(screen.getByTitle('Cancel render'));
  expect(cancel).toHaveBeenCalledWith('live');
  fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
  expect(openFile).toHaveBeenCalledWith('C:\\o\\x.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledWith('bad');
  expect(screen.getByText('disk full')).toBeTruthy();
  delete window.motionEditor;
});

it('Render starts from a project, and an empty page says how', () => {
  const onRenderProject = jest.fn();
  render(<DashboardRenders {...props({ onRenderProject })} />);
  expect(screen.getByText('No renders in queue')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Render' }));
  fireEvent.click(screen.getByText('Launch film'));
  expect(onRenderProject).toHaveBeenCalledWith('p1');
});

it('lists a job waiting in a window queue, which needs its project open to start', () => {
  const onOpenProject = jest.fn();
  useRenderQueueStore.setState({
    jobs: [{
      id: 'rq1', status: 'queued', progress: 0, projectKey: 'p1',
      compositionName: 'Comp 1', outputPath: 'x.mp4', format: 'mp4',
      width: 1920, height: 1080, fps: 30, durationSec: 2, transparent: false,
    } as never],
  });
  render(<DashboardRenders {...props({ onOpenProject })} />);
  expect(screen.getByText('Not started')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open project' }));
  expect(onOpenProject).toHaveBeenCalledWith('p1');
});
