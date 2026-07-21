/**
 * The editor↔motion-back frame-naming contract.
 *
 * The editor packs stills into a zip; motion-back's render worker hands that
 * directory to ffmpeg as a `frame_%0Nd.ext` pattern. Nothing type-checks across
 * the repo boundary, so this bug class is invisible to both suites: the editor
 * once padded to `String(total).length`, producing `frame_000.jpg` for any
 * render under 1000 frames, while the worker globbed `frame_%04d.jpg`. ffmpeg
 * matched nothing and every MP4 export under ~33s failed — surfaced to users as
 * "backend offline".
 *
 * These tests pin the producer side. The consumer now derives its pattern from
 * the files themselves (see render.worker.ts#framePattern), so the two agree by
 * construction — but the padding is still load-bearing for any tool that
 * assumes %04d, and must not drift back to being length-dependent.
 */

import { FRAME_SEQUENCE_PAD, frameFileName } from './exportManager';

/** Mirrors the worker's entry filter (render.worker.ts#extractFrames). */
const WORKER_ENTRY_FILTER = /^frame_\d+\.(png|jpe?g)$/i;

/** Mirrors the worker's pattern derivation (render.worker.ts#framePattern). */
function derivePattern(names: string[]): { pattern: string; start: number } | null {
  const frames = names
    .map((f) => /^frame_(\d+)\.(png|jpe?g)$/i.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const first = frames[0];
  const digits = first?.[1];
  const ext = first?.[2];
  if (digits === undefined || ext === undefined) return null;
  return { pattern: `frame_%0${digits.length}d.${ext.toLowerCase()}`, start: Number(digits) };
}

describe('frame naming contract', () => {
  it('pads to a fixed width, independent of frame count', () => {
    // The regression: these two renders must not disagree on padding.
    expect(frameFileName(0, 'jpg')).toBe('frame_0000.jpg');
    expect(frameFileName(7, 'jpg')).toBe('frame_0007.jpg');
    expect(FRAME_SEQUENCE_PAD).toBe(4);
  });

  it('lets ffmpeg keep matching past the pad width', () => {
    // %04d is a MINIMUM width, so long renders are still matched.
    expect(frameFileName(10_000, 'jpg')).toBe('frame_10000.jpg');
  });

  it('produces names the worker accepts', () => {
    for (const frame of [0, 9, 99, 300, 12_345]) {
      for (const ext of ['png', 'jpg'] as const) {
        expect(frameFileName(frame, ext)).toMatch(WORKER_ENTRY_FILTER);
      }
    }
  });

  it.each([
    ['a 10s/30fps render (the case that used to fail)', 300, 'jpg' as const, 'frame_%04d.jpg'],
    ['a sub-second render', 5, 'jpg' as const, 'frame_%04d.jpg'],
    ['a transparent render', 300, 'png' as const, 'frame_%04d.png'],
    ['a render past the pad width', 12_000, 'jpg' as const, 'frame_%04d.jpg'],
  ])('round-trips %s', (_label, count, ext, expected) => {
    const names = Array.from({ length: Math.min(count, 20) }, (_, i) => frameFileName(i, ext));
    const derived = derivePattern(names);

    expect(derived).toEqual({ pattern: expected, start: 0 });
  });
});
