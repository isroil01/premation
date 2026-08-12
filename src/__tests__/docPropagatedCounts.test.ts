/**
 * Prose must never restate a number the §1 table holds.
 *
 * ── The failure this closes ─────────────────────────────────────────────────
 *
 * `docFeatureCounts.test.ts` pins the counts inside the `FEATURE-COUNTS`
 * markers, and says so in its own docstring: "This asserts counts, not prose.
 * Prose still rots." It did. `EffectType` grew to 145 while three sentences of
 * `EDITOR_REFERENCE.md` §4 and one line each of `README.md` and `ROADMAP.md`
 * went on asserting **73** — with total confidence, in the two most-read files
 * in the repo. That wrong number was then copied into every brief written
 * against the document.
 *
 * This is the SECOND time the same number propagated the same way. The §5
 * ledger records the first: "`README.md` and `ROADMAP.md`: '58 effects'" →
 * corrected to 73, with the note that "the count guard existed but was scoped
 * to this file's marked table, so the number was corrected here and left wrong
 * in the two most-read files in the repo". The scope was never widened, so the
 * identical drift happened again one registry-growth later. Hence this file
 * covers all three documents, not just the reference.
 *
 * ── Why adjacency, and not "every number near the word" ─────────────────────
 *
 * The obvious rule — flag any integer in a paragraph mentioning a registry —
 * was measured against these documents and produced 39 hits, essentially all
 * noise: dates (`2026-08-11`), measurements (`368 ms`), effect indices
 * (`effect **75**`), version numbers, `3D`. A guard with a 39-entry
 * allow-list is a guard nobody will maintain, and one that gets bypassed by
 * appending to the allow-list the first time it fires.
 *
 * So the rule is narrow and syntactic: a digit-string IMMEDIATELY followed by a
 * registry's name — "73 effects", "36 blend modes" — is a claim about that
 * registry's size, and must equal it. Nothing else is inspected. That form is
 * exactly how the drift propagated both times, and it is how a person naturally
 * writes the claim.
 *
 * The cost of the narrowness is that prose can still state a count obliquely
 * ("Effect breadth: 73 vs AE's 400+") and escape. That sentence existed and did
 * escape; it was rewritten into the checkable form rather than the rule being
 * widened to catch it. Prose that states a count should say "<N> effects",
 * which is both clearer and guarded — widening the regex until it caught the
 * oblique phrasing would have meant admitting the 39 hits above.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { featureSizes } = require('../../scripts/featureCounts.cjs') as {
  featureSizes: () => Record<string, number>;
};

/** Every document that states feature counts in prose. */
const DOCS = ['docs/EDITOR_REFERENCE.md', 'README.md', 'ROADMAP.md'] as const;

/**
 * How a registry is named in prose → its key in `featureSizes()`.
 *
 * Longest-first: "AI tools" and "canvas tools" must be tried before a bare
 * "tools", or "61 AI tools" would be checked against the canvas-tool count.
 */
const NOUNS: ReadonlyArray<readonly [string, string]> = [
  ['blend modes?', 'blendModes'],
  ['layer styles?', 'layerStyles'],
  ['path operators?', 'pathOps'],
  ['mask modes?', 'maskModes'],
  ['light types?', 'lightTypes'],
  ['AI tools?', 'aiTools'],
  ['canvas tools?', 'tools'],
  ['export formats?', 'exportFormats'],
  ['Zustand stores?', 'stores'],
  ['packages?', 'packages'],
  ['effects?', 'effects'],
];

/**
 * Claims that name a SUPERSEDED count on purpose, and why.
 *
 * The §5 ledger's whole function is to record what a document used to say, so
 * it necessarily quotes numbers that are no longer true. Each entry here is a
 * deliberate historical quote; the reason is required so that adding one is a
 * decision rather than a way to silence the test.
 *
 * Matched against the surrounding sentence, not just the phrase, so "38
 * effects" is exempt where the ledger quotes it and NOT exempt if it appears
 * somewhere new.
 */
const HISTORICAL: ReadonlyArray<{ phrase: string; near: string; why: string }> = [
  {
    phrase: '38 effects',
    // `near` is matched against the PLAIN text, so it carries no backticks or
    // asterisks — `PREMATION_COMPLETE_REFERENCE.md` arrives here as
    // PREMATIONCOMPLETEREFERENCE.md.
    near: 'The previous reference',
    why: '§0 recounting what the deleted predecessor claimed. The point of the sentence is that the number was wrong, so quoting it IS the content.',
  },
  {
    phrase: '58 effects',
    near: 'The previous reference',
    why: 'Same sentence — the predecessor held two different wrong counts in one file, which is the whole anecdote.',
  },
];

/**
 * A row of the §5 corrections ledger, whose entire function is to quote
 * superseded claims.
 *
 * Structural rather than a list of phrases, for two reasons. The phrases sit
 * far from any usable anchor — a ledger row's own text is `| "62 AI tools" |
 * 61 |`, and the nearest words identifying it as history are the table header
 * hundreds of characters above. And a per-phrase list would mean every new
 * ledger entry that quotes a count also edits this test, which is friction on
 * exactly the habit the ledger exists to encourage.
 *
 * Narrow enough to stay useful: it exempts TABLE ROWS inside §5 only. Ordinary
 * prose in §5 — including every "Fixed <date>" narrative below the tables — is
 * still checked, so a live claim written there is caught like any other.
 */
function isLedgerRow(body: string, index: number): boolean {
  const ledgerStart = body.indexOf('## 5. Corrections');
  if (ledgerStart < 0 || index < ledgerStart) return false;
  const lineStart = body.lastIndexOf('\n', index) + 1;
  return body.charAt(lineStart) === '|';
}

