/**
 * The supervisor queue's rows: run order, the restart promise, and the
 * priority controls the Render Queue panel shows on waiting jobs.
 */

let openProject: { id: string; name: string; path: string | null } | null = null;
jest.mock('@core/export/renderProject', () => ({
  ...jest.requireActual('@core/export/renderProject'),
  currentProjectRef: () => openProject,
}));

import { fireEvent, render, screen } from '@testing-library/react';
import { ExportQueueList, orderForDisplay, SUPERVISOR_RESTART_NOTE } from './ExportQueueList';
import { resetExportQueueForTest, useExportQueueStore } from '@stores/exportQueueStore';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';

function record(over: Partial<ExportJobRecord> = {}): ExportJobRecord {
  return {
    id: 'a',
    status: 'queued',
    priority: 0,
    createdAt: 1,
    attempts: 0,
    spec: { projectPath: 'C:\\s\\p.motion', outPath: 'C:\\o\\x.mp4', format: 'mp4', label: 'Comp → x.mp4', totalFrames: 48 },
    progress: { fraction: 0, frame: 0, totalFrames: 48, fps: null, etaSec: null },
    ...over,
  };
}

beforeEach(() => {
  openProject = null;
  resetExportQueueForTest();
});

describe('orderForDisplay', () => {
  it('running, then waiting in run order (priority, then first-come), then finished newest first', () => {
    const jobs = [
      record({ id: 'done-old', status: 'completed', createdAt: 1 }),
      record({ id: 'wait-late', createdAt: 5 }),
      record({ id: 'done-new', status: 'failed', createdAt: 9 }),
      record({ id: 'wait-early', createdAt: 3 }),
      record({ id: 'wait-urgent', createdAt: 8, priority: 2 }),
      record({ id: 'running', status: 'rendering', createdAt: 2 }),
    ];
    expect(orderForDisplay(jobs).map((j) => j.id)).toEqual([
      'running', 'wait-urgent', 'wait-early', 'wait-late', 'done-new', 'done-old',
    ]);
  });
});

describe('ExportQueueList', () => {
  it('renders nothing with an empty queue', () => {
    const { container } = render(<ExportQueueList />);
    expect(container.textContent).toBe('');
  });

  it('says an interrupted render restarts', () => {
    useExportQueueStore.setState({ jobs: [record()] });
    render(<ExportQueueList />);
    expect(screen.getByText(SUPERVISOR_RESTART_NOTE)).toBeTruthy();
    expect(SUPERVISOR_RESTART_NOTE).toMatch(/starts again from the first frame/);
  });

  it('priority controls only where asked, only on waiting jobs, and they step the priority', () => {
    const setPriority = jest.fn(async () => undefined);
    useExportQueueStore.setState({
      jobs: [record({ id: 'w', priority: 1 }), record({ id: 'r', status: 'rendering', createdAt: 0 })],
      setPriority,
    });
    const { rerender } = render(<ExportQueueList />);
    expect(screen.queryByRole('button', { name: /raise priority/i })).toBeNull();

    rerender(<ExportQueueList priorityControls />);
    // One waiting job → one pair; the rendering job has none.
    const up = screen.getAllByRole('button', { name: /raise priority/i });
    const down = screen.getAllByRole('button', { name: /lower priority/i });
    expect(up).toHaveLength(1);
    expect(down).toHaveLength(1);
    fireEvent.click(up[0]!);
    fireEvent.click(down[0]!);
    expect(setPriority).toHaveBeenNthCalledWith(1, 'w', 2);
    expect(setPriority).toHaveBeenNthCalledWith(2, 'w', 0);
    expect(screen.getByText(/priority \+1/)).toBeTruthy();
  });

  it("shows only the open project's renders: the dashboard is where all of them are", () => {
    openProject = { id: 's1', name: 'Mine', path: 'cloud-mine' };
    const spec = record().spec;
    useExportQueueStore.setState({
      jobs: [
        record({ id: 'mine', spec: { ...spec, label: 'Mine → a.mp4', projectKey: 'cloud-mine' } }),
        record({ id: 'other', spec: { ...spec, label: 'Other → b.mp4', projectKey: 'cloud-other' } }),
        record({ id: 'old', spec: { ...spec, label: 'Old → c.mp4' } }),
      ],
    });
    render(<ExportQueueList />);
    expect(screen.getByText('Mine → a.mp4')).toBeTruthy();
    expect(screen.queryByText('Other → b.mp4')).toBeNull();
    expect(screen.queryByText('Old → c.mp4')).toBeNull();
  });

  it("renders nothing when every queued job is another project's", () => {
    openProject = { id: 's1', name: 'Mine', path: 'cloud-mine' };
    useExportQueueStore.setState({ jobs: [record({ spec: { ...record().spec, projectKey: 'cloud-other' } })] });
    const { container } = render(<ExportQueueList />);
    expect(container.textContent).toBe('');
  });

  it('finished jobs offer Retry (not when completed) and Remove', () => {
    useExportQueueStore.setState({ jobs: [record({ id: 'f', status: 'failed', error: 'boom' }), record({ id: 'c', status: 'completed' })] });
    render(<ExportQueueList priorityControls />);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /raise priority/i })).toBeNull();
  });
});
