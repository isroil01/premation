/**
 * Every rendered file goes to main's export supervisor (the engine export).
 *
 * Pins the gate (`shouldUseSupervisor`: bridge, format, snapshot portability)
 * and the routing shared by the Export dialog's Add to Queue and the Render
 * Queue panel's Add Comp: reserve → snapshotTo → enqueue on main.
 */

jest.mock('@core/export/exportManager', () => ({ downloadBlob: jest.fn() }));
const snapshotTo = jest.fn(async (_path: string) => undefined);
jest.mock('@core/services/coreServices', () => ({
  ...jest.requireActual('@core/services/coreServices'),
  getProjectManager: () => ({ snapshotTo }),
}));
jest.mock('@stores/documentMirror', () => ({
  documentMirror: () => ({ items: new Map(), status: 'ready', comp: () => undefined }),
}));
const portable = jest.fn((_library: unknown) => true);
jest.mock('@core/export/snapshotPortability', () => ({
  currentProjectSnapshotIsPortable: (library: unknown) => portable(library),
}));

import { addToRenderQueue, enqueueSupervisorJob, joinOutputPath, shouldUseSupervisor, type QueueJobInput } from './supervisorQueue';
import { useRenderQueueStore } from '@stores/renderQueueStore';
import { resetExportQueueForTest } from '@stores/exportQueueStore';
import { useUIStore } from '@stores/uiStore';
import type { ExportJobSpec } from '@core/export/exportSupervisorClient';

const enqueued: Array<{ id?: string; spec: ExportJobSpec; priority?: number }> = [];
let chooseOutputDir: jest.Mock;
let chooseOutputPath: jest.Mock;

function installBridge(): void {
  chooseOutputDir = jest.fn(async () => 'D:\\Renders');
  chooseOutputPath = jest.fn(async () => 'D:\\picked\\one.mp4');
  (window as unknown as { motionEditor: unknown }).motionEditor = {
    render: { chooseOutputDir },
    exportSupervisor: {
      reserve: async () => ({ id: 'exp-1', projectPath: 'C:\\jobs\\exp-1\\project.motion' }),
      enqueue: async (req: { id?: string; spec: ExportJobSpec; priority?: number }) => {
        enqueued.push(req);
        return {
          id: req.id, spec: req.spec, status: 'queued', priority: req.priority ?? 0, createdAt: 1, attempts: 0,
          progress: { fraction: 0, frame: 0, totalFrames: req.spec.totalFrames, fps: null, etaSec: null },
        };
      },
      cancel: async () => true,
      retry: async () => null,
      setPriority: async () => true,
      remove: async () => true,
      list: async () => [],
      subscribe: async () => [],
      chooseOutputPath,
      onEvent: () => () => undefined,
    },
  };
}

function job(over: Partial<QueueJobInput> = {}): QueueJobInput {
  return {
    compositionName: 'Hero',
    compositionId: 'comp-1',
    outputPath: 'Hero_2026.mp4',
    format: 'mp4',
    width: 960,
    height: 540,
    compWidth: 1920,
    compHeight: 1080,
    fps: 24,
    durationSec: 4,
    rangeStartSec: 1,
    rangeEndSec: 3,
    transparent: false,
    quality: 'medium',
    videoEncoder: 'libx264',
    ...over,
  };
}

beforeEach(() => {
  enqueued.length = 0;
  snapshotTo.mockClear();
  portable.mockReset().mockReturnValue(true);
  resetExportQueueForTest();
  useUIStore.setState({ jobs: [], notifications: [] });
  useRenderQueueStore.setState({ jobs: [], outputDir: null });
  installBridge();
});

