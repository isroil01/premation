import { LOCALES, PSEUDO_LOCALE, availableLocales, matchSystemLocale, resolveLocale } from './locales';
import { pseudoLocalize } from './pseudo';
import { t, setCatalogue } from './t';

afterEach(() => setCatalogue({}));

describe('locale registry', () => {
  it('names every language in itself, with unique codes', () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const l of LOCALES) expect(l.nativeName.trim()).not.toBe('');
  });

  it('keeps the pseudo-locale out of release builds', () => {
    expect(availableLocales(false).map((l) => l.code)).not.toContain(PSEUDO_LOCALE);
    expect(availableLocales(true).map((l) => l.code)).toContain(PSEUDO_LOCALE);
  });
});

describe('matchSystemLocale', () => {
  it('matches on subtag boundaries, case-insensitively', () => {
    expect(matchSystemLocale(['en-GB'], false)).toBe('en');
    expect(matchSystemLocale(['EN-us'], false)).toBe('en');
  });

  it('falls back to English for a system language nothing claims', () => {
    expect(matchSystemLocale(['xx-YY'], false)).toBe('en');
    expect(matchSystemLocale([], false)).toBe('en');
  });

  it('never auto-selects a dev-only locale', () => {
    expect(matchSystemLocale(['en-XA'], true)).toBe('en');
  });
});

describe('resolveLocale', () => {
  it('prefers a saved choice this build offers', () => {
    expect(resolveLocale(PSEUDO_LOCALE, ['en-US'], true)).toBe(PSEUDO_LOCALE);
  });

  it('ignores a saved choice this build does not offer', () => {
    // A dev machine's pseudo choice must not stick a release on nothing.
    expect(resolveLocale(PSEUDO_LOCALE, ['en-US'], false)).toBe('en');
    expect(resolveLocale('tlh', ['en-US'], false)).toBe('en');
  });
});

describe('pseudoLocalize', () => {
  it('accents, brackets and lengthens the text', () => {
    const out = pseudoLocalize('New Project');
    expect(out.startsWith('[Ñéŵ Ƥŕöĵéçţ ')).toBe(true);
    expect(out.endsWith('·]')).toBe(true);
    expect(out.length).toBeGreaterThan('New Project'.length + 4);
  });

  it('leaves placeholders intact so interpolation still fills them', () => {
    setCatalogue({}, { transform: pseudoLocalize });
    expect(t('menu.recall', 'Recall {n}', { n: 3 })).toMatch(/^\[Ŕéçåļļ 3 ·+\]$/);
  });
});
