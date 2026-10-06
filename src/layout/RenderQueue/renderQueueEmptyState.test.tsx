/**
 * An empty render queue says what to do about it.
 *
 * The panel used to render one grey line — `No render jobs. Click "Add Comp"`
 * — naming a button that is 200px away in a toolbar the user has not looked
 * at yet. The empty state now carries the action itself, and this pins that
 * the button is really there and really opens the add-job dialog, because an
 * empty state whose primary action does nothing is worse than none.
 */

// The renderer is stubbed at the seam this panel touches. Nothing here
// renders a frame — the subject is what the panel shows when the queue is
// empty — and pulling in the WebGPU/WebGL shader library to assert on a
// sentence would make this test fail for reasons that have nothing to do with
// the queue.
jest.mock('@core/export/exportManager', () => ({ downloadBlob: jest.fn() }));

import { render, screen } from '@testing-library/react';
import { RenderQueuePanel } from './RenderQueuePanel';
import { useRenderQueueStore } from '@stores/renderQueueStore';
import { resetExportQueueForTest, useExportQueueStore } from '@stores/exportQueueStore';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';

beforeEach(() => {
  for (const job of [...useRenderQueueStore.getState().jobs]) {
    useRenderQueueStore.getState().removeJob(job.id);
  }
});

it('shows a quiet empty state that says where items come from, with no add dialog of its own', () => {
  render(<RenderQueuePanel />);

  expect(screen.getAllByText('Nothing queued').length).toBeGreaterThan(0);
  expect(screen.getByText(/Add to Render Queue/)).toBeTruthy();
  // Items are queued from Export; the panel has no "Add Comp" button and no
  // output-module popup inside it any more (owner decision, 2026-10).
  expect(screen.queryByRole('button', { name: /add/i })).toBeNull();
});

/*
  Desktop renders run in main's supervisor, one hidden window per job; the
  panel lists them from exportQueueStore beside any in-window jobs (legacy
  persisted entries, web/hosted, exportInProcess), with the supervisor's own
  verbs and its restart note.
*/
describe('background (supervisor) jobs', () => {
  const bg = (over: Partial<ExportJobRecord> = {}): ExportJobRecord => ({
    id: 'exp-1',
    status: 'rendering',
    priority: 0,
    createdAt: 1,
    attempts: 0,
    spec: { projectPath: 'C:\\j\\p.motion', outPath: 'D:\\out\\Hero.mp4', format: 'mp4', label: 'Hero → Hero.mp4', totalFrames: 48 },
    progress: { fraction: 0.5, frame: 24, totalFrames: 48, fps: 12, etaSec: 2 },
    ...over,
  });

  beforeEach(() => resetExportQueueForTest());
  afterAll(() => resetExportQueueForTest());

  it('lists them instead of the empty state, with frame/fps/ETA and the restart note', () => {
    useExportQueueStore.setState({ jobs: [bg(), bg({ id: 'exp-2', status: 'queued', progress: { fraction: 0, frame: 0, totalFrames: 48, fps: null, etaSec: null } })] });
    render(<RenderQueuePanel />);
    expect(screen.queryByText(/Add to Render Queue/)).toBeNull();
    expect(screen.getByText(/Frame 24 \/ 48 · 12\.0 fps · 0:02 left/)).toBeTruthy();
    expect(screen.getByText(/interrupted render starts again/i)).toBeTruthy();
    // Priority up/down on the waiting one only.
    expect(screen.getAllByRole('button', { name: /raise priority/i })).toHaveLength(1);
    expect(screen.getByText(/2 in background/)).toBeTruthy();
  });

  it('counts them in the summary, clears the finished ones, and Render runs the failed ones again', () => {
    const retry = jest.fn(async () => {});
    const remove = jest.fn(async () => {});
    useExportQueueStore.setState({
      jobs: [
        bg({ id: 'done-1', status: 'completed' }),
        bg({ id: 'done-2', status: 'completed' }),
        bg({ id: 'bad-1', status: 'failed', error: 'premation-engine could not start: spawn premation-engine.exe ENOENT' }),
        bg({ id: 'wait-1', status: 'queued' }),
      ],
      retry,
      remove,
    });
    render(<RenderQueuePanel />);
    // Before: "4 items · 0 queued · 0 done" — only the in-window list was counted.
    expect(screen.getByText(/4 items · 1 queued · 2 done · 1 failed · 1 in background/)).toBeTruthy();

    const clear = screen.getByRole('button', { name: /^Clear done$/ });
    expect((clear as HTMLButtonElement).disabled).toBe(false);
    clear.click();
    expect(remove.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(['done-1', 'done-2']);

    const renderBtn = screen.getByRole('button', { name: /^Render$/ });
    expect((renderBtn as HTMLButtonElement).disabled).toBe(false);
    renderBtn.click();
    expect(retry.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['bad-1']);
  });

  it('shows in-window (legacy) jobs alongside them', () => {
    useExportQueueStore.setState({ jobs: [bg()] });
    useRenderQueueStore.getState().addJob({
      compositionName: 'Legacy comp', outputPath: 'legacy.mp4', format: 'mp4',
      width: 100, height: 100, fps: 24, durationSec: 1, transparent: false,
    });
    render(<RenderQueuePanel />);
    expect(screen.getByText('Legacy comp')).toBeTruthy();
    expect(screen.getByText('Hero → Hero.mp4')).toBeTruthy();
  });
});
