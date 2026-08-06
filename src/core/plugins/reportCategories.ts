/**
 * Why someone is reporting a plugin, and what each reason means.
 *
 * Static data, deliberately NOT in `registry.ts`. That module is the network
 * client, and every test that renders a plugin surface mocks it — so a
 * vocabulary living there arrives `undefined` in exactly the tests that render
 * the dialog, and the dialog crashes on a list it was told would exist.
 * Separating them is also just true: the categories are not something the
 * registry answers, they are something both sides already agree on.
 *
 * The list is mirrored in motion-back and asserted byte-identical against a
 * shared fixture (`reportCategories.test.ts`). It has to be: free text alone
 * cannot be triaged — "it is stealing my project" and "it broke last update"
 * need different urgency and different actions — and a queue that cannot tell
 * them apart treats both like whichever arrived first.
 */

export const REPORT_CATEGORIES = [
  'malicious',
  'impersonation',
  'broken',
  'inappropriate',
  'license',
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * The words a user reads while choosing.
 *
 * Written as things that happened to them, not as taxonomy. Someone opening
 * this dialog is annoyed and in a hurry; "License violation — it ships someone
 * else's work without the right to" is answerable, and "License" alone is a
 * category they will skip past.
 */
export const REPORT_CATEGORY_TEXT: Record<ReportCategory, { label: string; hint: string }> = {
  malicious: {
    label: 'Malicious behaviour',
    hint: 'It does something harmful or dishonest with my project or my data.',
  },
  impersonation: {
    label: 'Impersonation',
    hint: 'It pretends to be someone else’s plugin, company or product.',
  },
  broken: {
    label: 'Broken or abandoned',
    hint: 'It does not work, and does not look maintained.',
  },
  inappropriate: {
    label: 'Inappropriate content',
    hint: 'Its listing, images or output are not acceptable.',
  },
  license: {
    label: 'License violation',
    hint: 'It ships someone else’s work without the right to.',
  },
};

/**
 * Message ceiling, mirroring the server's.
 *
 * Enforced on the textarea so it stops accepting characters, rather than
 * letting someone write four thousand words and lose them to a 400. A report
 * that fails at submit is a report that does not get sent again.
 */
export const MAX_REPORT_MESSAGE = 2000;
