import {
  
  
  
  
  
  normalizeMaterialParams,
  DEFAULT_MATERIAL_PARAMS,
  
} from './material';

describe('material params — the reusable half', () => {
  beforeEach(() => {
  });

  it('normalizes junk to the default surface rather than to zero', () => {
    const m = normalizeMaterialParams({ diffuse: 'lots', shading: 'wireframe', toonBands: 99, metal: 40 });
    expect(m.diffuse).toBe(DEFAULT_MATERIAL_PARAMS.diffuse);
    expect(m.shading).toBe('phong');
    expect(m.toonBands).toBe(8);
    expect(m.metal).toBe(40);
    expect(normalizeMaterialParams(null)).toEqual(DEFAULT_MATERIAL_PARAMS);
  });
});
