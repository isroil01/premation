/**
 * Product events: what someone did in the editor, reported to the backend so
 * the operator can see whether people come back, how far a first session gets,
 * and what breaks.
 *
 * ── What is sent, and what never is ─────────────────────────────────────────
 *
 * An event is a NAME from a closed list plus a few categorical facts: an export
 * format, a media kind, a reason CODE. Never a project name, a file name, layer
 * text, a prompt or an error message — a message is exactly where a file path
 * turns up. `failureReason` reduces an error to a code on this side, and the
 * server re-checks every key against its own allow-list
 * (motion-back `product-analytics.service.ts`), so a mistake here is dropped
 * there rather than stored.
 *
 * ── When anything is sent ───────────────────────────────────────────────────
 *
 * Only in the hosted edition, only with a session, and only while the user has
 * "Share usage data" on (Settings). Off means DROPPED, not queued: turning it
 * back on must not deliver what happened while it was off.
 *
 * Batched: events queue and flush every 15 s, at 20 events, or when the window
 * is hidden. One request per flush keeps this off the throttle budget the
 * autosave shares.
 */

import pkg from '../../../package.json';
import { isServerEdition } from '@core/config/edition';
import { getUiPlatform } from '@core/config/uiPlatform';
import { IS_ELECTRON } from '@core/api/env';
import { hasSession } from '@core/api/session';
import { getEventBus } from '@core/events/EventBus';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useRenderBackendStore } from '@stores/renderBackendStore';

/** Mirrors motion-back's `ProductEventName` enum. A new name there is a migration. */
export type ProductEventName =
  | 'app_opened'
  | 'project_created'
  | 'project_opened'
  | 'edit_session'
  | 'media_imported'
  | 'import_failed'
  | 'aep_imported'
  | 'first_keyframe'
  | 'preview_played'
  | 'export_started'
  | 'export_completed'
  | 'export_failed'
  | 'crash'
  | 'gpu_fallback';

export type ProductEventProps = Record<string, string | number>;

export type ProjectSource = 'blank' | 'template' | 'aep' | 'import' | 'duplicate' | 'ai';

export type MediaKind = 'video' | 'image' | 'audio' | 'svg' | 'lottie' | 'font' | 'other';

export interface QueuedEvent {
  name: ProductEventName;
  at: string;
  props?: ProductEventProps;
}

export interface EventBatch {
  events: QueuedEvent[];
  context: { appVersion: string; platform: string; renderBackend: string };
}

const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';
const FLUSH_MS = 15_000;
const FLUSH_AT = 20;
/** Held while offline. Past this the OLDEST go — a week offline is not worth a megabyte. */
const MAX_QUEUE = 200;
/** A crash loop must not become an event loop. */
const MAX_CRASHES_PER_SESSION = 5;

let queue: QueuedEvent[] = [];
let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Names sent once per app session (`edit_session`, `first_keyframe`, …). */
const once = new Set<ProductEventName>();
let crashes = 0;
let pendingProjectSource: ProjectSource | null = null;
let sender: ((batch: EventBatch) => Promise<unknown>) | null = null;

/** Whether an event may be recorded right now. */
export function usageSharingEnabled(): boolean {
  return (
    isServerEdition() &&
    hasSession() &&
    usePreferenceStore.getState().shareUsageData !== false
  );
}

/** Record one event. A no-op whenever sharing is off. */
export function track(name: ProductEventName, props?: ProductEventProps): void {
  if (!usageSharingEnabled()) return;
  queue.push({ name, at: new Date().toISOString(), ...(props ? { props } : {}) });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (queue.length >= FLUSH_AT) void flushProductEvents();
  else schedule();
}

/**
 * Record an event at most once per app session.
 *
 * Marked as sent only when it was actually queued: a first edit made before
 * the session was restored must not use up the one chance to record it.
 */
export function trackOnce(name: ProductEventName, props?: ProductEventProps): void {
  if (once.has(name) || !usageSharingEnabled()) return;
  once.add(name);
  track(name, props);
}

/**
 * Say what the NEXT new project is for, before creating it.
 *
 * Every new project goes through `ProjectManager.newProject`, which cannot know
 * whether a template or an After Effects file is about to fill it. The caller
 * that does know says so first; `newProject` reports with it.
 */
