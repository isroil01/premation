/**
 * What comes back from the project Save dialog.
 *
 * WHY THIS EXISTS. Save As "oops.mp4" wrote the project JSON into a file named
 * oops.mp4 and titled the project "oops.mp4": the dialog's filters suggest an
 * extension, they do not bind what the user types. The rule lives in the main
 * process because that is the one place every save route's path passes through.
 */

import { enforceProjectExtension, PROJECT_SAVE_EXTENSIONS } from './projectSavePath';

describe('enforceProjectExtension', () => {
  it('leaves a project path exactly as chosen', () => {
    for (const p of ['C:\\work\\Promo.motion', '/home/u/Hero.json', '/home/u/LOUD.MOTION']) {
      expect(enforceProjectExtension(p)).toEqual({ path: p, changed: false });
    }
  });

  it('appends .motion to a foreign extension — and can never land ON the foreign file', () => {
    expect(enforceProjectExtension('C:\\work\\oops.mp4')).toEqual({ path: 'C:\\work\\oops.mp4.motion', changed: true });
    expect(enforceProjectExtension('/work/notes.txt').path).toBe('/work/notes.txt.motion');
  });

  it('appends .motion when there is no extension at all', () => {
    expect(enforceProjectExtension('/work/Promo')).toEqual({ path: '/work/Promo.motion', changed: true });
  });

  it('does not mistake a version number for an extension to keep', () => {
    expect(enforceProjectExtension('/work/Logo v1.2').path).toBe('/work/Logo v1.2.motion');
  });

  it('tidies a trailing dot rather than producing "name..motion"', () => {
    expect(enforceProjectExtension('C:\\work\\Promo.').path).toBe('C:\\work\\Promo.motion');
  });

  it('reports `changed` so the caller knows the OS never asked about THIS path', () => {
    expect(enforceProjectExtension('/work/a.mp4').changed).toBe(true);
    expect(enforceProjectExtension('/work/a.motion').changed).toBe(false);
  });

  it('accepts exactly the extensions the dialog filter offers', () => {
    expect([...PROJECT_SAVE_EXTENSIONS]).toEqual(['motion', 'json']);
  });
});
