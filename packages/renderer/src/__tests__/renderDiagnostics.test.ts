/**
 * M8a — the cap-fallback mechanism.
 *
 * The renderer STATES what it could not honour; the host decides. That split is
 * the whole point: preview warns and keeps the frame, export refuses it. A
 * design that collapsed both into "log a warning" would lose the export case,
 * which is the one that matters — a warning in a log next to a delivered file is
 * not a warning anyone acts on.
 */

import { RenderDiagnostics, describeDiagnostics } from '../core/renderer/RenderDiagnostics';

describe('RenderDiagnostics', () => {
  it('is empty on the common path — nothing is allocated when nothing goes wrong', () => {
    const d = new RenderDiagnostics();
    expect(d.isEmpty).toBe(true);
    expect(d.drain()).toEqual([]);
  });

  it('collects what a pass reports', () => {
    const d = new RenderDiagnostics();
    d.push({ code: 'matte-source-unavailable', detail: 'no source', layerId: 'a' });
    expect(d.isEmpty).toBe(false);
    expect(d.drain()).toEqual([{ code: 'matte-source-unavailable', detail: 'no source', layerId: 'a' }]);
  });

  it('drains — a frame does not inherit the previous frame\'s complaints', () => {
    const d = new RenderDiagnostics();
    d.push({ code: 'group-unavailable', detail: 'x' });
    d.drain();
    expect(d.drain()).toEqual([]);
    expect(d.isEmpty).toBe(true);
  });

  it('is bounded — a pathological scene cannot turn a render problem into a memory problem', () => {
    const d = new RenderDiagnostics();
    for (let i = 0; i < 500; i++) d.push({ code: 'group-unavailable', detail: `n${i}` });
    const out = d.drain();
    expect(out.length).toBe(32);
    // Keeps the FIRST ones: the 33rd instance of the same failure tells the user
    // nothing the 1st did not, and the earliest is nearest the cause.
    expect(out[0]!.detail).toBe('n0');
  });
});

describe('describeDiagnostics', () => {
  it('is empty for no diagnostics', () => {
    expect(describeDiagnostics([])).toBe('');
  });

  it('quotes the detail verbatim, with the layer, so preview and export agree', () => {
    // A user comparing a preview warning against an export failure must not have
    // to work out whether they are the same problem.
    const text = describeDiagnostics([
      { code: 'matte-source-unavailable', detail: 'Track matte could not be built', layerId: 'L3' },
    ]);
    expect(text).toContain('Track matte could not be built');
    expect(text).toContain('L3');
    expect(text).toContain('1 compositing operation(s)');
  });
});
