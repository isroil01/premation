/**
 * Same generation request, same asset — no second charge.
 *
 * Author mode rebuilds a beat by wiping it and replaying its calls, and a
 * beat with a generated image or clip in it would otherwise generate (and
 * bill) it again on every revision, for a picture nobody asked to change.
 * The direct loop re-issues identical calls too. So a generation is keyed by
 * everything that decides its pixels, and a key that already produced an
 * asset the project still holds is answered with that asset.
 *
 * Session-scoped by design: an asset id means nothing in another project or
 * after the library forgets it, so every hit is checked against the live
 * library before it is used.
 */

export type GeneratedKind = 'image' | 'video';

export interface GenerationKeyParts {
  kind: GeneratedKind;
  prompt: string;
  model?: string;
  aspect?: string;
  durationSec?: number;
  width?: number;
  height?: number;
}

/** A stable key over the parts that decide the output. */
export function generationKey(p: GenerationKeyParts): string {
  return JSON.stringify([p.kind, p.prompt.trim(), p.model ?? '', p.aspect ?? '', p.durationSec ?? '', p.width ?? '', p.height ?? '']);
}

const MAX_ENTRIES = 200;
const cache = new Map<string, string>();

/** The asset a key produced, if the library still has it. */
export function cachedAsset(key: string, stillExists: (assetId: string) => boolean): string | undefined {
  const id = cache.get(key);
  if (id === undefined) return undefined;
  if (!stillExists(id)) {
    cache.delete(key);
    return undefined;
  }
  return id;
}

export function rememberAsset(key: string, assetId: string): void {
  cache.delete(key);
  cache.set(key, assetId);
  // Oldest first out; a session that generates hundreds of assets keeps the recent ones.
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** Tests and a project switch. */
export function clearGenerationCache(): void {
  cache.clear();
}
