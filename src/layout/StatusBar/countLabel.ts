/**
 * "1 layer", "2 layers", "0 layers" — the status bar printed "1 layers".
 *
 * English only takes the singular at exactly one; zero is plural. Irregular
 * nouns pass their own plural.
 */
export function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
