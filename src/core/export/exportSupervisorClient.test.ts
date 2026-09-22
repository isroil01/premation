/**
 * The editor's client for the main-owned export queue, against a fake bridge.
 *
 * Asserted: the spec the form's choices become (frame range end-inclusive,
 * chapters/encoder only when present), the validation at the IPC boundary
 * (a record with the wrong shape never reaches a component), the subscribe
 * round-trip, and the one-line progress description the rows show.
 */

import {
  buildSupervisorSpec,
  describeProgress,
  exportSupervisorAvailable,
  exportSupervisorClient,
  formatEta,
  frameRangeFor,
  isExportJobRecord,
  type ExportJobRecord,
  type ExportQueueEvent,
} from './exportSupervisorClient';
import { frameRangeToSeconds } from '@core/cli/headlessRender';

type Handler = (event: unknown) => void;

function record(over: Partial<ExportJobRecord> = {}): ExportJobRecord {
  return {
    id: 'a',
    status: 'rendering',
    priority: 0,
    createdAt: 1,
    attempts: 1,
    spec: { projectPath: 'C:\\s\\p.motion', outPath: 'C:\\o\\x.mp4', format: 'mp4', label: 'Comp → x.mp4', totalFrames: 48 },
    progress: { fraction: 0.5, frame: 24, totalFrames: 48, fps: 12, etaSec: 2 },
    ...over,
  };
}

function installBridge(): { calls: Array<[string, unknown[]]>; handlers: Handler[] } {
  const calls: Array<[string, unknown[]]> = [];
  const handlers: Handler[] = [];
  const call = (name: string, result: unknown) => (...args: unknown[]) => { calls.push([name, args]); return Promise.resolve(result); };
  (window as unknown as { motionEditor: unknown }).motionEditor = {
    exportSupervisor: {
      reserve: call('reserve', { id: 'a', projectPath: 'C:\\s\\a\\project.motion' }),
      enqueue: call('enqueue', record({ status: 'queued' })),
      cancel: call('cancel', true),
      retry: call('retry', record({ status: 'queued' })),
      setPriority: call('setPriority', true),
      remove: call('remove', true),
      list: call('list', [record(), { junk: true }]),
      subscribe: call('subscribe', [record()]),
      chooseOutputPath: call('chooseOutputPath', 'C:\\o\\x.mp4'),
      onEvent: (h: Handler) => { handlers.push(h); return () => handlers.splice(handlers.indexOf(h), 1); },
    },
  };
  return { calls, handlers };
}

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('availability', () => {
  it('is absent without the bridge and present with every verb', () => {
    expect(exportSupervisorAvailable()).toBe(false);
    installBridge();
    expect(exportSupervisorAvailable()).toBe(true);
  });

  it('a bridge missing a verb does not count', () => {
    installBridge();
    delete (window.motionEditor!.exportSupervisor as { onEvent?: unknown }).onEvent;
    expect(exportSupervisorAvailable()).toBe(false);
    expect(() => exportSupervisorClient.cancel('a')).toThrow(/no export supervisor/);
  });
});

