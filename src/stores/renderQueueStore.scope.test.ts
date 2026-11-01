/**
 * The pending list is machine-wide but a job renders from the open document, so
 * Render hands over only the open project's jobs; a job for another project
 * waits for that project.
 */

let openProject: { id: string; name: string; path: string | null } | null = null;
jest.mock('@core/export/renderProject', () => ({
  ...jest.requireActual('@core/export/renderProject'),
  currentProjectRef: () => openProject,
  currentProjectKey: () => (openProject ? openProject.path ?? `session:${openProject.id}` : undefined),
}));

import { setRenderQueueSubmitter, useRenderQueueStore, type RenderJob } from './renderQueueStore';

type JobInput = Parameters<ReturnType<typeof useRenderQueueStore.getState>['addJob']>[0];

const job = (over: Partial<RenderJob> = {}): JobInput => ({
  compositionName: 'Comp 1',
  outputPath: 'x.mp4',
  format: 'mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 2,
  transparent: false,
  ...over,
} as JobInput);

afterEach(() => {
  setRenderQueueSubmitter(null);
  useRenderQueueStore.setState({ jobs: [], outputDir: null });
  openProject = null;
});

it('stamps a job with the project it was added in', () => {
  openProject = { id: 's1', name: 'Mine', path: 'cloud-mine' };
  const id = useRenderQueueStore.getState().addJob(job());
  expect(useRenderQueueStore.getState().jobs.find((j) => j.id === id)?.projectKey).toBe('cloud-mine');
});

it("Render hands over this project's jobs and leaves another project's waiting", async () => {
  const store = useRenderQueueStore.getState();
  store.addJob(job({ compositionName: 'Theirs', projectKey: 'cloud-other' }));
  store.addJob(job({ compositionName: 'Older' }));
  openProject = { id: 's1', name: 'Mine', path: 'cloud-mine' };
  store.addJob(job({ compositionName: 'Ours' }));

  const submitted: string[] = [];
  setRenderQueueSubmitter(async (spec) => {
    submitted.push(spec.compositionName);
    return 'exp-1';
  });
  useRenderQueueStore.setState({ outputDir: 'D:\\Renders' });
  store.startAll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(submitted).toEqual(['Ours']);
  expect(useRenderQueueStore.getState().jobs.map((j) => j.compositionName)).toEqual(['Theirs', 'Older']);
});
