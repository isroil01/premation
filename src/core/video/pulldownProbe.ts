/**
 * The decode half of pulldown detection: pull a short window of frames
 * through the exact decoder, split fields, hand them to the pure detector.
 *
 * Forty frames is eight full cadence cycles — enough that a cut or two inside
 * the window cannot fake or break the phase lock. Runs on the ASSET (the
 * Interpret Footage modal's subject), not a layer: interpretation is a
 * statement about the file.
 */

import { demuxMp4 } from './mp4Demuxer';
import { ExactVideoSource, webCodecsAvailable } from './exactVideoSource';
import { detectPulldown, splitFields, type FieldPair, type PulldownReport } from './pulldownDetect';

const PROBE_FRAMES = 40;

export function canProbePulldown(): boolean {
  return webCodecsAvailable();
}

export async function probePulldown(
  src: string,
  onProgress?: (f: number) => void,
): Promise<PulldownReport> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Source unreadable (${res.status}).`);
  const demuxed = await demuxMp4(await res.arrayBuffer());
  const source = new ExactVideoSource(demuxed);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = demuxed.codedWidth;
    canvas.height = demuxed.codedHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D context for frame readback.');

    const frames: FieldPair[] = [];
    const count = Math.min(PROBE_FRAMES, source.frameCount);
    for (let i = 0; i < count; i++) {
      const frame = await source.frameAt(i);
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const luma = new Float32Array(canvas.width * canvas.height);
      for (let p = 0, q = 0; p < luma.length; p++, q += 4) {
        luma[p] = img.data[q]! * 0.299 + img.data[q + 1]! * 0.587 + img.data[q + 2]! * 0.114;
      }
      frames.push(splitFields(luma, canvas.width, canvas.height, 4));
      onProgress?.((i + 1) / count);
    }
    return detectPulldown(frames);
  } finally {
    source.close();
  }
}
