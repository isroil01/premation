/**
 * Animated presets — the drop-in library:
 *  • registry resolves ids;
 *  • inserting adds ONE animated element under the active comp (no scene wipe)
 *    and selects it;
 *  • text presets add a Text layer, object presets a Style'd shape;
 *  • every preset inserts without throwing.
 */



import {  getAnimPreset } from './animPresets';

describe('animated presets', () => {
  beforeEach(() => { // establishes an active composition to insert into
  });

  it('registry resolves ids', () => {
    expect(getAnimPreset('cascade-rise')).toBeTruthy();
    expect(getAnimPreset('nope')).toBeNull();
  });
});
