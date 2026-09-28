/**
 * Animation ▸ Keyframe Assistant entries must be registered commands, not
 * TopNav-only doors. A menu id with no registry entry greys out forever.
 */

import { readSource } from '@/__testHelpers__/readSource';

const ASSISTANTS: ReadonlyArray<string> = [
  'animation.easyEaseAll',
  'animation.timeReverseKeyframes',
  'animation.exponentialScale',
  'animation.smoother',
  'animation.wiggler',
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

  it('Cmd/Ctrl+Alt+R is Time-Reverse LAYER (AE), and Time-Reverse Keyframes has no chord', () => {
    // AE binds Ctrl+Alt+R to Layer ▸ Time ▸ Time-Reverse Layer; its keyframe
    // assistant ships unbound. The chord used to sit on the keyframe one.
    const at = providers.indexOf(`asCommandId('animation.timeReverseKeyframes')`);
    expect(at).toBeGreaterThan(0);
    const next = providers.indexOf('asCommandId(', at + 1);
    const block = providers.slice(at, next < 0 ? providers.length : next);
    expect(block).not.toMatch(/shortcut:/);

    const time = readSource('providers/commands/layerTimeCommands.ts');
    const layerAt = time.indexOf(`asCommandId('time.reverseLayer')`);
    expect(layerAt).toBeGreaterThan(0);
    const layerBlock = time.slice(layerAt, time.indexOf('asCommandId(', layerAt + 1));
    expect(layerBlock).toMatch(/shortcut:\s*\{\s*key:\s*'r',\s*meta:\s*true,\s*alt:\s*true/);
  });
});
