/**
 * Driving proxy generation from the renderer.
 *
 * Generation NEVER blocks import. `startProxy` returns as soon as the job is
 * queued; the asset renders at full resolution the whole time, and switches
 * only when a proxy is both ready and the user has Use Proxies on. Every
 * failure path — no ffmpeg, encode error, cancellation, an asset deleted
 * mid-encode — lands the asset back at full resolution rather than in an error
 * state, because "slower than it could be" is always better than "wrong".
 *
 * See `@core/assets/proxy` for the resolution rule, the encode and the export
 * invariant.
 */

import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { proxyResolution, proxyCodec, proxyEncodeArgs, type ProxyRecord } from './proxy';

/** Placeholders the main process substitutes with paths it owns. Keeping the
 *  ARGUMENTS in the renderer keeps the encode rule in one place. */
const IN = '__IN__';
const OUT = '__OUT__';

/** Why a proxy could not be started. Distinguished so the UI can say something
 *  true rather than a generic failure. */
export type ProxyRefusal =
  | 'no-ffmpeg'
  | 'not-video'
  | 'too-small'
  | 'unknown-size'
  | 'already-running'
  | 'source-unreadable';

/** True when this build can generate proxies at all.
 *
 *  Browser builds cannot: there is no ffmpeg, and a WASM transcode of 4K
 *  footage in the renderer would cost more than the scrubbing it saves. The
 *  browser fallback is therefore explicit and total — the Create Proxy action
 *  is absent, `useProxies` still round-trips, and users can still ATTACH a
 *  proxy they made elsewhere, which needs no ffmpeg. */
export function canGenerateProxy(): boolean {
  return typeof window !== 'undefined' && typeof window.motionEditor?.media?.generateProxy === 'function';
}

/** Why `startProxy` would refuse, or null if it would proceed. Pure, so the UI
 *  can disable and EXPLAIN the action without starting anything. */
export function proxyRefusal(asset: ImportedAsset | undefined): ProxyRefusal | null {
  if (!asset) return 'source-unreadable';
  if (!canGenerateProxy()) return 'no-ffmpeg';
  if (asset.type !== 'video') return 'not-video';
  if (asset.proxy?.status === 'generating') return 'already-running';
  const w = asset.metadata?.width;
  const h = asset.metadata?.height;
  if (!w || !h) return 'unknown-size';
  if (!proxyResolution(w, h)) return 'too-small';
  return null;
}

/** Human-readable reason, for the Assets panel. */
export const REFUSAL_TEXT: Record<ProxyRefusal, string> = {
  'no-ffmpeg': 'Proxies need ffmpeg, which this build cannot reach. You can still attach one.',
  'not-video': 'Only video footage can have a proxy.',
  'too-small': 'This footage is already small enough to scrub smoothly.',
  'unknown-size': 'This file’s dimensions are unknown, so no proxy size can be chosen.',
  'already-running': 'A proxy is already being generated for this file.',
  'source-unreadable': 'The original file could not be read.',
};

const write = (assetId: string, proxy: ProxyRecord | null): void =>
  useAssetStore.getState().setProxy(assetId, proxy);

/** The asset as it stands NOW — re-read after every await, because the user can
 *  delete or re-import a file while a multi-minute encode runs. */
const current = (assetId: string): ImportedAsset | undefined =>
  useAssetStore.getState().assets.find((a) => a.id === assetId);

/**
 * Generate a proxy for an asset. Resolves when the job finishes; callers are
 * not expected to await it.
 *
 * Returns the refusal reason when it declined to start, or null once the job
 * has run to a conclusion (ready OR failed — both are conclusions, and both
 * leave the editor working).
 */
