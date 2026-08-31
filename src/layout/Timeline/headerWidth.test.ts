/**
 * The track-header column model lives in two places — `TL_COLUMN_WIDTHS` in
 * Timeline.tsx and the `--tl-col-*` custom properties in Timeline.module.css —
 * because one side has to add the widths up (to size the header column) and the
 * other has to lay them out. Nothing at runtime notices when they drift.
 *
 * That drift is not hypothetical. The Mode, TrkMat and Parent & Link columns
 * were unreachable for exactly this reason: they were laid out at fixed widths
 * summing past 570px inside a header whose stored default was 460px, so they
 * sat behind the lanes where no scrolling could reach them. These tests pin the
 * two halves together.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { headerWidthFor, TRACK_HEADER_MIN_WIDTH } from './Timeline';
import { DEFAULT_PREFERENCES } from '@stores/preferenceStore';

const css = readFileSync(join(__dirname, 'Timeline.module.css'), 'utf8');

/** Value of a `--tl-col-<name>` custom property, in px. */
function cssVar(name: string): number {
  const decl = `--tl-col-${name}:`;
  const at = css.indexOf(decl);
  if (at < 0) throw new Error(`${decl} is not declared in Timeline.module.css`);
  const value = css.slice(at + decl.length, css.indexOf(';', at)).trim();
  if (!value.endsWith('px')) {
    throw new Error(`${decl} is "${value}" — the summed model in Timeline.tsx needs a px literal`);
  }
  return Number(value.slice(0, -2));
}

describe('track-header column model', () => {
  // Mirrors `TL_COLUMN_WIDTHS`. Named here rather than imported so a change to
  // the constant cannot silently satisfy its own test.
  const EXPECTED = {
    preinfo: 72,
    name: 190,
    switches: 178,
    mode: 70,
    matte: 58,
    parent: 120,
  };

  it.each(Object.entries(EXPECTED))('--tl-col-%s matches the width Timeline.tsx sums', (n, px) => {
    expect(cssVar(n)).toBe(px);
  });

  it('the switch column is exactly its seven 22px cells and six 4px gaps', () => {
    // A narrower column centre-justifies the switches and spills them into the
    // neighbouring divider rules — the bug the width was introduced to fix.
    expect(cssVar('switches')).toBe(7 * 22 + 6 * 4);
  });

  it('the A/V gutter is exactly its three 22px cells and two 3px gaps', () => {
    expect(cssVar('preinfo')).toBe(3 * 22 + 2 * 3);
  });
});

describe('TRACK_HEADER_MIN_WIDTH', () => {
  it('is the min-width `.searchBarCol` holds itself to', () => {
    // The sub-header's left column and the track-header column share one
    // vertical line down the panel. If the drag can go narrower than the row
    // above will shrink, that line breaks mid-drag.
    const css = readFileSync(
      join(__dirname, '..', 'BottomTimeline', 'BottomTimeline.module.css'),
      'utf8',
    );
    const block = css.slice(css.indexOf('.searchBarCol {'));
    const decl = block.slice(0, block.indexOf('}'));
    expect(decl).toContain(`min-width: ${TRACK_HEADER_MIN_WIDTH}px;`);
  });
});

describe('headerWidthFor', () => {
  it('fits the mode columns in the default view', () => {
    // padding 8 + (72 + 16 rule) + 4 + 190
    //         + 4 + (70 + 16) + 4 + (58 + 16) + 4 + (120 + 16)
    expect(headerWidthFor('modes')).toBe(598);
  });

  it('fits the switch column on its own', () => {
    expect(headerWidthFor('switches')).toBe(8 + 88 + 4 + 190 + 4 + 178 + 16);
  });

  it('needs both blocks plus a gap when both are shown', () => {
    const W = { switches: headerWidthFor('switches'), modes: headerWidthFor('modes') };
    // `both` is the two column sets sharing one gutter and one name column.
    expect(headerWidthFor('both')).toBe(W.modes + 4 + 178 + 16);
    expect(headerWidthFor('both')).toBeGreaterThan(W.switches);
  });

  it('never returns less than the old 460px default that hid the columns', () => {
    for (const c of ['switches', 'modes', 'both'] as const) {
      expect(headerWidthFor(c)).toBeGreaterThan(460);
    }
  });

  it('is what a fresh install starts the header column at', () => {
    // The shipped preference has to show every column, or the default view is
    // one where half the track header is off screen — which is the state this
    // whole model was introduced to fix.
    expect(DEFAULT_PREFERENCES.timelineHeaderWidth).toBe(headerWidthFor('both'));
  });
});