/** Markdown emphasis around a number is invisible to a reader and must be to
 *  this test: `**73** effects` is the same claim as `73 effects`. */
function plain(md: string): string {
  return md.replace(/[*`_]/g, '');
}

interface Claim {
  doc: string;
  text: string;
  key: string;
  claimed: number;
  actual: number;
  context: string;
}

function claimsIn(doc: string, counts: Record<string, number>): Claim[] {
  const raw = readFileSync(join(__dirname, '../..', doc), 'utf8');
  // The generated table is `docFeatureCounts.test.ts`'s business, and it states
  // the counts in exactly the form this test looks for — so leaving it in would
  // mean two tests asserting one thing and a table that can never drift being
  // reported as if it might.
  const body = plain(raw.replace(/<!-- FEATURE-COUNTS -->[\s\S]*?<!-- \/FEATURE-COUNTS -->/, ''));
  const re = new RegExp(String.raw`\b(\d{1,4})\s+(${NOUNS.map(([n]) => n).join('|')})\b`, 'gi');
  const out: Claim[] = [];
  for (const m of body.matchAll(re)) {
    const noun = m[2]!;
    const entry = NOUNS.find(([n]) => new RegExp(`^${n}$`, 'i').test(noun))!;
    const key = entry[1];
    const claimed = Number(m[1]);
    if (claimed === counts[key]) continue;
    const context = body.slice(Math.max(0, m.index! - 160), m.index! + 160).replace(/\s+/g, ' ');
    if (isLedgerRow(body, m.index!)) continue;
    const exempt = HISTORICAL.some(
      (h) => new RegExp(`^${h.phrase}$`, 'i').test(m[0]!.replace(/\s+/g, ' ')) && context.includes(h.near),
    );
    if (exempt) continue;
    out.push({ doc, text: m[0]!, key, claimed, actual: counts[key]!, context });
  }
  return out;
}

describe('feature counts stated in prose', () => {
  const counts = featureSizes();

  it('every "N <registry>" claim across the docs equals the registry', () => {
    const drift = DOCS.flatMap((d) => claimsIn(d, counts));
    // Reported as the full list rather than one at a time: this defect arrives
    // in batches (one registry grows, every document that mentions it goes
    // stale at once), and fixing them one test run at a time is how the last
    // round left README and ROADMAP behind.
    expect(drift.map((c) => `${c.doc}: "${c.text}" — ${c.key} is ${c.actual}\n    …${c.context}…`)).toEqual([]);
  });

  /*
    This is the ONLY end-to-end falsification of the regex, deliberately.

    A second one injected a stale count into a real document and broke twice:
    once when the registry grew past the number it hardcoded, and again when
    that document was rewritten without stating a count at all. Both times it
    failed for a reason unrelated to the rule — and the second time no document
    stated the effect count anywhere, so the test could not be repaired, only
    re-pointed at a moving target. A synthetic string proves the same thing and
    cannot rot.
  */
  it('catches a fresh drift, so the exemptions cannot hollow it out', () => {
    // The allow-list matches a phrase AND its surrounding text. A superseded
    // count reappearing somewhere new is therefore still caught, which is what
    // stops `HISTORICAL` from becoming a way to retire the check.
    const fake = 'The renderer ships 58 effects and 3 blend modes today.';
    const re = new RegExp(String.raw`\b(\d{1,4})\s+(${NOUNS.map(([n]) => n).join('|')})\b`, 'gi');
    const hits = [...fake.matchAll(re)].map((m) => m[0]);
    expect(hits).toEqual(['58 effects', '3 blend modes']);
    for (const h of hits) {
      const key = h.includes('blend') ? 'blendModes' : 'effects';
      expect(Number(h.split(' ')[0])).not.toBe(counts[key]);
    }
  });

  it('the ledger exemption covers table rows only, not §5 prose', () => {
    // The one way this guard could be quietly retired is by the §5 exemption
    // growing to cover the whole section — §5 is long, and most of it is
    // narrative rather than table. So the boundary is asserted directly.
    const md = plain(readFileSync(join(__dirname, '../..', DOCS[0]), 'utf8'));
    const ledgerAt = md.indexOf('## 5. Corrections');
    expect(ledgerAt).toBeGreaterThan(0);
    const rowAt = md.indexOf('\n| "38 effects"', ledgerAt);
    expect(rowAt).toBeGreaterThan(0);
    expect(isLedgerRow(md, rowAt + 3)).toBe(true);
    // A prose sentence inside §5 is NOT exempt. `Fixed 2026-08-12` headings and
    // the paragraphs under them are where new claims actually get written.
    const proseAt = md.indexOf('Fixed 2026-08-12', ledgerAt);
    expect(proseAt).toBeGreaterThan(0);
    expect(isLedgerRow(md, proseAt + 3)).toBe(false);
    // And nothing before §5 is exempt, whatever it looks like.
    expect(isLedgerRow(md, Math.floor(ledgerAt / 2))).toBe(false);
  });

  it('every HISTORICAL exemption still matches something, and says why', () => {
    // An exemption whose text has been edited away is dead weight that makes
    // the list look better-justified than it is — the same "dead entry" shape
    // the effects registry has been bitten by.
    const all = DOCS.map((d) => plain(readFileSync(join(__dirname, '../..', d), 'utf8'))).join('\n');
    for (const h of HISTORICAL) {
      expect([h.phrase, h.why.length > 30]).toEqual([h.phrase, true]);
      expect([h.phrase, all.includes(h.phrase) && all.includes(h.near)]).toEqual([h.phrase, true]);
    }
  });
});
