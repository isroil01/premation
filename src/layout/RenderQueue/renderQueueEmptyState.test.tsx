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
jest.mock('@core/export/renderJob', () => ({
  outputExtFor: () => 'mp4',
  renderJobOutput: jest.fn(),
}));

import { render, screen, fireEvent } from '@testing-library/react';
import { RenderQueuePanel } from './RenderQueuePanel';
import { useRenderQueueStore } from '@stores/renderQueueStore';

beforeEach(() => {
  for (const job of [...useRenderQueueStore.getState().jobs]) {
    useRenderQueueStore.getState().removeJob(job.id);
  }
});

it('shows an empty state, with the add action, when nothing is queued', () => {
  render(<RenderQueuePanel />);

  expect(screen.getByText('Nothing queued')).toBeTruthy();

  const add = screen.getByRole('button', { name: /add the current composition/i });
  fireEvent.click(add);

  // The output-module dialog is the panel's own "Add Comp" surface — if the
  // action were inert this would find nothing.
  expect(screen.getByText(/output/i)).toBeTruthy();
});
