/**
 * The `en-XA` pseudo-locale transform. See `LOCALES` in `locales.ts`.
 *
 *   "New Project…"      →  "[Ñéŵ Ƥŕöĵéçţ… ····]"
 *   "Recall {n}"        →  "[Ŕéçåļļ {n} ···]"
 *
 * `{placeholders}` pass through untouched: they are filled in AFTER this runs,
 * and an accented `{ñ}` would no longer match its variable.
 */

const ACCENTED: Readonly<Record<string, string>> = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Ƥ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** Roughly how much longer German or Russian runs than English. */
const EXPANSION = 0.35;

export function pseudoLocalize(template: string): string {
  let letters = 0;
  const body = template
    .split(/(\{[a-zA-Z0-9_]+\})/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // a placeholder
      return part.replace(/[a-zA-Z]/g, (ch) => {
        letters += 1;
        return ACCENTED[ch] ?? ch;
      });
    })
    .join('');
  const pad = Math.max(1, Math.ceil(letters * EXPANSION));
  return `[${body} ${'·'.repeat(pad)}]`;
}