export function noteNextProjectSource(source: ProjectSource): void {
  pendingProjectSource = source;
}

/** Called by `ProjectManager.newProject` (and cloud create). */
export function trackProjectCreated(source?: ProjectSource): void {
  const s = source ?? pendingProjectSource ?? 'blank';
  pendingProjectSource = null;
  track('project_created', { source: s });
}

/**
 * An error, reduced to a code that cannot carry a path or a name.
 *
 * The patterns are the failures worth telling apart on a dashboard; anything
 * else falls back to the error's CLASS name (`TypeError`), which is a code by
 * construction, or `unknown`.
 */
export function failureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const rules: Array<[RegExp, string]> = [
    [/out of memory|\boom\b|allocation failed|array buffer allocation/i, 'out_of_memory'],
    [/ENOSPC|no space left|disk (is )?full|quota/i, 'disk_full'],
    [/EACCES|EPERM|permission denied|not allowed to/i, 'permission'],
    [/device (was )?lost|webgpu|gpu/i, 'gpu'],
    [/encoder|encode|codec|VideoEncoder|AudioEncoder|ffmpeg/i, 'encoder'],
    [/decode|demux|corrupt|invalid data/i, 'decode'],
    [/unsupported|not supported/i, 'unsupported'],
    [/network|failed to fetch|timed? ?out|offline/i, 'network'],
    [/no audible audio/i, 'no_audio'],
  ];
  for (const [re, code] of rules) if (re.test(message)) return code;
  const name = err instanceof Error ? err.name : '';
  return /^[A-Za-z0-9_-]{1,48}$/.test(name) ? name : 'unknown';
}

/** A crash, deduplicated and capped per session. */
export function trackCrash(source: 'window' | 'promise' | 'boundary' | 'worker' | 'gpu', err: unknown): void {
  if (crashes >= MAX_CRASHES_PER_SESSION) return;
  if (isNoise(err)) return;
  crashes++;
  track('crash', { source, reason: failureReason(err) });
}

/** Things that surface as uncaught errors and are not crashes. */
function isNoise(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // Chromium reports this for a layout that settled in two passes; nothing broke.
  return /ResizeObserver loop/i.test(message);
}

const BUILTIN_FORMATS = new Set([
  'png', 'png-sequence', 'jpg-sequence', 'exr-sequence', 'wav', 'json', 'edl', 'otio',
  'fcpxml', 'ale', 'mogrt', 'lottie', 'webm', 'mp4', 'gif', 'mov', 'hdr10', 'hlg',
]);

/**
 * An export format as the dashboard groups it. A plugin format's id is the
 * plugin's own name — not ours to collect, and useless as a group — so every
 * one of them is `plugin`.
 *
 * A list here rather than `isPluginFormat` from the export module: analytics
 * must not put itself on the render path's import graph.
 */
export function exportFormatCode(format: string): string {
  return BUILTIN_FORMATS.has(format) ? format : 'plugin';
}

/** Map a file to the coarse kind the dashboard groups by. */
export function mediaKindOf(file: { name: string; type?: string }): MediaKind {
  const type = file.type ?? '';
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'svg' || type === 'image/svg+xml') return 'svg';
  if (ext === 'lottie' || (ext === 'json' && /lottie/i.test(file.name))) return 'lottie';
  if (/^(ttf|otf|woff2?)$/.test(ext) || type.startsWith('font/')) return 'font';
  if (type.startsWith('video/') || /^(mp4|mov|webm|m4v|mxf|avi|wmv|flv|mts|m2ts|mpg|mpeg|vob|ts|mkv)$/.test(ext)) return 'video';
  if (type.startsWith('audio/') || /^(mp3|wav|m4a|aac|ogg|flac|aiff?)$/.test(ext)) return 'audio';
  if (type.startsWith('image/') || /^(png|jpe?g|gif|webp|exr|psd|tiff?|bmp|tga|avif|heic)$/.test(ext)) return 'image';
  return 'other';
}