afterAll(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('shouldUseSupervisor', () => {
  it('takes every format the engine export writes', () => {
    for (const f of ['mp4', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence', 'exr-sequence', 'png', 'wav']) {
      expect(shouldUseSupervisor(f)).toBe(true);
    }
  });

  it('leaves the document exports to runDataExport', () => {
    for (const f of ['lottie', 'json', 'edl', 'mogrt']) {
      expect(shouldUseSupervisor(f)).toBe(false);
    }
  });

  it('no bridge → refused', () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    expect(shouldUseSupervisor('mp4')).toBe(false);
  });

  it('a project the snapshot cannot carry (editor-only footage) → refused', () => {
    portable.mockReturnValue(false);
    expect(shouldUseSupervisor('mp4')).toBe(false);
  });

  it('does not walk the scene for a format the engine does not write', () => {
    shouldUseSupervisor('lottie');
    expect(portable).not.toHaveBeenCalled();
  });
});

describe('joinOutputPath', () => {
  it("uses the directory's own separator and drops trailing ones", () => {
    expect(joinOutputPath('D:\\Renders\\', 'a.mp4')).toBe('D:\\Renders\\a.mp4');
    expect(joinOutputPath('/Users/me/Renders/', 'a.mp4')).toBe('/Users/me/Renders/a.mp4');
  });
});

describe('addToRenderQueue', () => {
  it('desktop: reserve → snapshot → enqueue on main; nothing in the in-window queue', async () => {
    const { where, done } = addToRenderQueue(job());
    expect(where).toBe('supervisor');
    expect(await done).toBe('exp-1');
    expect(useRenderQueueStore.getState().jobs).toHaveLength(0);
    expect(snapshotTo).toHaveBeenCalledWith('C:\\jobs\\exp-1\\project.motion');
    expect(enqueued).toHaveLength(1);
    const spec = enqueued[0]!.spec;
    // The folder is asked once and remembered; the file keeps the queue's name.
    expect(chooseOutputDir).toHaveBeenCalledTimes(1);
    expect(spec.outPath).toBe('D:\\Renders\\Hero_2026.mp4');
    expect(spec.projectPath).toBe('C:\\jobs\\exp-1\\project.motion');
    // The range captured at queue time: 1 s–3 s at 24 fps = frames 24–71.
    expect([spec.startFrame, spec.endFrame, spec.totalFrames]).toEqual([24, 71, 48]);
    expect(spec).toMatchObject({ comp: 'comp-1', format: 'mp4', width: 960, height: 540, quality: 'medium', videoEncoder: 'libx264' });
  });

  it('a remembered output folder is reused without a dialog', async () => {
    useRenderQueueStore.setState({ outputDir: '/Users/me/out' });
    await addToRenderQueue(job()).done;
    expect(chooseOutputDir).not.toHaveBeenCalled();
    expect(enqueued[0]!.spec.outPath).toBe('/Users/me/out/Hero_2026.mp4');
  });

  it('cancelling the folder dialog queues nothing', async () => {
    chooseOutputDir.mockResolvedValue(null);
    expect(await addToRenderQueue(job()).done).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(snapshotTo).not.toHaveBeenCalled();
  });

  it('a snapshot that fails is reported, and nothing is enqueued', async () => {
    snapshotTo.mockRejectedValueOnce(new Error('disk full'));
    expect(await addToRenderQueue(job()).done).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(useUIStore.getState().notifications.some((n) => /disk full/.test(n.message))).toBe(true);
  });

  it('non-portable project → refused with a toast, nothing enqueued', async () => {
    portable.mockReturnValue(false);
    expect(await addToRenderQueue(job()).done).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(useUIStore.getState().notifications.some((n) => /engine cannot read/.test(n.message))).toBe(true);
  });
});

describe('enqueueSupervisorJob', () => {
  it('falls back to a save dialog when the shell cannot pick a folder', async () => {
    const me = (window as unknown as { motionEditor: { render?: unknown } }).motionEditor;
    delete me.render;
    await enqueueSupervisorJob(job({ outputPath: 'x.webm', format: 'webm' }), 3);
    expect(chooseOutputPath).toHaveBeenCalledWith('x.webm');
    expect(enqueued[0]).toMatchObject({ priority: 3 });
    expect(enqueued[0]!.spec.outPath).toBe('D:\\picked\\one.mp4');
  });
});
