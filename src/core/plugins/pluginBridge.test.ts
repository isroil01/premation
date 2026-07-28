/**
 * The panel postMessage bridge must ignore anything it did not invite.
 *
 * Two properties are under test, and the second is new:
 *
 *   1. **Provenance.** `window.addEventListener('message')` fires for anything
 *      that can reach this window — an embedder, an opener, an injected frame.
 *      Only a frame the host itself created, still registered, still on its
 *      registered origin, is heard.
 *   2. **Routing.** A panel message is no longer an instruction. It used to be
 *      `{ type: 'SET_KEYFRAME', nodeId, … }` — a frame naming a layer and
 *      writing to it. Now a panel can only reach ITS OWN plugin's worker, and
 *      which plugin that is comes from the frame registration, not from
 *      anything the message says. A panel cannot name a layer, a method, or
 *      another plugin.
 */

import pluginHost from './PluginHost';

/** Stand-ins for plugin frame windows (identity is all that matters). */
const frameA = {} as unknown as MessageEventSource;
const frameB = {} as unknown as MessageEventSource;

function send(source: MessageEventSource | null, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data });
  // jsdom does not let a MessageEvent carry an arbitrary source/origin.
  Object.defineProperty(ev, 'source', { value: source });
  Object.defineProperty(ev, 'origin', { value: origin });
  window.dispatchEvent(ev);
}

/** Capture what the bridge forwards, without booting a real worker. */
function spyOnDelivery(): { calls: Array<[string, unknown]>; restore: () => void } {
  const calls: Array<[string, unknown]> = [];
  const host = pluginHost as unknown as { deliverPanelMessage: (id: string, data: unknown) => void };
  const original = host.deliverPanelMessage;
  host.deliverPanelMessage = (id, data) => { calls.push([id, data]); };
  return { calls, restore: () => { host.deliverPanelMessage = original; } };
}

describe('plugin panel postMessage bridge', () => {
  let spy: ReturnType<typeof spyOnDelivery>;

  beforeEach(() => { spy = spyOnDelivery(); });
  afterEach(() => { spy.restore(); });

  it('ignores a message from an unregistered window', () => {
    send(frameA, 'null', { data: { hello: 1 } });
    expect(spy.calls).toEqual([]);
  });

  it('ignores a message with no source at all', () => {
    send(null, 'null', { data: { hello: 1 } });
    expect(spy.calls).toEqual([]);
  });

  it('forwards a registered, claimed frame to its own plugin', () => {
    const offFrame = pluginHost.registerFrame(frameA, 'null');
    const offOwner = pluginHost.claimFrame(frameA, 'com.example.a');
    send(frameA, 'null', { data: { hello: 1 } });
    expect(spy.calls).toEqual([['com.example.a', { hello: 1 }]]);
    offOwner();
    offFrame();
  });

  it('rejects a registered frame that has navigated to another origin', () => {
    const offFrame = pluginHost.registerFrame(frameA, 'null');
    const offOwner = pluginHost.claimFrame(frameA, 'com.example.a');
    send(frameA, 'https://evil.example', { data: { hello: 1 } });
    expect(spy.calls).toEqual([]);
    offOwner();
    offFrame();
  });

  it('does not let one registered frame speak for another window', () => {
    const offFrame = pluginHost.registerFrame(frameA, 'null');
    const offOwner = pluginHost.claimFrame(frameA, 'com.example.a');
    send(frameB, 'null', { data: { hello: 1 } });
    expect(spy.calls).toEqual([]);
    offOwner();
    offFrame();
  });

  it('drops a frame that is registered but not claimed by any plugin', () => {
    // Registration alone says "this window is ours"; it does not say whose.
    // Without an owner there is no worker to route to, and guessing would be
    // exactly the cross-plugin leak this split prevents.
    const offFrame = pluginHost.registerFrame(frameA, 'null');
    send(frameA, 'null', { data: { hello: 1 } });
    expect(spy.calls).toEqual([]);
    offFrame();
  });

  it('stops forwarding once the frame is unregistered', () => {
    const offFrame = pluginHost.registerFrame(frameA, 'null');
    const offOwner = pluginHost.claimFrame(frameA, 'com.example.a');
    offFrame();
    send(frameA, 'null', { data: { hello: 1 } });
    expect(spy.calls).toEqual([]);
    offOwner();
  });

  it('cannot address a plugin other than the one that owns the frame', () => {
    const offFrame = pluginHost.registerFrame(frameA, 'null');
    const offOwner = pluginHost.claimFrame(frameA, 'com.example.a');
    // The payload names a different plugin. Routing ignores it entirely.
    send(frameA, 'null', { pluginId: 'com.example.victim', data: { hello: 1 } });
    expect(spy.calls).toEqual([['com.example.a', { hello: 1 }]]);
    offOwner();
    offFrame();
  });
});
