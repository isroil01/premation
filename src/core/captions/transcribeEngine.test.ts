/**
 * Transcription through the engine's `transcribe` job (2026-09-28): the page
 * asks the engine first and gets composition-second cues back; the provider
 * key is never in the page's request (Electron main adds it). The page's own
 * mixdown + IPC path runs only when the engine does not run the job.
 */

jest.mock('@core/engine/engineJobs', () => ({ runEngineJob: jest.fn() }));
jest.mock('@core/config/edition', () => ({ aiRunsThroughBackend: () => false }));
jest.mock('./speechAudio', () => ({ speechWav: jest.fn(async () => new Uint8Array([1, 2, 3])) }));

import { runEngineJob } from '@core/engine/engineJobs';
import { speechWav } from './speechAudio';
import { TranscribeError, transcribeCompositionDetailed } from './transcribe';

const run = runEngineJob as jest.MockedFunction<typeof runEngineJob>;

function withIpc(transcribe: jest.Mock | undefined): void {
  (globalThis as { window?: unknown }).window = { motionEditor: { ai: { transcribe } } };
}

afterEach(() => {
  run.mockReset();
  (speechWav as jest.Mock).mockClear();
  delete (globalThis as { window?: unknown }).window;
});

describe('transcribe through the engine job', () => {
  it('sends the comp and range without a key and returns the engine cues as they are', async () => {
    const ipc = jest.fn();
    withIpc(ipc);
    run.mockResolvedValue({
      status: 'done',
      job: {} as never,
      result: { cues: [{ start: 2, end: 3, text: 'Hello' }], words: [{ start: 2, end: 2.4, text: 'Hello' }], language: 'en' },
    });
    const t = await transcribeCompositionDetailed({ startSec: 2, endSec: 5, rootId: 'comp_1', language: 'en' });
    expect(t.cues).toEqual([{ start: 2, end: 3, text: 'Hello' }]);
    expect(t.words).toHaveLength(1);
    const spec = run.mock.calls[0]![0];
    expect(spec.kind).toBe('transcribe');
    const v = (spec as Extract<typeof spec, { kind: 'transcribe' }>).value;
    expect(v).toMatchObject({ comp: 'comp_1', language: 'en', createCaptions: false });
    expect(v.credential).toBeUndefined();
    expect(v.range!.duration).toBeGreaterThan(0);
    // The page path did not run.
    expect(ipc).not.toHaveBeenCalled();
    expect(speechWav).not.toHaveBeenCalled();
  });

  it('carries the provider code of a failed job', async () => {
    withIpc(jest.fn());
    run.mockResolvedValue({
      status: 'failed',
      job: {} as never,
      result: null,
      error: { code: 'invalidArgument', message: 'No OpenAI API key is connected.', detail: '{"code":"no_key"}' },
    });
    const err = await transcribeCompositionDetailed({ startSec: 0, endSec: 1, rootId: 'comp_1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect((err as TranscribeError).code).toBe('no_key');
  });

  it('falls back to the page path when the engine does not run the job', async () => {
    const ipc = jest.fn(async () => ({ ok: true, cues: [{ start: 0.5, end: 1, text: 'Hi' }] }));
    withIpc(ipc);
    run.mockResolvedValue(null);
    const t = await transcribeCompositionDetailed({ startSec: 10, endSec: 12, rootId: 'comp_1' });
    expect(ipc).toHaveBeenCalledTimes(1);
    // The page path rebases the provider's audio-relative times itself.
    expect(t.cues).toEqual([{ start: 10.5, end: 11, text: 'Hi' }]);
  });
});
