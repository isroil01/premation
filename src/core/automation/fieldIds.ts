/**
 * Public template input ids — the names n8n (and the fill-in panel) send.
 *
 * Internal layer ids are not a public contract. A field is addressed by a
 * stable, human slug derived from the layer name (`character`, `backgroundVideo`)
 * so an automation request never has to know Premation's node graph.
 */

/** Camel-case slug from a layer label. `"Background Video"` → `"backgroundVideo"`. */
export function slugFieldId(label: string): string {
  const words = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  return words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('');
}

/** Pick a slug that is unique within `taken`. */
export function uniqueFieldId(base: string, taken: ReadonlySet<string>): string {
  const stem = base || 'input';
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}${n}`)) n += 1;
  return `${stem}${n}`;
}

/**
 * What the public API accepts as an input key.
 *
 * Starts with a letter, then letters or digits, ≤ 64 chars. No underscores,
 * dashes or dots — those look like internal ids and invite n8n users to paste
 * layer ids by accident.
 */
export function isPublicFieldId(id: string): boolean {
  return /^[a-z][a-zA-Z0-9]{0,63}$/.test(id);
}
