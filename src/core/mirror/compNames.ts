/**
 * Default names for a NEW composition, read off the document mirror's
 * compositions (B4) — the mirror twins of the name pickers that scanned the
 * project store's `comps`. Pure: they take the mirror's composition map.
 */

interface CompNamesRead {
  readonly comps: ReadonlyMap<string, { readonly settings: { readonly name: string } }>;
}

function takenNames(m: CompNamesRead): Set<string> {
  const out = new Set<string>();
  for (const c of m.comps.values()) out.add(c.settings.name.trim().toLowerCase());
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
  const names = [...m.comps.values()].map((c) => c.settings.name.toLowerCase());
  const existing = new Set(names);
  let n = Math.max(1, names.length + 1);
  while (existing.has(`comp ${n}`)) n += 1;
  return `Comp ${n}`;
}
