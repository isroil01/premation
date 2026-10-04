/**
 * Multi-fill / multi-stroke stacks — array APIs, legacy migration, and the
 * primary-slot mirroring contract (fills[0] ↔ legacy fx.fill).
 */



import {
  defaultStroke,
  
  
  
  
  normalizeStroke,
} from './stroke';

describe('stroke stacks', () => {

  it('a gradient stroke paint survives normalization; junk paint is dropped', () => {
    const grad = normalizeStroke({
      ...defaultStroke(),
      paint: { type: 'linear', angle: 45, stops: [{ id: 's1', offset: 0, color: '#fff' }, { id: 's2', offset: 1, color: '#000' }] },
    });
    expect(grad.paint?.type).toBe('linear');
    const junk = normalizeStroke({ ...defaultStroke(), paint: { type: 'nope' } as never });
    expect(junk.paint).toBeUndefined();
  });
});
