/**
 * Animation ▸ Keyframe Assistant entries must be registered commands, not
 * TopNav-only doors. A menu id with no registry entry greys out forever.
 */

import { readSource } from '@/__testHelpers__/readSource';

const ASSISTANTS: ReadonlyArray<string> = [
  'animation.easyEaseAll',
  'animation.timeReverseKeyframes',
  'animation.exponentialScale',
  'animation.sequenceLayerBars',
  'animation.sequenceLayers',
  'animation.motionSketch',
  'animation.convertAudioToKeyframes',
  'animation.convertExpressionToKeyframes',
];

describe('Animation menu keyframe assistants', () => {
  const menu = readSource('layout/Menu/menuModel.ts');
  const providers = readSource('providers/Providers.tsx');

  it.each(ASSISTANTS)('%s is on the Animation menu and registered', (id) => {
    expect(menu).toContain(`commandId: '${id}'`);
    expect(providers).toContain(`asCommandId('${id}')`);
  });

  it('Time-Reverse ships with the AE chord (Cmd/Ctrl+Alt+R)', () => {
    const at = providers.indexOf(`asCommandId('animation.timeReverseKeyframes')`);
    expect(at).toBeGreaterThan(0);
    const next = providers.indexOf('asCommandId(', at + 1);
    const block = providers.slice(at, next < 0 ? providers.length : next);
    expect(block).toMatch(/shortcut:\s*\{\s*key:\s*'r',\s*meta:\s*true,\s*alt:\s*true/);
  });
});
