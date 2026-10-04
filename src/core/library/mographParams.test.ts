/**
 * Editable blanks on an inserted motion-graphics element.
 *
 * The derivation is the contract here: nothing declares a per-item manifest, so
 * if the walk stops matching how the catalog builds its nodes, every item
 * silently loses its fields at once. These assertions run over the REAL
 * catalog for that reason.
 */



import {
     partLabel, 
} from './mographParams';

describe('partLabel', () => {

  it('reads the authored suffix, not the generated prefix', () => {
    expect(partLabel('mg_3_kf9a', 'mg_3_kf9a_role')).toBe('Role');
    expect(partLabel('mg_3_kf9a', 'mg_3_kf9a_sub_title')).toBe('Sub Title');
  });
});
