/**
 * The document's compositions as the editor lists them, read off the document
 * mirror (B4) — the live set, and default names for a NEW composition (the
 * mirror twins of the pickers that scanned the project store's `comps`). Pure:
 * they take the mirror's composition and item maps.
 */

interface CompRecord {
  readonly id: string;
  readonly settings: { readonly name: string };
}

interface CompNamesRead<C extends CompRecord = CompRecord> {
  readonly comps: ReadonlyMap<string, C>;
  readonly compIds?: readonly string[];
  item?(id: string): unknown;
}

/**
 * The compositions the project HAS, in document order: the mirror's records
 * whose item still exists. (A composition's record can outlive its item — the
 * mirror does not drop it on `itemsRemoved` — so the item is the test.)
 */
export function liveComps<C extends CompRecord>(m: CompNamesRead<C>): C[] {
  const out: C[] = [];
  const seen = new Set<string>();
  const add = (c: C | undefined): void => {
    if (!c || seen.has(c.id)) return;
    seen.add(c.id);
    if (m.item && m.item(c.id) === undefined) return;
    out.push(c);
  };
  for (const id of m.compIds ?? []) add(m.comps.get(id));
  for (const c of m.comps.values()) add(c);
  return out;
}

function takenNames(m: CompNamesRead): Set<string> {
  const out = new Set<string>();
  for (const c of liveComps(m)) out.add(c.settings.name.trim().toLowerCase());
  return out;
}

/** `Pre-comp N` — the first N no composition is named (`defaultPrecompName`'s twin). */
export function defaultPrecompNameIn(m: CompNamesRead): string {
  const taken = takenNames(m);
  let n = 1;
  while (taken.has(`pre-comp ${n}`)) n += 1;
  return `Pre-comp ${n}`;
}

/** `Comp N` — N starts at the composition count + 1 and skips taken names (New Composition's default). */
export function defaultCompNameIn(m: CompNamesRead): string {
  const names = liveComps(m).map((c) => c.settings.name.toLowerCase());
  const existing = new Set(names);
  let n = Math.max(1, names.length + 1);
  while (existing.has(`comp ${n}`)) n += 1;
  return `Comp ${n}`;
}
