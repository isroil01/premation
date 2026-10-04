/**
 * Layer / Solid Settings (AE Ctrl+Shift+Y; Layer ▸ New ▸ Solid).
 */



import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  sanitizeLayerSize,
} from './layerSettings';

beforeAll(() => {
  // The inserts reach the command system — boot a minimal one.
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) } as unknown as ConstructorParameters<typeof CommandSystem>[0]));
});

describe('Solid Settings', () => {

  it('clamps and rounds a typed size into AE’s range', () => {
    expect(sanitizeLayerSize(0)).toBe(1);
    expect(sanitizeLayerSize(99999)).toBe(30000);
    expect(sanitizeLayerSize(12.6)).toBe(13);
    expect(sanitizeLayerSize(Number('abc'))).toBeNull();
  });
});
