/**
 * Captions from the composition's own audio: the engine's `transcribe` JOB
 * (2026-09-28). The engine mixes the composition down (the COMPOSITION, not a
 * footage file, so the cues line up with the picture), calls the user's
 * speech provider and answers composition-second cues. The page never holds
 * the key — Electron main writes it into the job request on its way to the
 * engine. The page mixdown + ``ai:transcribe`` path that ran on the TypeScript
 * engine is gone (docs/TS_ENGINE_REMOVAL.md phase 4). There is no backend
 * route for this, so the server edition reports that rather than pretending.
 */

import { aiRunsThroughBackend } from '@core/config/edition';
import { useAiProviderStore } from '@stores/aiProviderStore';
import type { AiVaultProvider } from '@app-types/motionEditor';
import type { Cue } from './captionFormat';
import type { SpokenWord } from './transcriptEdit';
import { secondsToFlicks } from '@motion/engine-api';
import { runEngineJob } from '@core/engine/engineJobs';
import { activeCompRootId } from '@core/scene/activeComp';

export interface TranscribeOptions {
  /** Comp-time window to transcribe. */
  startSec: number;
  endSec: number;
  /** Which composition's audio (defaults to the active one). */
  rootId?: string;
  /** BCP-47-ish hint (`en`, `pt-BR`). Absent: the model detects one. */
  language?: string;
}

export class TranscribeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TranscribeError';
  }
}

/** True when this build can transcribe at all (it has the engine). */
export function transcriptionAvailable(): boolean {
  return typeof globalThis.window?.motionEditor?.engine?.request === 'function';
}

/** What the engine's transcribe job answers (JobInfo.result). */
interface EngineTranscript {
  cues: Cue[];
  words: SpokenWord[];
  language?: string;
}

/** aiProxy.ts's failure code, carried in the engine error's `detail`. */
function engineErrorCode(detail: string | undefined, fallback: string): string {
  if (!detail) return fallback;
  try {
    const code = (JSON.parse(detail) as { code?: unknown }).code;
    return typeof code === 'string' && code ? code : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The engine's transcribe job. Null when this engine does not run it (the
 * jest harness); throws TranscribeError when it ran and failed.
 */
async function transcribeInEngine(opts: TranscribeOptions): Promise<Transcription | null> {
  const outcome = await runEngineJob<EngineTranscript>({
    kind: 'transcribe',
    value: {
      layer: '',
      language: opts.language ?? '',
      createCaptions: false,
      comp: opts.rootId ?? activeCompRootId(),
      range: { start: secondsToFlicks(opts.startSec), duration: secondsToFlicks(opts.endSec - opts.startSec) },
      provider: useAiProviderStore.getState().provider as AiVaultProvider,
    },
  });
  if (!outcome) return null;
  if (outcome.status === 'cancelled') throw new TranscribeError('cancelled', 'Transcription was cancelled.');
  if (outcome.status !== 'done' || !outcome.result) {
    throw new TranscribeError(
      engineErrorCode(outcome.error?.detail, 'provider_error'),
      outcome.error?.message || 'The transcription failed.',
    );
  }
  // Already in composition seconds and de-overlapped by the engine.
  return { cues: outcome.result.cues, words: outcome.result.words ?? [] };
}

/** A transcript as the provider gave it: segments, and words when it had them. */
export interface Transcription {
  /** One per SENTENCE — what a caption is, and what SRT/VTT export writes. */
  cues: Cue[];
  /**
   * One per WORD, when the model returned word timings.
   *
   * Empty when it did not, which is the signal to estimate word times inside
   * each segment instead. Never used to build captions: a caption per word is
   * a stroboscope, and `cues` is the segment list either way.
   */
  words: SpokenWord[];
}

/**
 * Mix the composition's audio and turn it into cues.
 *
 * The segment-only view, for the three callers that write captions (layers,
 * SRT/VTT export, the headless CLI). Word timings are not their business.
 */
export async function transcribeComposition(opts: TranscribeOptions): Promise<Cue[]> {
  return (await transcribeCompositionDetailed(opts)).cues;
}

/**
 * Mix the composition's audio and turn it into cues AND word timings.
 *
 * Overlaps are removed before the cues are returned. Speech models routinely
 * emit segments that touch or overlap by a few milliseconds, and two captions
 * on screen at once renders as text over text — a defect that looks like a
 * renderer bug and is actually a transcript artefact.
 *
 * Words are NOT de-overlapped: they are a measurement of when each word was
 * said, not something drawn on screen, so a two-millisecond overlap between
 * neighbours is a fact about the audio rather than a defect to correct.
 */
export async function transcribeCompositionDetailed(
  opts: TranscribeOptions,
): Promise<Transcription> {
  if (aiRunsThroughBackend()) {
    throw new TranscribeError(
      'unsupported',
      'Caption generation runs in the desktop app, which holds your provider key. '
      + 'There is no hosted transcription route yet.',
    );
  }
  if (opts.endSec <= opts.startSec) {
    throw new TranscribeError('bad_request', 'That time range is empty, so there is no audio in it.');
  }
  const viaEngine = await transcribeInEngine(opts);
  if (!viaEngine) {
    throw new TranscribeError('unsupported', 'Transcription runs in the engine, and this engine does not run it.');
  }
  return viaEngine;
}
