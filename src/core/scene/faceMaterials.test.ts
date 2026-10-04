
import { EXTRUSION_WALL_GAIN, EXTRUSION_BACK_GAIN } from '@core/scene/extrusion';
import {
  faceKindOf, resolveFaceMaterial,  
   DEFAULT_FACE_GAIN,
} from './faceMaterials';

describe('faceKindOf', () => {
  it('separates side walls, bevel chamfers and the back cap', () => {
    expect(faceKindOf('wall', 'r')).toBe('side');
    expect(faceKindOf('wall', 'w7')).toBe('side');   // ellipse wall segment
    // Bevels ride role 'wall' — only the `c` suffix distinguishes them.
    expect(faceKindOf('wall', 'cfr')).toBe('bevel');
    expect(faceKindOf('wall', 'cbl')).toBe('bevel');
    expect(faceKindOf('back', 'back')).toBe('back');
  });
});

describe('resolveFaceMaterial', () => {
  it('falls back to the layer fill dimmed by the kind default', () => {
    expect(resolveFaceMaterial({}, 'side', '#ff0000')).toEqual({ fill: '#ff0000', gain: EXTRUSION_WALL_GAIN });
    expect(resolveFaceMaterial({}, 'back', '#ff0000')).toEqual({ fill: '#ff0000', gain: EXTRUSION_BACK_GAIN });
  });

  it('an explicit fill wins, and gain is independently overridable', () => {
    expect(resolveFaceMaterial({ side: { fill: '#00ff00' } }, 'side', '#ff0000').fill).toBe('#00ff00');
    expect(resolveFaceMaterial({ side: { gain: 0.3 } }, 'side', '#ff0000').gain).toBe(0.3);
  });
});

describe('face material writes', () => {

  it('default gains match the constants the renderer used to hardcode', () => {
    expect(DEFAULT_FACE_GAIN.side).toBe(EXTRUSION_WALL_GAIN);
    expect(DEFAULT_FACE_GAIN.back).toBe(EXTRUSION_BACK_GAIN);
  });
});
