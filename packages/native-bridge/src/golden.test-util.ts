/**
 * Reads native/tests/golden_bezier.inc — the X-macro table gen_golden.ts emits
 * — for the bridge tests. Same file the Catch2 suite and both binding smoke
 * tests consume; one table, four gates.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GoldenTable {
  /** Ten numbers per keyframe, in the packed order. */
  keyframes: number[][];
  samples: Array<{ t: number; expected: number }>;
}

export const GOLDEN_INC = resolve(__dirname, '../../../native/tests/golden_bezier.inc');

export function loadGoldenTable(): GoldenTable {
  const text = readFileSync(GOLDEN_INC, 'utf8');
  const keyframes: number[][] = [];
  const samples: GoldenTable['samples'] = [];
  for (const line of text.split(/\r?\n/)) {
    const kf = /^MOTION_GOLDEN_KF\((.*)\)\s*$/.exec(line);
    if (kf) {
      keyframes.push(kf[1]!.split(',').map((s) => Number(s.trim())));
      continue;
    }
    const sample = /^MOTION_GOLDEN_SAMPLE\((.*)\)\s*$/.exec(line);
    if (sample) {
      const [t, expected] = sample[1]!.split(',').map((s) => Number(s.trim()));
      samples.push({ t: t!, expected: expected! });
    }
  }
  return { keyframes, samples };
}
