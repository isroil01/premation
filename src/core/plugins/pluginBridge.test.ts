/**
 * The plugin postMessage bridge must ignore anything it did not invite.
 *
 * It used to accept a keyframe write from any window that could reach this one.
 */

import pluginHost from './PluginHost';
import { defaultAnimation } from '@motion/animation';

/** A stand-in for a plugin frame's window (identity is all that matters). */
const frameA = {} as unknown as MessageEventSource;
const frameB = {} as unknown as MessageEventSource;

function send(source: MessageEventSource | null, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data });
  // jsdom does not let a MessageEvent carry an arbitrary source/origin.
  Object.defineProperty(ev, 'source', { value: source });
  Object.defineProperty(ev, 'origin', { value: origin });
  window.dispatchEvent(ev);
}

const KF = { type: 'SET_KEYFRAME', nodeId: 'bridge_test_node', property: 'x', time: 1, value: 42 };

describe('plugin postMessage bridge', () => {
  beforeEach(() => {
    defaultAnimation.clearNode('bridge_test_node');
  });

  it('ignores a message from an unregistered window', () => {
    send(frameA, 'https://evil.example', KF);
    expect(defaultAnimation.sample('bridge_test_node', 'x', 1)).toBeUndefined();
  });

  it('ignores a message with no source at all', () => {
    send(null, 'https://evil.example', KF);
    expect(defaultAnimation.sample('bridge_test_node', 'x', 1)).toBeUndefined();
  });

  it('accepts a keyframe from a registered frame on its registered origin', () => {
    const off = pluginHost.registerFrame(frameA, 'https://plugin.example');
    send(frameA, 'https://plugin.example', KF);
    expect(defaultAnimation.sample('bridge_test_node', 'x', 1)).toBe(42);
    off();
  });

  it('rejects a registered frame that has navigated to another origin', () => {
    const off = pluginHost.registerFrame(frameA, 'https://plugin.example');
    send(frameA, 'https://evil.example', KF);
    expect(defaultAnimation.sample('bridge_test_node', 'x', 1)).toBeUndefined();
    off();
  });

  it('does not let one registered frame speak for another window', () => {
    const off = pluginHost.registerFrame(frameA, 'https://plugin.example');
    send(frameB, 'https://plugin.example', KF);
    expect(defaultAnimation.sample('bridge_test_node', 'x', 1)).toBeUndefined();
    off();
  });

  it('stops accepting messages once the frame is unregistered', () => {
    const off = pluginHost.registerFrame(frameA, 'https://plugin.example');
    off();
    send(frameA, 'https://plugin.example', KF);
    expect(defaultAnimation.sample('bridge_test_node', 'x', 1)).toBeUndefined();
  });

  it('rejects a non-finite time instead of writing it at zero', () => {
    const off = pluginHost.registerFrame(frameA, 'https://plugin.example');
    send(frameA, 'https://plugin.example', { ...KF, time: 'soon' });
    expect(defaultAnimation.isAnimated('bridge_test_node', 'x')).toBe(false);
    off();
  });
});
