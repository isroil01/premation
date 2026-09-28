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

import { startEngineJob, type EngineJobHandle } from '@core/engine/engineJobs';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { proxyResolution, type ProxyRecord } from './proxy';

/** Why a proxy could not be started. Distinguished so the UI can say something
 *  true rather than a generic failure. */
export type ProxyRefusal =
  | 'no-ffmpeg'
  | 'not-video'
  | 'too-small'
  | 'unknown-size'
  | 'already-running'
  | 'source-unreadable'
  | 'no-engine';

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
  'no-engine': 'Proxies are made by the engine, which is not running here.',
};

/** Running viewport-proxy engine jobs, by asset (cancelProxy stops them). */
const proxyJobs = new Map<string, EngineJobHandle<{ path: string }>>();

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
  // The engine transcodes the proxy (the proxy job: the same rule and
  // arguments, written beside the project and attached with setProxy — the
  // item's proxy then arrives through the mirror). The page transcode that ran
  // on the TypeScript engine is gone (docs/TS_ENGINE_REMOVAL.md phase 4).
  let handle: EngineJobHandle<{ path: string }> | null;
  try {
    handle = await startEngineJob<{ path: string }>({ kind: 'proxy', value: { item: assetId, outputFolder: '' } });
  } catch (e) {
    write(assetId, { status: 'failed', error: e instanceof Error ? e.message : 'The proxy could not be made.' });
    return null;
  }
  if (!handle) return 'no-engine';
  write(assetId, { status: 'generating' });
  proxyJobs.set(assetId, handle);
  const out = await handle.done;
  if (proxyJobs.get(assetId) === handle) proxyJobs.delete(assetId);
  // Gone, cancelled, or a newer job replaced this record: do not resurrect it.
  if (current(assetId)?.proxy?.status === 'generating') {
    if (out.status === 'done' && out.result?.path) write(assetId, { status: 'ready', src: out.result.path });
    else if (out.status === 'failed') write(assetId, { status: 'failed', error: out.error?.message ?? 'The proxy could not be made.' });
    else write(assetId, null);
  }
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
  void generateProxyIfUseful(assetId);
}

/**
 * The viewport proxy, gated by its own refusal. (The ANALYSIS stand-in tier fed
 * the page tracker, which is gone — the engine's tracker decodes the original.)
 */
async function generateProxyIfUseful(assetId: string): Promise<void> {
  if (proxyRefusal(current(assetId)) === null) await startProxy(assetId);
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
    await generateProxyIfUseful(id);
  }
}

/**
 * Cancel a running generation and drop the record.
 *
 * Clearing rather than marking failed is deliberate: the user asked for it to
 * stop, so the honest state is "no proxy", with Create Proxy available again.
 */
export async function cancelProxy(assetId: string): Promise<void> {
  proxyJobs.get(assetId)?.cancel();
  proxyJobs.delete(assetId);
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