function context(): EventBatch['context'] {
  const tier = useRenderBackendStore.getState().activeTier;
  return {
    appVersion: APP_VERSION,
    platform: `${IS_ELECTRON ? 'electron' : 'web'}-${getUiPlatform()}`,
    renderBackend: tier,
  };
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flushProductEvents();
  }, FLUSH_MS);
}

/** Tests inject a sender; the app uses the API client, loaded lazily. */
export function setProductEventSender(fn: ((batch: EventBatch) => Promise<unknown>) | null): void {
  sender = fn;
}

async function send(batch: EventBatch): Promise<unknown> {
  if (sender) return sender(batch);
  // Lazy: the client pulls in the whole endpoint catalogue, and a static import
  // from here would put it on the path of every module that reports an event.
  const { api } = await import('@core/api/client');
  return api.sendProductEvents(batch);
}

/**
 * Send what is queued.
 *
 * A network failure puts the batch back, so offline work arrives later with its
 * own timestamps. A refusal (400/401/403/413) does NOT — the same batch would
 * be refused forever and block everything behind it.
 */
export async function flushProductEvents(): Promise<void> {
  if (flushing || queue.length === 0) return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!usageSharingEnabled()) {
    queue = [];
    return;
  }
  flushing = true;
  const events = queue.splice(0, 50);
  try {
    await send({ events, context: context() });
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    const retry = status === undefined || status === 0 || status === 429 || status >= 500;
    if (retry) {
      queue.unshift(...events);
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    }
  } finally {
    flushing = false;
  }
  if (queue.length > 0) schedule();
}

/**
 * Forget everything — on sign-out, or when sharing is turned off.
 *
 * The queue belongs to the account that produced it; flushing it under the
 * next account's session would record one person's work against another.
 */
export function resetProductEvents(): void {
  queue = [];
  signedInAs = null;
  once.clear();
  crashes = 0;
  pendingProjectSource = null;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

let signedInAs: string | null = null;

/**
 * A session began or was restored. A DIFFERENT account than before starts from
 * nothing — its "first keyframe this session" has not happened yet, and the
 * previous account's queue is not its to send.
 */
export function noteSignedIn(userId: string): void {
  if (signedInAs !== null && signedInAs !== userId) resetProductEvents();
  signedInAs = userId;
  trackOnce('app_opened');
}

/** Test seam. */
export function __peekQueue(): readonly QueuedEvent[] {
  return queue;
}

/**
 * Subscribe to the app-wide signals that ARE events without any caller having
 * to say so: an edit landing on the undo stack, playback starting, a project
 * loading, the renderer falling back, an uncaught error.
 *
 * Call after Application.boot installs the process EventBus — an import-time
 * subscription attaches to the pre-boot bus and hears nothing.
 */
export function installProductAnalytics(): () => void {
  const bus = getEventBus();
  const subs = [
    bus.on('UndoStackChanged', ({ canUndo }) => {
      if (canUndo) trackOnce('edit_session');
    }),
    bus.on('PlayStateChanged', ({ playing }) => {
      if (playing) trackOnce('preview_played');
    }),
    bus.on('ProjectLoaded', () => track('project_opened')),
    bus.on('EngineError', ({ engine, error, role }) => {
      // The main viewport only — the same rule the backend badge follows, or
      // every thumbnail renderer that fails over reports a fallback.
      if (role !== 'viewport') return;
      const from = engine === 'motion-webgpu' ? 'webgpu' : engine === 'motion-webgl2' ? 'webgl2' : 'other';
      const to = from === 'webgpu' ? 'webgl2' : 'software';
      trackOnce('gpu_fallback', { from, to, reason: failureReason(error) });
    }),
  ];

  const onError = (e: ErrorEvent) => trackCrash('window', e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => trackCrash('promise', e.reason);
  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flushProductEvents();
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('visibilitychange', onHidden);

  // Turning sharing off drops what is queued, now — not at the next flush.
  const unsubPrefs = usePreferenceStore.subscribe((s, prev) => {
    if (prev.shareUsageData !== false && s.shareUsageData === false) resetProductEvents();
  });

  // Signed in already (a restored session): this launch is an app open.
  trackOnce('app_opened');

  return () => {
    for (const s of subs) s.dispose();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('visibilitychange', onHidden);
    unsubPrefs();
  };
}
