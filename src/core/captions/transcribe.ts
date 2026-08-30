/**
 * Captions from the composition's own audio.
 *
 * Same split as `aiImage.ts`, for the same reason: the renderer is keyless, so
 * the process that holds the key is the process that makes the call. In the
 * local edition that is Electron main (`ai:transcribe` → `aiProxy.ts` → the OS
 * keystore). There is no backend route for this yet, so the server edition
 * reports that rather than pretending — a caption feature that silently does
 * nothing is worse than one that says where it runs.
 *
 * What gets transcribed is the COMPOSITION, mixed down — not a footage file.
 * See `speechAudio.ts` for why that distinction decides whether the cues line
 * up with the picture.
 */

import { aiRunsThroughBackend } from '@core/config/edition';
import { useAiProviderStore } from '@stores/aiProviderStore';
import type { AiVaultProvider } from '@app-types/motionEditor';
import { deoverlap, type Cue } from './captionFormat';
import { speechWav } from './speechAudio';

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

/** True when this build can transcribe at all. */
export function transcriptionAvailable(): boolean {
  return typeof globalThis.window?.motionEditor?.ai?.transcribe === 'function';
}

/**
 * Mix the composition's audio and turn it into cues.
 *
 * Overlaps are removed before the cues are returned. Speech models routinely
 * emit segments that touch or overlap by a few milliseconds, and two captions
 * on screen at once renders as text over text — a defect that looks like a
 * renderer bug and is actually a transcript artefact.
 */
export async function transcribeComposition(opts: TranscribeOptions): Promise<Cue[]> {
  const transcribe = globalThis.window?.motionEditor?.ai?.transcribe;
  if (aiRunsThroughBackend()) {
    throw new TranscribeError(
      'unsupported',
      'Caption generation runs in the desktop app, which holds your provider key. '
      + 'There is no hosted transcription route yet.',
    );
  }
  if (!transcribe) {
    throw new TranscribeError('unsupported', 'This build cannot transcribe audio.');
  }
  if (opts.endSec <= opts.startSec) {
    throw new TranscribeError('bad_request', 'That time range is empty, so there is no audio in it.');
  }

  const wav = await speechWav(opts.startSec, opts.endSec, opts.rootId);
  if (!wav) {
    throw new TranscribeError(
      'silent',
      'This composition has no audible sound in that range — check the layers are unmuted and inside the work area.',
    );
  }

  const result = await transcribe({
    provider: useAiProviderStore.getState().provider as AiVaultProvider,
    bytes: wav,
    filename: 'composition.wav',
    ...(opts.language ? { language: opts.language } : {}),
  });

  if (!result.ok) throw new TranscribeError(result.code, result.message);

  // Cues come back relative to the AUDIO, which started at `startSec` — so a
  // work area over the second half of a comp would otherwise caption it from
  // zero, with every caption sitting under the wrong picture.
  return deoverlap(result.cues.map((c) => ({ ...c, start: c.start + opts.startSec, end: c.end + opts.startSec })));
}