describe('buildSupervisorSpec', () => {
  const base = {
    compositionId: 'comp-1',
    compositionName: 'Promo',
    format: 'mp4',
    width: 1920,
    height: 1080,
    fps: 24,
    range: { startSec: 0, endSec: 1 },
    quality: 'high' as const,
    transparent: false,
    projectPath: 'C:\\s\\a\\project.motion',
    outPath: 'C:\\out\\promo.mp4',
  };

  it('turns the captured seconds into an inclusive frame range that round-trips', () => {
    const spec = buildSupervisorSpec(base);
    expect(spec.startFrame).toBe(0);
    expect(spec.endFrame).toBe(23);
    expect(spec.totalFrames).toBe(24);
    expect(frameRangeToSeconds(spec.startFrame!, spec.endFrame!, 24)).toEqual({ rangeStartSec: 0, rangeEndSec: 1 });
    expect(spec.label).toBe('Promo → promo.mp4');
    expect(spec.comp).toBe('comp-1');
  });

  it('a work-area range keeps its offset', () => {
    expect(frameRangeFor({ startSec: 2, endSec: 3.5 }, 30)).toEqual({ startFrame: 60, endFrame: 104 });
  });

  it('carries the encoder, profile and chapters only when given', () => {
    const plain = buildSupervisorSpec(base);
    expect(plain).not.toHaveProperty('videoEncoder');
    expect(plain).not.toHaveProperty('chapters');
    expect(plain).not.toHaveProperty('proresProfile');
    const full = buildSupervisorSpec({
      ...base,
      format: 'mov',
      proresProfile: '4444',
      videoEncoder: 'h264_nvenc',
      chapters: [{ startFrame: 0, endFrame: 10, title: 'Intro' }] as never,
    });
    expect(full.proresProfile).toBe('4444');
    expect(full.videoEncoder).toBe('h264_nvenc');
    expect(full.chapters).toHaveLength(1);
  });
});

describe('the boundary', () => {
  it('isExportJobRecord accepts a record and refuses drift', () => {
    expect(isExportJobRecord(record())).toBe(true);
    expect(isExportJobRecord({ ...record(), status: 'exploded' })).toBe(false);
    expect(isExportJobRecord({ ...record(), progress: { fraction: '0.5' } })).toBe(false);
    expect(isExportJobRecord(null)).toBe(false);
  });

  it('list filters what is not a record', async () => {
    installBridge();
    const list = await exportSupervisorClient.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('a');
  });

  it('enqueue forwards id, spec and priority', async () => {
    const { calls } = installBridge();
    const spec = record().spec;
    const job = await exportSupervisorClient.enqueue('a', spec, 3);
    expect(job.status).toBe('queued');
    expect(calls).toEqual([['enqueue', [{ id: 'a', spec, priority: 3 }]]]);
  });

  it('subscribe returns the current list, forwards valid events, drops the rest', async () => {
    const { handlers } = installBridge();
    const seen: ExportQueueEvent[] = [];
    const { jobs, unsubscribe } = await exportSupervisorClient.subscribe((e) => seen.push(e));
    expect(jobs).toHaveLength(1);
    expect(handlers).toHaveLength(1);
    handlers[0]!({ type: 'job', job: record({ status: 'completed' }) });
    handlers[0]!({ type: 'job', job: { nope: true } });
    handlers[0]!({ type: 'snapshot', jobs: [record(), 7] });
    handlers[0]!('garbage');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: 'job', job: record({ status: 'completed' }) });
    expect((seen[1] as { jobs: unknown[] }).jobs).toHaveLength(1);
    unsubscribe();
    expect(handlers).toHaveLength(0);
  });
});

describe('describeProgress', () => {
  it('shows frame, rate and time left while rendering', () => {
    expect(describeProgress(record())).toBe('Frame 24 / 48 · 12.0 fps · 0:02 left');
  });

  it('omits what is not known yet', () => {
    expect(describeProgress(record({ progress: { fraction: 0, frame: 0, totalFrames: 48, fps: null, etaSec: null } })))
      .toBe('Frame 0 / 48');
  });

  it('names the other states', () => {
    expect(describeProgress(record({ status: 'queued', attempts: 0 }))).toBe('Queued');
    expect(describeProgress(record({ status: 'queued', attempts: 1 }))).toBe('Queued again');
    expect(describeProgress(record({ status: 'encoding' }))).toBe('Finishing the encode…');
    expect(describeProgress(record({ status: 'completed' }))).toBe('Done · 48 frames');
    expect(describeProgress(record({ status: 'failed', error: 'oom' }))).toBe('oom');
    expect(describeProgress(record({ status: 'cancelled' }))).toBe('Cancelled');
  });

  it('formatEta', () => {
    expect(formatEta(42)).toBe('0:42');
    expect(formatEta(725)).toBe('12:05');
    expect(formatEta(3800)).toBe('1:03:20');
  });
});
