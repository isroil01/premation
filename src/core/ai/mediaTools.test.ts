/**
 * The footage tools without an engine: the job table get_job_status reads,
 * and the refusals the handlers give before they reach the engine. The
 * segmentation, tracking and transcription themselves need the app's engine
 * (the headless engine runs no jobs) and are verified in the running app.
 */

import type { ToolContext } from '@motion/ai-tools';
import { AI_JOBS, HELD_TRACKS, MEDIA_HANDLERS, finishAiJob, jobLine, newAiJob } from './mediaTools';

const ctx = {
  signal: new AbortController().signal,
  aliases: new Map<string, string>(),
  scene: { has: async () => false, nearest: async () => ['layer_1'], selection: () => [] as string[] },
  comp: { playhead: () => 0 },
} as unknown as ToolContext;

describe('AI jobs', () => {
  beforeEach(() => AI_JOBS.clear());

  it('registers a running job, finishes it with a summary, and reads it back', async () => {
    let cancelled = false;
    const job = newAiJob('follow_subject', 'Following s1', () => { cancelled = true; });
    expect(job.status).toBe('running');
    expect(jobLine(job)).toMatch(/running 0%/);
    const running = await MEDIA_HANDLERS.get_job_status!({ jobId: job.id }, ctx);
    expect(running.ok).toBe(true);
    expect((running.data as { status: string }).status).toBe('running');
    const cancel = await MEDIA_HANDLERS.get_job_status!({ jobId: job.id, cancel: true }, ctx);
    expect(cancel.content).toMatch(/Cancelling/);
    expect(cancelled).toBe(true);
    finishAiJob(job, 'done', 'Subject followed over 120 frames', { frames: 120 });
    const done = await MEDIA_HANDLERS.get_job_status!({ jobId: job.id }, ctx);
    expect(done.content).toMatch(/done — Subject followed over 120 frames/);
    expect((done.data as { result: { frames: number } }).result.frames).toBe(120);
    expect((done.data as { progress: number }).progress).toBe(1);
  });

  it('lists every job of the session and names an unknown id', async () => {
    newAiJob('transcribe', 'Transcribing', () => undefined);
    newAiJob('track_point', 'Tracking', () => undefined);
    const all = await MEDIA_HANDLERS.get_job_status!({}, ctx);
    expect((all.data as { jobs: unknown[] }).jobs).toHaveLength(2);
    const missing = await MEDIA_HANDLERS.get_job_status!({ jobId: 'nope' }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.content).toMatch(/No job 'nope'/);
  });

  it('keeps the newest jobs when the table is full, never dropping a running one', () => {
    for (let i = 0; i < 45; i++) finishAiJob(newAiJob('transcribe', `t${i}`, () => undefined), 'done', 'ok');
    const live = newAiJob('follow_subject', 'live', () => undefined);
    expect(AI_JOBS.size).toBeLessThanOrEqual(41);
    expect(AI_JOBS.get(live.id)).toBe(live);
  });
});

describe('refusals before the engine', () => {
  it('attach_to_track names the tracks it holds when the id is unknown', async () => {
    HELD_TRACKS.clear();
    const r = await MEDIA_HANDLERS.attach_to_track!({ trackId: 'track_zz', mode: 'createNull' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/No track 'track_zz'/);
    expect(r.content).toMatch(/run track_point first/);
  });

  it('the subject tools repair an unknown layer id', async () => {
    for (const name of ['find_subjects', 'select_subject', 'refine_subject', 'follow_subject', 'apply_subject_style', 'track_point']) {
      const r = await MEDIA_HANDLERS[name]!({ layerId: 'ghost', style: 'neon', point: { x: 1, y: 1 } }, ctx);
      expect(r.ok).toBe(false);
      expect(r.content).toMatch(/unknown layerId 'ghost' — did you mean: layer_1/);
    }
  });

  it('transcribe says so when this build has no engine for it', async () => {
    const r = await MEDIA_HANDLERS.transcribe!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/engine/);
  });

  it('describe_asset lists the imported ids when the asset is unknown', async () => {
    const r = await MEDIA_HANDLERS.describe_asset!({ assetId: 'missing' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/No imported asset 'missing'/);
  });
});