export async function startProxy(assetId: string): Promise<ProxyRefusal | null> {
  const asset = current(assetId);
  const refusal = proxyRefusal(asset);
  if (refusal || !asset) return refusal ?? 'source-unreadable';

  const size = proxyResolution(asset.metadata!.width!, asset.metadata!.height!)!;
  const hasAlpha = asset.metadata?.hasAlpha === true;
  const { ext, mime } = proxyCodec(hasAlpha);

  write(assetId, { status: 'generating' });

  let bytes: Uint8Array;
  try {
    // The original's bytes. `src` is an object/blob URL for local imports and a
    // backend URL in cloud mode; fetch handles both.
    const res = await fetch(asset.src);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    // Only write the failure if this asset is still the one we started on.
    if (current(assetId)?.proxy?.status === 'generating') {
      write(assetId, { status: 'failed', error: 'The original file could not be read.' });
    }
    return null;
  }

  // Deleted or superseded while we were reading it.
  if (!current(assetId)) return null;

  const srcExt = /\.([a-z0-9]{1,5})$/i.exec(asset.name)?.[1] ?? 'mp4';
  let out: Uint8Array | null = null;
  try {
    out = (await window.motionEditor!.media!.generateProxy!(assetId, bytes, srcExt, proxyEncodeArgs(IN, OUT, size, hasAlpha), ext)) ?? null;
  } catch {
    out = null;
  }

  const after = current(assetId);
  // Gone, or a newer job replaced this record: do not resurrect either.
  if (!after || after.proxy?.status !== 'generating') return null;

  if (!out || out.byteLength === 0) {
    // Cancellation and encode failure arrive identically (a killed child exits
    // non-zero). `cancelProxy` clears the record itself, so reaching here with
    // the record still 'generating' means it really did fail.
    write(assetId, { status: 'failed', error: 'The proxy could not be encoded.' });
    return null;
  }

  write(assetId, {
    status: 'ready',
    src: URL.createObjectURL(new Blob([out as BlobPart], { type: mime })),
    width: size.width,
    height: size.height,
  });
  return null;
}

/**
 * Auto-start a proxy when an asset is imported — the "generated at import" half
 * of the feature, as opposed to the manual Create Proxy button.
 *
 * Fire-and-forget: it is never awaited and `startProxy` itself never blocks, so
 * import stays instant and the asset renders at full resolution until (and
 * unless) a proxy is both ready and Use Proxies is on.
 *
 * DECISION — gated on the Use Proxies preference. Generating a proxy costs real
 * CPU and disk, and a user who never turns proxies on should pay neither on
 * every 4K import. Turning Use Proxies on is the signal "I work with proxies,"
 * so from then on imports generate one automatically; a user who leaves it off
 * still has the manual action. This is why the toggle both selects the viewport
 * source AND arms import-time generation.
 *
 * Only footage worth a proxy starts a job — `proxyRefusal === null` is the exact
 * gate the button uses (video, known size, large enough, ffmpeg present, not
 * already running), so nothing here can start a job the manual path would refuse.
 */
export function maybeAutoGenerateProxy(assetId: string): void {
  if (!usePreferenceStore.getState().useProxies) return;
  if (proxyRefusal(current(assetId)) !== null) return;
  void startProxy(assetId);
}

/**
 * Generate proxies for every video asset that should have one but doesn't —
 * assets imported before auto-generation existed (or while Use Proxies was
 * off). The AE "creating optimized media in the background" move: called once
 * shortly after the editor settles, strictly SEQUENTIAL so a library of 4K
 * clips encodes one at a time in the background instead of saturating every
 * core while the user edits.
 *
 * Every gate is re-checked per asset at its turn (`proxyRefusal`), and the
 * whole run stops the moment the user turns Use Proxies off — their toggle
 * always wins over a background job.
 */
let backfillRan = false;
export async function backfillMissingProxies(): Promise<void> {
  if (backfillRan) return;
  backfillRan = true;
  if (!canGenerateProxy()) return;
  const ids = useAssetStore
    .getState()
    .assets.filter((a) => a.type === 'video' && !a.proxy)
    .map((a) => a.id);
  for (const id of ids) {
    if (!usePreferenceStore.getState().useProxies) return;
    if (proxyRefusal(current(id)) !== null) continue;
    await startProxy(id);
  }
}

/**
 * Cancel a running generation and drop the record.
 *
 * Clearing rather than marking failed is deliberate: the user asked for it to
 * stop, so the honest state is "no proxy", with Create Proxy available again.
 */
export async function cancelProxy(assetId: string): Promise<void> {
  try {
    await window.motionEditor?.media?.cancelProxy?.(assetId);
  } catch {
    /* the child may already be gone; the record still has to clear */
  }
  if (current(assetId)?.proxy?.status === 'generating') write(assetId, null);
}

/**
 * Attach a file the user supplied as this asset's proxy.
 *
 * Needs no ffmpeg, which is what makes it the browser build's whole proxy
 * story. Marked `userSupplied` so detaching never deletes their file.
 */
export function attachProxy(assetId: string, file: File): void {
  write(assetId, {
    status: 'ready',
    src: URL.createObjectURL(file),
    userSupplied: true,
  });
}

/**
 * Detach a proxy, returning the asset to full resolution.
 *
 * Revokes the object URL for a GENERATED proxy — we made it, we own it. A
 * user-supplied one is left alone: revoking a URL over a file they chose would
 * break re-attaching it in the same session.
 */
export function detachProxy(assetId: string): void {
  const p = current(assetId)?.proxy;
  if (p?.src && !p.userSupplied) URL.revokeObjectURL(p.src);
  write(assetId, null);
}
