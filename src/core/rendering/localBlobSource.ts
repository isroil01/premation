/**
 * localBlobSource — resolve a local-first asset reference to something a
 * decoder can actually open, and OWN the object URL that makes that possible.
 *
 * Locally-imported assets are content-addressed in the bundle blob store; a node
 * references one as `motion-blob:<sha256>`. `buildSnapshot` passes that string
 * through untouched (it's not a `/files` or `blob:`/`data:` URL, so `assetUrl`
 * leaves it alone), so every consumer that wants bytes — the GPU texture
 * loader, the exact video decoder, the fallback `<video>` element — has to come
 * here first.
 *
 * The actual byte source (the bundle's `BlobStore`, which needs the current
 * project root + environment) is INJECTED via `setLocalBlobResolver` at boot, so
 * this render-layer module stays free of app-service imports.
 *
 * ## One URL per hash, and an owner
 *
 * This used to mint a FRESH object URL on every call and tell its caller to
 * revoke it ("Callers are responsible for `URL.revokeObjectURL` once decoded").
 * The one caller did, correctly — so there was no leak — but the contract has
 * two problems that only show up once more than one consumer exists.
 *
 * A fresh URL per call means the same asset is read off disk, copied into the
 * JS heap and wrapped in a new Blob every time anything re-resolves it. Texture
 * eviction, the 90s idle release in `exactVideoFrames`, a loop pass that
 * re-warms a source: each pays the whole file again.
 *
 * And a URL that the caller must revoke "once decoded" cannot be handed to an
 * `<HTMLVideoElement>` at all. An element holds its URL for as long as it is
 * alive — it re-reads through it on every seek — so "decoded" never arrives.
 *
 * So: ONE object URL per content hash, cached for the session, plus explicit
 * HOLDERS. A consumer that keeps the URL alive past the call retains under a
 * label; releasing drops that label and revokes only once the last holder is
 * gone. That is what lets the idle-eviction path in `exactVideoFrames` free a
 * URL without yanking it out from under a `<video>` element that is still
 * seeking through it.
 *
 * Consumers that only need the bytes for the length of one `await` (the image
 * loader decodes straight to an `ImageBitmap`) need not retain: the cached URL
 * simply stays, bounded by the number of distinct assets, exactly like the
 * object URLs `assetStore` mints for the library.
 */

export const LOCAL_BLOB_SCHEME = 'motion-blob:';

/** Resolve a content hash to its bytes (or null if unavailable). */
export type LocalBlobResolver = (hash: string) => Promise<Uint8Array | null>;

let resolver: LocalBlobResolver | null = null;

/** hash → the one object URL for it, and who is keeping it alive. */
interface HeldUrl {
  url: string;
  holders: Set<string>;
}
const held = new Map<string, HeldUrl>();
/** hash → in-flight resolve, so two simultaneous asks mint ONE url. */
const resolving = new Map<string, Promise<string | null>>();

/** Wire the byte source at boot (app layer). Pass null to clear (tests). */
export function setLocalBlobResolver(fn: LocalBlobResolver | null): void {
  resolver = fn;
}

/** True when `src` is a local-first asset reference. */
export function isLocalBlobRef(src: string): boolean {
  return src.startsWith(LOCAL_BLOB_SCHEME);
}

/** Build a `motion-blob:` reference for a content hash. */
export function localBlobRef(hash: string): string {
  return `${LOCAL_BLOB_SCHEME}${hash}`;
}

/** The hash inside a ref, or null when `src` is not one. */
function hashOf(src: string): string | null {
  return isLocalBlobRef(src) ? src.slice(LOCAL_BLOB_SCHEME.length) : null;
}

/**
 * The object URL for a `motion-blob:<hash>` ref — the SAME one every time —
 * or null if there is no resolver or no such blob.
 *
 * `holder` marks the caller as keeping the URL alive past this call. Anything
 * that stores the URL (a `<video>` element's `src`, a decoder session) must
 * pass one and release it later; anything that only decodes inside one `await`
 * can omit it.
 */
export async function resolveLocalBlobObjectUrl(
  src: string,
  holder?: string,
): Promise<string | null> {
  const hash = hashOf(src);
  if (!hash || !resolver) return null;

  const cached = held.get(hash);
  if (cached) {
    if (holder) cached.holders.add(holder);
    return cached.url;
  }

  let pending = resolving.get(hash);
  if (!pending) {
    const load = resolver;
    pending = (async () => {
      const bytes = await load(hash);
      if (!bytes) return null;
      // Re-check: a concurrent caller may have landed while we awaited.
      const raced = held.get(hash);
      if (raced) return raced.url;
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
      held.set(hash, { url, holders: new Set() });
      return url;
    })().finally(() => {
      resolving.delete(hash);
    });
    resolving.set(hash, pending);
  }

  const url = await pending;
  if (url && holder) held.get(hash)?.holders.add(holder);
  return url;
}

