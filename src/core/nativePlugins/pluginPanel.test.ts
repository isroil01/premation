import {
  PANEL_SANDBOX,
  base64ToBytes,
  bytesToBase64,
  panelCommand,
  panelLabel,
  panelReply,
  panelState,
  panelUrl,
  parsePanelMessage,
} from './pluginPanel';

const T = { layer: 'L1', effectId: 'fx_1', time: 705_600_000 };

describe('plugin panel protocol', () => {
  it('addresses the bundle by plugin id, scripts-only sandbox', () => {
    expect(panelUrl('com.premation.samples.rings')).toBe('plugin-ui://com.premation.samples.rings/index.html');
    expect(panelUrl('Com.Vendor.X')).toBe('plugin-ui://com.vendor.x/index.html');
    expect(PANEL_SANDBOX).toBe('allow-scripts');
  });

  it('drops anything that is not a well-formed request', () => {
    expect(parsePanelMessage(null)).toBeNull();
    expect(parsePanelMessage('ready')).toBeNull();
    expect(parsePanelMessage({ type: 'ready' })).toBeNull(); // no protocol marker
    expect(parsePanelMessage({ premation: 2, type: 'ready' })).toBeNull();
    expect(parsePanelMessage({ premation: 1, type: 'setParam', key: 'p1', value: 1 })).toBeNull(); // no id
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'setParam', key: 'opacity', value: 1 })).toBeNull(); // not a plugin key
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'setParam', key: 'p1/../x', value: 1 })).toBeNull();
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'setParam', key: 'p1', value: Infinity })).toBeNull();
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'setParam', key: 'p1', value: 'x' })).toBeNull();
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'setArbitraryData', key: 'p2', data: 'not base64!' })).toBeNull();
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'invokeButton', key: 'p9', payload: 'x'.repeat(70_000) })).toBeNull();
    expect(parsePanelMessage({ premation: 1, id: 1, type: 'eval', code: '1' })).toBeNull();
  });

  it('parses each request', () => {
    expect(parsePanelMessage({ premation: 1, type: 'ready' })).toEqual({ type: 'ready' });
    expect(parsePanelMessage({ premation: 1, id: 3, type: 'setParam', key: 'p1X', value: 12 })).toEqual({ id: 3, type: 'setParam', key: 'p1X', value: 12 });
    expect(parsePanelMessage({ premation: 1, id: 3, type: 'setParam', key: 'p5', value: { r: 1, g: 0, b: 0 } })).toEqual({
      id: 3, type: 'setParam', key: 'p5', value: { r: 1, g: 0, b: 0 },
    });
    expect(parsePanelMessage({ premation: 1, id: 4, type: 'invokeButton', key: 'p9', payload: '#ff0000' })).toEqual({
      id: 4, type: 'invokeButton', key: 'p9', payload: '#ff0000',
    });
    expect(parsePanelMessage({ premation: 1, id: 5, type: 'requestPreview', maxSize: 99999 })).toEqual({ id: 5, type: 'requestPreview', maxSize: 1024 });
    expect(parsePanelMessage({ premation: 1, id: 5, type: 'requestPreview' })).toEqual({ id: 5, type: 'requestPreview', maxSize: 512 });
  });

  it('turns edits into engine commands on the effect it was opened for', () => {
    expect(panelCommand({ id: 1, type: 'setParam', key: 'p2', value: 30 }, T)).toEqual({
      type: 'setProperty', prop: { layer: 'L1', path: 'effects/fx_1/p2' }, value: { kind: 'scalar', value: 30 }, time: T.time,
    });
    expect(panelCommand({ id: 1, type: 'setParam', key: 'p5', value: { r: 1, g: 0.5, b: 0 } }, T)).toMatchObject({
      value: { kind: 'color', value: { r: 1, g: 0.5, b: 0, a: 1 } },
    });
    expect(panelCommand({ id: 1, type: 'setParam', key: 'p6', value: true }, T)).toMatchObject({ value: { kind: 'bool', value: true } });
    expect(panelCommand({ id: 1, type: 'invokeButton', key: 'p9', payload: '#00ff00' }, T)).toEqual({
      type: 'invokeEffectAction', group: { layer: 'L1', path: 'effects/fx_1' }, action: 'p9', payload: '#00ff00',
    });
    const arb = panelCommand({ id: 1, type: 'setArbitraryData', key: 'p3', data: 'AQID' }, T);
    expect(arb).toMatchObject({ type: 'setPluginData', layer: 'L1', group: 'effects/fx_1', key: 'arb:p3' });
    expect(Array.from((arb as { data: Uint8Array }).data)).toEqual([1, 2, 3]);
  });

  it('labels the undo entry with the param the plugin shows', () => {
    const params = [{ key: 'p1', name: 'Center', enabled: true, hidden: false }];
    expect(panelLabel({ id: 1, type: 'setParam', key: 'p1X', value: 1 }, 'Rings', params)).toBe('Rings: Center');
    expect(panelLabel({ id: 1, type: 'invokeButton', key: 'p42' }, 'Rings', params)).toBe('Rings');
  });

  it('sends state with the plugin data as base64, and replies', () => {
    const s = panelState({
      effect: { id: 'fx_1', type: 'com.x', name: 'Rings' },
      plugin: 'com.x',
      time: 1,
      params: [{ key: 'p1', name: 'Center', enabled: true, hidden: false }],
      values: { p1X: 0 },
      data: [{ key: 'sequence', data: new Uint8Array([1, 2, 3]) }],
    });
    expect(s).toMatchObject({ premation: 1, type: 'state', data: { sequence: 'AQID' }, values: { p1X: 0 } });
    expect(Array.from(base64ToBytes(bytesToBase64(new Uint8Array([0, 255, 7]))))).toEqual([0, 255, 7]);
    expect(panelReply(2, { ok: false, error: 'no' })).toEqual({ premation: 1, type: 'reply', id: 2, ok: false, error: 'no' });
    expect(panelReply(2, { ok: true })).toEqual({ premation: 1, type: 'reply', id: 2, ok: true });
  });
});
