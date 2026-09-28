/**
 * Rig Logo — the page half: the riggable-kind predicate (the AI tools and the
 * layer menus gate on it) and the orchestrator around the engine's `rigLogo`
 * job. The decision (rig in place vs rasterize), the render, the import and
 * the pins are the job's, tested against the real engine in
 * src/core/engine/__tests__/rigLogoNative.test.ts.
 */

import { isRiggableKind, rigLogoForAnimation, type RigLogoDeps } from './rigLogo';

const deps = (over: Partial<RigLogoDeps> = {}) => ({
  getSelection: () => ['g1'],
  setSelection: jest.fn(),
  setActiveTool: jest.fn(),
  notify: jest.fn(),
  ...over,
});

describe('riggable-kind predicate', () => {
  it('shape/image are riggable; group/null/camera are not', () => {
    expect(isRiggableKind('shape')).toBe(true);
    expect(isRiggableKind('image')).toBe(true);
    expect(isRiggableKind('group')).toBe(false);
    expect(isRiggableKind('null')).toBe(false);
    expect(isRiggableKind('camera')).toBe(false);
  });

  it('text is NOT directly riggable — it routes through Rig Logo (§12.10)', () => {
    expect(isRiggableKind('text')).toBe(false);
  });
});

describe('rigLogoForAnimation', () => {
  it('runs the job on the selection, then selects the rigged layer and picks the Puppet Pin tool', async () => {
    const run = jest.fn(async () => ({ ok: true as const, result: { mode: 'rasterize' as const, layer: 'img9' } }));
    const d = deps({ getSelection: () => ['g1', 's2'], run, seconds: () => 1.5 });
    await rigLogoForAnimation(d);
    expect(run).toHaveBeenCalledWith(['g1', 's2'], 1.5);
    expect(d.setSelection).toHaveBeenCalledWith(['img9']);
    expect(d.setActiveTool).toHaveBeenCalledWith('puppet-pin');
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'success' }));
  });

  it('no selection → notifies and never starts the job', async () => {
    const run = jest.fn();
    const d = deps({ getSelection: () => [], run });
    await rigLogoForAnimation(d);
    expect(run).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('a refused or failed job → an error notification with the engine\'s reason, no throw', async () => {
    const d = deps({ run: async () => ({ ok: false as const, message: 'The selection draws nothing at this time.' }) });
    await rigLogoForAnimation(d);
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: 'The selection draws nothing at this time.' }));
    expect(d.setActiveTool).not.toHaveBeenCalled();
    const thrown = deps({ run: async () => { throw new Error('Rig Logo for Animation runs in the engine, and this engine does not run it.'); } });
    await rigLogoForAnimation(thrown);
    expect(thrown.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: expect.stringMatching(/runs in the engine/) }));
  });

  it('a cancelled job does nothing', async () => {
    const d = deps({ run: async () => null });
    await rigLogoForAnimation(d);
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.setSelection).not.toHaveBeenCalled();
  });
});