/** The cached URL for a ref if one already exists — no bytes read, no await. */
export function peekLocalBlobObjectUrl(src: string): string | null {
  const hash = hashOf(src);
  return (hash && held.get(hash)?.url) ?? null;
}

/** Mark an already-resolved ref as held. No-op if it was never resolved. */
export function retainLocalBlobObjectUrl(src: string, holder: string): void {
  const hash = hashOf(src);
  if (hash) held.get(hash)?.holders.add(holder);
}

/**
 * Drop one holder, and revoke the URL once nobody is left.
 *
 * Returns true when this call actually revoked. A ref still held by another
 * consumer — the classic case being a `<video>` element on the fallback tier
 * that is still seeking through it while the exact decoder is idle-evicted —
 * is left alone; revoking it would hand that element a dead URL and a black
 * frame, which is the failure mode `isPersistableProxy` exists to prevent one
 * layer up.
 */
export function releaseLocalBlobObjectUrl(src: string, holder: string): boolean {
  const hash = hashOf(src);
  if (!hash) return false;
  const entry = held.get(hash);
  if (!entry) return false;
  entry.holders.delete(holder);
  if (entry.holders.size > 0) return false;
  held.delete(hash);
  URL.revokeObjectURL(entry.url);
  return true;
}

/**
 * Point a `<video>` at `src`, resolving a `motion-blob:<hash>` ref first.
 *
 * A ref is not a URL: assigning it verbatim makes the element fire `error`
 * immediately, which is what every video layer in a saved `.motion` bundle did
 * — its library entry's src IS a ref (`bundleAssetSync.assetsFromRecords`), and
 * neither video tier nor the exact decoder ever resolved one. The bundle carried
 * the bytes, the panel showed the clip, and the layer rendered its offline bars.
 *
 * The holder label is generated PER ELEMENT and remembered here rather than
 * passed in. Two layers can point at the same source, so a label derived from
 * the src would be one shared claim: releasing either element would drop it
 * while the other was still seeking through the URL. The caller cannot get the
 * pairing wrong if it never sees it.
 *
 * Synchronous for every other kind of src, so the overwhelmingly common path is
 * unchanged.
 */
export function attachVideoSrc(v: HTMLVideoElement, src: string): void {
  if (!isLocalBlobRef(src)) {
    v.src = src;
    v.load?.();
    return;
  }
  const holder = `element#${++holderSeq}`;
  elementHolders.set(v, { src, holder });
  const cached = peekLocalBlobObjectUrl(src);
  if (cached) {
    retainLocalBlobObjectUrl(src, holder);
    v.src = cached;
    v.load?.();
    return;
  }
  void resolveLocalBlobObjectUrl(src, holder).then((url) => {
    // The element may have been torn down while the bytes were read; assigning
    // to a released element would revive a decoder nothing owns.
    if (!url || releasedElements.has(v)) return;
    v.src = url;
    v.load?.();
  });
}

/** Elements torn down while a local-blob resolve was still in flight. A
 *  WeakSet rather than a data attribute: the caches' test stubs are plain
 *  objects with a `src` and nothing else, and a teardown must work on those. */
const releasedElements = new WeakSet<object>();
/** element → the claim `attachVideoSrc` made for it. */
const elementHolders = new WeakMap<object, { src: string; holder: string }>();
let holderSeq = 0;

/**
 * Mark a `<video>` as torn down and drop its claim on a local-first URL.
 *
 * One call for both halves because they are one fact — this element is done —
 * and splitting them is how a resolve in flight ends up re-arming a decoder on
 * a dead element. A no-op for an element that never held a local-first ref.
 */
export function detachVideoSrc(v: HTMLVideoElement): void {
  releasedElements.add(v);
  const claim = elementHolders.get(v);
  if (!claim) return;
  elementHolders.delete(v);
  releaseLocalBlobObjectUrl(claim.src, claim.holder);
}

/** Live URL count and per-hash holders. Diagnostics and tests. */
export function localBlobUrlStats(): { urls: number; holders: Record<string, string[]> } {
  const holders: Record<string, string[]> = {};
  for (const [hash, e] of held) holders[hash] = [...e.holders];
  return { urls: held.size, holders };
}

/** Revoke everything (teardown, tests). */
export function resetLocalBlobObjectUrls(): void {
  for (const e of held.values()) URL.revokeObjectURL(e.url);
  held.clear();
  resolving.clear();
}

/**
 * Legacy name, kept because it reads at several call sites and in the docs.
 *
 * NOTE the changed contract: the returned URL is CACHED and shared, so the
 * caller must NOT revoke it. Use `releaseLocalBlobObjectUrl` instead.
 */
export const loadLocalBlobObjectUrl = resolveLocalBlobObjectUrl;
