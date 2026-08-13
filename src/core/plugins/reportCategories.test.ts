/**
 * The report vocabulary is one vocabulary.
 *
 * The editor offers a list of radio buttons; the server validates against a
 * Postgres enum. Neither can import the other — they deploy separately and
 * build separately — so the failure mode is quiet and one-directional: the
 * editor offers a category the enum does not accept, and every report of that
 * kind 400s while the reporter is thanked and told nothing.
 *
 * That is the worst possible way for this to break. It fails only for the
 * category nobody tested, it fails silently, and the person it fails for is
 * someone trying to tell us a plugin is stealing their work.
 *
 * So both repos carry a byte-identical fixture and each asserts its own copy
 * against it — the same shape `permissionStrings.test.ts` uses, and for the
 * same reason.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_CATEGORIES, REPORT_CATEGORY_TEXT, type ReportCategory } from './reportCategories';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'reportCategories.json'), 'utf8'),
) as { categories: string[] };

describe('the shared report vocabulary', () => {
  it('matches the fixture exactly, in order', () => {
    /*
      Order included on purpose. It is the order the radio buttons render in,
      and the first option is the one a hurried reporter picks — so it is a
      product decision, not an implementation detail, and it belongs under the
      same guard as the values themselves.
    */
    expect([...REPORT_CATEGORIES]).toEqual(fixture.categories);
  });

  it('leads with the category that matters most', () => {
    // A malicious plugin is the one report that needs to reach a human today.
    // If it drifts down the list behind "broken", the queue's urgency signal
    // degrades before anyone notices.
    expect(REPORT_CATEGORIES[0]).toBe('malicious');
  });

  it('describes every category in plain language', () => {
    for (const key of REPORT_CATEGORIES) {
      const text = REPORT_CATEGORY_TEXT[key];
      expect({ key, hasLabel: !!text?.label, hasHint: !!text?.hint })
        .toEqual({ key, hasLabel: true, hasHint: true });
    }
  });

  it('never shows a raw key to a reporter', () => {
    /*
      `license` and `inappropriate` read as internal identifiers, and this is a
      dialog someone opens while annoyed. A label that looks like a database
      value tells them they are filing a bug report into a machine.
    */
    for (const key of REPORT_CATEGORIES) {
      const { label } = REPORT_CATEGORY_TEXT[key as ReportCategory];
      expect(label).not.toBe(key);
      expect(label[0]).toBe(label[0]!.toUpperCase());
    }
  });
});
