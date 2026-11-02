/**
 * engineHost — the C++ engine process wired into the app (NATIVE_CORE_PLAN §5 C3).
 *
 * The ONLY engine (docs/TS_ENGINE_REMOVAL.md, owner decision 2026-09-28): it
 * always starts and always owns the document. There is no TypeScript
 * fallback; when the engine cannot run the host reports `unavailable`
 * (`onUnavailable`): fatal (no executable, no GPU, protocol mismatch) → main's
 * startup dialog; a crash loop → main blocks the editor and offers a recovery
 * save and a retry (`retry()`).
 *
 *  - `EngineSupervisor` (engineSupervisor.ts) starts `premation-engine` after
 *    `app` is ready, restarts it on a crash or hang, gives up after a crash
 *    loop, and restarts it on purpose when Chromium's GPU process goes away
 *    (the engine must follow Chromium's adapter — docs/VIEWPORT_ROUTE.md).
 *  - IPC, all through ipcGuard (top frame of our own page only):
 *      engine:request        invoke  encoded EngineMessage{request} → encoded response (or {ok:false})
 *      engine:status         invoke  EngineHostStatus
 *      engine:receiverReady  send    the page's sharedTexture receiver is (not) installed
 *    and pushes to the main window: engine:events (encoded EventBatch bytes),
 *    engine:state, engine:restarted, engine:unavailable.
 *  - Frames: the engine's FrameSlots/FrameReady (frame channel, fd 3) become
 *    `sharedTexture.importSharedTexture` + `sendSharedTexture` into the main
 *    frame; the ring slot is released back to the engine on
 *    `allReferencesReleased`. The slot handle per OS comes from
 *    sharedTextureHandles.ts: an NT handle on Windows (main NEVER closes one —
 *    the engine duplicated it into this process and closes it itself when a
 *    ring is retired), an IOSurfaceRef looked up from the announced
 *    IOSurfaceID on macOS (ioSurfaceBridge.ts; main holds it while the ring is
 *    current). Nothing is sent until the page says its receiver is installed:
 *    C4 measured every early send timing out.
 *  - Route A (docs/VIEWPORT_ROUTE.md), where slots cannot be shared (Linux,
 *    macOS without the host bridge): the engine is offered `frames.copy`, reads
 *    each frame back and writes it on its fd 5 before the FrameReady. Main
 *    pairs the two by (generation, slot), pushes the pixels to the page
 *    (`engine:pixels`; the preload wraps them in a VideoFrame, so EngineSurface
 *    draws both routes the same way) and releases the slot when the page says
 *    it is done with them (`engine:pixelsRelease`). At most two frames are
 *    with the page; anything more goes straight back to the ring.
 *
 * Main stays a relay: it never decodes a document or an event batch.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { handle, on } from './ipcGuard';
import { peekEnvelope, peekRequest, responseIsError, transcribeProviderOf, withCausedBy, withEnvelopeSeq, withTranscribeCredential, type EngineFrameMessage, type FrameGeometryMessage, type FrameReadyMessage, type SlotsMessage } from './engineFraming';
import { CMD, EngineCommandLog } from './engineCommandLog';
import { decodeEngineMessage, encodeEngineMessage } from './generated/engineCodec';
import type { EngineMessage } from './generated/engineTypes';
import { EngineLogFile } from './engineLogFile';
import type { PixelFrame } from './pixelChannel';
import { hostBridgePath, loadDmabufBridge, loadIoSurfaceBridge } from './ioSurfaceBridge';
import { ntHandleSource, slotHandleSourceFor, type SlotHandleSource, type SlotTextureHandle } from './sharedTextureHandles';
import { resolveFfmpegBinary } from './ffmpegBinary';
import { EngineGoneError } from './engineTransport';
import { bundledModelEnv } from './modelManifest';
import {
  EngineSupervisor,
  chromiumGpuVendor,
  resolveEngineExecutable,
  type EngineChild,
  type EngineRestartedInfo,
  type UnavailableInfo,
  type SupervisorOptions,
  type SupervisorState,
} from './engineSupervisor';

/** Every channel this module registers (pinned by ipcRegistration.test.ts). */
export const ENGINE_IPC_CHANNELS = [
  'engine:pixelsRelease',
  'engine:receiverReady',
  'engine:request',
  'engine:restartToFreeMemory',
  'engine:status',
  'engine:viewportBase',
] as const;

/** Pushes to the renderer. */
export const ENGINE_PUSH_CHANNELS = ['engine:events', 'engine:state', 'engine:busy', 'engine:restarted', 'engine:unavailable', 'engine:pixels'] as const;

/** Most route-A frames with the page at once (each holds an engine ring slot). */
export const MAX_COPY_FRAMES_IN_PAGE = 2;

/**
 * The viewport frame route main offers the engine. `auto` (default): the
 * shared texture (route C) where this OS can import it, the route-A copy
 * otherwise. `PREMATION_VIEWPORT_ROUTE=copy` offers ONLY the copy, even where
 * shared textures work — how route A (the macOS-without-bridge / Linux path)
 * is exercised on a Windows box, and a field switch if a GPU driver breaks
 * shared-texture import.
 */
export function viewportRoute(env: Record<string, string | undefined>): 'auto' | 'copy' {
  const v = env.PREMATION_VIEWPORT_ROUTE?.trim().toLowerCase();
  return v === 'copy' || v === 'a' ? 'copy' : 'auto';
}

/**
 * The frame capabilities main's Hello offers. Both where slots can be imported
 * here (the engine takes shared slots when it can and falls back to copies
 * when it cannot); only the copy otherwise (no handle source, or the route
 * forced to copy).
 */
/**
 * `PREMATION_FONTS_MANIFEST` for the engine: the bundled `fonts/fonts.json`
 * (<resources>/fonts when packaged, resources/fonts in a checkout), when it is
 * there. A developer's own PREMATION_FONTS_MANIFEST wins.
 */
export function bundledFontsManifest(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): { PREMATION_FONTS_MANIFEST?: string } {
  if (process.env.PREMATION_FONTS_MANIFEST) return { PREMATION_FONTS_MANIFEST: process.env.PREMATION_FONTS_MANIFEST };
  const manifest = o.isPackaged ? path.join(o.resourcesPath, 'fonts', 'fonts.json') : path.join(o.appPath, 'resources', 'fonts', 'fonts.json');
  return existsSync(manifest) ? { PREMATION_FONTS_MANIFEST: manifest } : {};
}

export function offeredFrameCapabilities(canImportShared: boolean): string[] {
  return canImportShared ? ['frames.sharedTexture', 'frames.copy'] : ['frames.copy'];
}

// ── shared-texture frame forwarding ─────────────────────────────────────────

/** The part of Electron's `sharedTexture` main uses (injectable for tests). */
export interface SharedTextureApi {
  importSharedTexture(options: {
    textureInfo: { pixelFormat: 'rgba'; codedSize: { width: number; height: number }; handle: SlotTextureHandle };
    allReferencesReleased?: () => void;
  }): { release(): void };
  sendSharedTexture(options: { frame: unknown; importedSharedTexture: { release(): void } }, ...args: unknown[]): Promise<void>;
}

/** What the page gets with each frame (EngineFrameMeta in packages/engine-api). */
export interface ForwardedFrameMeta {
  viewport: number;
  generation: number;
  slot: number;
  frame: number;
  time: number;
  revision: number;
  width: number;
  height: number;
  dropped: number;
  renderStartUs: number;
  renderDoneUs: number;
  sentUs: number;
  /** How the frame travelled: a shared texture (route C) or a pixel copy (route A). */
  route: 'shared' | 'copy';
  /** B4 round 2: the frame's overlay geometry (setOverlayGeometry), the FrameGeometry parts merged. */
  geometry?: FrameGeometryMessage['layers'];
  /** B4 round 5: the frame's view cameras (setOverlayGeometry `views`). */
  geometryViews?: FrameGeometryMessage['views'];
}

export interface FrameForwarderStats {
  forwarded: number;
  /** Of `forwarded`, how many went as route-A pixel copies. */
  copied: number;
  /** Released at once: no receiver yet, a transfer in flight, offscreen slots, or an unknown generation. */
  dropped: number;
  engineDropped: number;
  errors: string[];
}

/**
 * FrameReady → one shared-texture transfer into the page, at most one in
 * flight PER VIEWPORT (a frame that arrives meanwhile goes straight back to
 * the ring: drop, never block). Slot handles are per ring generation AND per
 * engine process (`epoch`): a release that belongs to a dead process is never
 * sent to its successor, whose generation numbers start over.
 *
 * C (multiple viewports): every viewport the engine draws — the editor's, a
 * pop-out window's, a second view — has its own ring (FrameSlots.viewport;
 * generations are unique across viewports), its own transfer in flight and its
 * own overlay geometry, and its frames go to the window that OWNS it
 * (`ownerOf`, learned by EngineHost from that window's setViewport). Receivers
 * are per window (`setReceiverReady(…, key)`); a window going away frees only
 * its own copied frames.
 */
export class FrameForwarder {
  private epoch = 0;
  private readonly views = new Map<number, ViewState>();
  /** generation → viewport, for every live ring (pixels name only the generation). */
  private readonly genView = new Map<number, number>();
  private readonly receivers = new Map<number, { ready: boolean; copyReady: boolean }>();
  private readonly handles: SlotHandleSource;
  readonly stats: FrameForwarderStats = { forwarded: 0, copied: 0, dropped: 0, engineDropped: 0, errors: [] };
  // Route A: the two halves of a copied frame arrive on different pipes.
  private readonly copyWaiting = new Map<string, FrameReadyMessage>();
  private readonly copyPixels = new Map<string, PixelFrame>();
  /** Copied frames with a page, by slot key → its viewport, its window and what frees the slot (once). */
  private readonly copyInPage = new Map<string, { viewport: number; owner: number; free: () => void }>();
  /** A ready frame's geometry until its meta is built (route A may wait for its pixels), by slot key. */
  private readonly frameGeometry = new Map<string, FrameGeometryMessage['layers']>();
  /** B4 round 5: a ready frame's view cameras (FrameGeometry.views), by slot key, like `frameGeometry`. */
  private readonly frameViews = new Map<string, FrameGeometryMessage['views']>();

  constructor(
    private readonly deps: {
      sharedTexture: SharedTextureApi | null;
      /** The page frame showing `viewport` (its owner window's main frame), or null. */
      target(viewport: number): unknown;
      /** The receiver key (window) that owns `viewport`; default: 0 for every viewport (one window). */
      ownerOf?(viewport: number): number;
      release(generation: number, slot: number): void;
      /** Slot handles for this OS (sharedTextureHandles.ts); default: Windows NT handles. */
      handles?: SlotHandleSource;
      /** Route A: push one frame's pixels to the owner's page; false when there is no page to take them. */
      sendPixels?(meta: ForwardedFrameMeta, pixels: Uint8Array): boolean;
      now?(): number;
    },
  ) {
    this.handles = deps.handles ?? ntHandleSource();
  }

  /** A new engine process: forget every ring of the old one. */
  engineStarted(): void {
    this.epoch += 1;
    this.views.clear();
    this.genView.clear();
    this.handles.closeAll();
    // The dead engine's slots are gone with it: nothing to release.
    this.copyWaiting.clear();
    this.copyPixels.clear();
    this.copyInPage.clear();
    this.frameGeometry.clear();
    this.frameViews.clear();
  }

  /**
   * A window's receivers (`key`, default 0): `ready` for shared textures,
   * `copyReady` for route-A pixels (defaults to `ready`). Going away frees
   * every copied frame that window held — a reloaded page never answers for them.
   */
  setReceiverReady(ready: boolean, copyReady: boolean = ready, key = 0): void {
    this.receivers.set(key, { ready, copyReady });
    if (!copyReady) this.releaseCopiesInPage(key);
    if (!ready) this.abandonTransfers(key);
  }

  /**
   * A window's page went away (reload, navigation, crash): the shared-texture
   * transfers to it may never settle — a reload during one left that viewport
   * waiting on it for good ("Waiting for the C++ engine's first frame"), and
   * main's reference held the engine's slot. Each is abandoned: main lets go
   * of the texture (the slot is freed once the dead page's reference goes),
   * the frame waiting behind it is released, and the late settle is ignored.
   */
  private abandonTransfers(key: number): void {
    for (const [viewport, v] of this.views) {
      if (this.owner(viewport) !== key || !v.inFlight) continue;
      v.transfer += 1;
      v.inFlight = false;
      const imported = v.inFlightImport;
      v.inFlightImport = null;
      try {
        imported?.release();
      } catch (e) {
        this.fail(e);
      }
      if (v.waiting) {
        this.dropFrame(v.waiting);
        v.waiting = null;
      }
      if (v.retirePending) {
        v.retirePending = false;
        v.held.clear();
        this.handles.retire(this.liveGenerations());
      }
    }
  }

  /** A window closed: its receivers and its copied frames go. */
  forgetReceiver(key: number): void {
    this.receivers.delete(key);
    this.releaseCopiesInPage(key);
  }

  /** Route A: the page is done with a copied frame (`engine:pixelsRelease`). */
  pixelsReleased(generation: number, slot: number): void {
    const key = slotKey(generation, slot);
    const held = this.copyInPage.get(key);
    if (!held) return;  // unknown, already freed, or a previous engine's
    this.copyInPage.delete(key);
    held.free();
  }

  /** Route A: one frame's pixels from the engine's fd 5. */
  onPixels(p: PixelFrame): void {
    if (!this.genView.has(p.generation)) return;  // a retired ring's: its slot went with it
    const key = slotKey(p.generation, p.slot);
    const ready = this.copyWaiting.get(key);
    if (ready) {
      this.copyWaiting.delete(key);
      this.forwardCopy(ready, p);
      return;
    }
    this.copyPixels.set(key, p);
  }

  /** Is the main (key 0) shared-texture receiver installed? */
  get ready(): boolean {
    return this.receivers.get(0)?.ready ?? false;
  }

  onFrame(m: EngineFrameMessage): void {
    if (m.type === 'slots') {
      this.onSlots(m);
      return;
    }
    if (m.type === 'geometry') {
      this.onGeometry(m);
      return;
    }
    if (m.type === 'frameReady') this.onFrameReady(m);
  }

  private view(viewport: number): ViewState {
    let v = this.views.get(viewport);
    if (!v) {
      v = { rings: new Map(), held: new Set(), inFlight: false, transfer: 0, inFlightImport: null, retirePending: false, waiting: null, geometry: null };
      this.views.set(viewport, v);
    }
    return v;
  }

  private owner(viewport: number): number {
    return this.deps.ownerOf?.(viewport) ?? 0;
  }

  private onSlots(m: SlotsMessage): void {
    const v = this.view(m.viewport);
    // A new ring retires every older generation OF THIS VIEWPORT. Half-paired
    // copies of the old ring are forgotten: the engine ignores releases of a
    // retired generation.
    for (const g of v.rings.keys()) {
      this.genView.delete(g);
      // Its handle may be the one an import in flight is using: kept until that ends.
      if (v.inFlight) v.held.add(g);
      for (const k of [...this.copyWaiting.keys()]) if (k.startsWith(`${g}:`)) this.copyWaiting.delete(k);
      for (const k of [...this.copyPixels.keys()]) if (k.startsWith(`${g}:`)) this.copyPixels.delete(k);
    }
    // A frame waiting on the old ring is a retired slot now: nothing to show.
    if (v.waiting) {
      this.dropFrame(v.waiting);
      v.waiting = null;
    }
    v.rings.clear();
    v.rings.set(m.generation, m);
    this.genView.set(m.generation, m.viewport);
    if (m.shared) this.handles.open(m);
    // An import in flight may still be using this viewport's older handle.
    if (v.inFlight) v.retirePending = true;
    else this.handles.retire(this.liveGenerations());
    v.geometry = null;
  }

  /** Every ring any viewport still shows (the handle sources keep exactly these). */
  private liveGenerations(): Set<number> {
    const out = new Set<number>();
    for (const v of this.views.values()) {
      for (const g of v.rings.keys()) out.add(g);
      // A viewport whose transfer is in flight keeps its retired rings until it ends.
      for (const g of v.held) out.add(g);
    }
    return out;
  }

  /**
   * B4 round 2: the overlay geometry of the NEXT FrameReady of its viewport
   * (setOverlayGeometry) — collected over its parts, then handed to the page
   * WITH that frame (its meta), so the overlays draw the geometry of the very
   * frame they are drawn over.
   */
  private onGeometry(g: FrameGeometryMessage): void {
    const v = this.view(g.viewport);
    const cur = v.geometry;
    const same = cur !== null && !cur.complete && cur.generation === g.generation && cur.frame === g.frame;
    const views = g.views ?? [];
    v.geometry = same
      ? { ...cur, layers: [...cur.layers, ...g.layers], views: [...cur.views, ...views], complete: g.last }
      : { generation: g.generation, frame: g.frame, layers: [...g.layers], views: [...views], complete: g.last };
  }

  /** The collected geometry for `f` (and forget it): only a complete set for this very frame. */
  private takeGeometry(v: ViewState, f: FrameReadyMessage): FrameGeometryMessage['layers'] | undefined {
    const g = v.geometry;
    v.geometry = null;
    const mine = g !== null && g.complete && g.generation === f.generation && g.frame === f.frame;
    const key = slotKey(f.generation, f.slot);
    if (mine && g.views.length > 0) this.frameViews.set(key, g.views);
    else this.frameViews.delete(key);
    return mine ? g.layers : undefined;
  }

  private onFrameReady(f: FrameReadyMessage): void {
    this.stats.engineDropped += f.dropped;
    const v = this.view(f.viewport);
    // The frame's overlay geometry travels with it on either route (meta()).
    const geometry = this.takeGeometry(v, f);
    if (geometry) this.frameGeometry.set(slotKey(f.generation, f.slot), geometry);
    else this.frameGeometry.delete(slotKey(f.generation, f.slot));
    const ring = v.rings.get(f.generation);
    if (ring && !ring.shared && this.deps.sendPixels) {
      // Route A: forward once the pixels are here too.
      const key = slotKey(f.generation, f.slot);
      const pixels = this.copyPixels.get(key);
      if (pixels) {
        this.copyPixels.delete(key);
        this.forwardCopy(f, pixels);
      } else {
        this.copyWaiting.set(key, f);
      }
      return;
    }
    if (ring?.shared && v.inFlight) {
      // A transfer is in flight: this frame WAITS for it (newest wins), it is
      // not dropped. Dropping it lost the engine's LAST frame whenever it
      // landed during a transfer — an idle engine renders nothing more, so the
      // page kept an older picture and that frame's overlay geometry: the Type
      // tool's editor with no geometry sat at the stage corner, a new layer's
      // handles described the frame before it.
      if (v.waiting) this.dropFrame(v.waiting);
      v.waiting = f;
      return;
    }
    this.forwardShared(v, f);
  }

  /** Release a ready frame that will not be shown (and forget its geometry). */
  private dropFrame(f: FrameReadyMessage): void {
    const key = slotKey(f.generation, f.slot);
    this.frameGeometry.delete(key);
    this.frameViews.delete(key);
    this.stats.dropped += 1;
    this.deps.release(f.generation, f.slot);
  }

  /** Route C: hand one frame's shared texture to its page (one transfer in flight per viewport). */
  private forwardShared(v: ViewState, f: FrameReadyMessage): void {
    const ring = v.rings.get(f.generation);
    const target = this.deps.target(f.viewport);
    const st = this.deps.sharedTexture;
    const receiver = this.receivers.get(this.owner(f.viewport));
    const handle = ring?.shared && !v.inFlight ? this.handles.handle(f.generation, f.slot) : null;
    if (!ring || !ring.shared || !handle || !st || !target || !receiver?.ready || v.inFlight) {
      this.dropFrame(f);
      return;
    }
    const epoch = this.epoch;
    const releaseOnce = (() => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (epoch === this.epoch) this.deps.release(f.generation, f.slot);
      };
    })();
    v.inFlight = true;
    const transfer = ++v.transfer;
    let imported: { release(): void };
    try {
      imported = st.importSharedTexture({
        textureInfo: { pixelFormat: 'rgba', codedSize: { width: f.width, height: f.height }, handle },
        allReferencesReleased: releaseOnce,
      });
    } catch (e) {
      v.inFlight = false;
      this.fail(e);
      this.frameGeometry.delete(slotKey(f.generation, f.slot));
      this.frameViews.delete(slotKey(f.generation, f.slot));
      releaseOnce();
      return;
    }
    v.inFlightImport = imported;
    const meta = this.meta(f, 'shared');
    st.sendSharedTexture({ frame: target, importedSharedTexture: imported }, meta)
      .then(() => {
        this.stats.forwarded += 1;
      })
      .catch((e: unknown) => {
        this.fail(e);
      })
      .finally(() => {
        // Abandoned by a page reset: main's reference already went, and the
        // viewport has moved on to the new page.
        if (transfer !== v.transfer) return;
        v.inFlightImport = null;
        // Main's reference goes; the slot is freed once the page's goes too
        // (allReferencesReleased). A failed send leaves only ours: this frees it.
        try {
          imported.release();
        } catch (e) {
          this.fail(e);
        }
        if (epoch === this.epoch) {
          v.inFlight = false;
          if (v.retirePending) {
            v.retirePending = false;
            v.held.clear();
            this.handles.retire(this.liveGenerations());
          }
          // The newest frame that arrived meanwhile goes now.
          const next = v.waiting;
          v.waiting = null;
          if (next) this.forwardShared(v, next);
        }
      });
  }

  private forwardCopy(f: FrameReadyMessage, p: PixelFrame): void {
    const target = this.deps.target(f.viewport);
    const send = this.deps.sendPixels;
    const key = slotKey(f.generation, f.slot);
    const owner = this.owner(f.viewport);
    const inPage = [...this.copyInPage.values()].filter((c) => c.viewport === f.viewport).length;
    if (!send || !target || !this.receivers.get(owner)?.copyReady || inPage >= MAX_COPY_FRAMES_IN_PAGE || this.copyInPage.has(key)
      || p.width !== f.width || p.height !== f.height) {
      this.stats.dropped += 1;
      this.deps.release(f.generation, f.slot);
      return;
    }
    const epoch = this.epoch;
    let done = false;
    const free = (): void => {
      if (done) return;
      done = true;
      if (epoch === this.epoch) this.deps.release(f.generation, f.slot);
    };
    this.copyInPage.set(key, { viewport: f.viewport, owner, free });
    let sent = false;
    try {
      sent = send(this.meta(f, 'copy'), p.data);
    } catch (e) {
      this.fail(e);
    }
    if (!sent) {
      this.copyInPage.delete(key);
      this.stats.dropped += 1;
      free();
      return;
    }
    this.stats.forwarded += 1;
    this.stats.copied += 1;
  }

  private releaseCopiesInPage(owner: number): void {
    for (const [k, held] of [...this.copyInPage.entries()]) {
      if (held.owner !== owner) continue;
      this.copyInPage.delete(k);
      held.free();
    }
  }

  private meta(f: FrameReadyMessage, route: ForwardedFrameMeta['route']): ForwardedFrameMeta {
    const key = slotKey(f.generation, f.slot);
    const geometry = this.frameGeometry.get(key);
    this.frameGeometry.delete(key);
    const geometryViews = this.frameViews.get(key);
    this.frameViews.delete(key);
    return {
      viewport: f.viewport, generation: f.generation, slot: f.slot, frame: f.frame, time: f.time, revision: f.revision,
      width: f.width, height: f.height, dropped: f.dropped, renderStartUs: f.renderStartUs, renderDoneUs: f.renderDoneUs,
      sentUs: (this.deps.now?.() ?? Date.now()) * 1000,
      route,
      ...(geometry ? { geometry } : {}),
      ...(geometryViews ? { geometryViews } : {}),
    };
  }

  private fail(e: unknown): void {
    this.stats.errors.push(e instanceof Error ? e.message : String(e));
    if (this.stats.errors.length > 20) this.stats.errors.shift();
  }
}

/** One viewport's frames in main. */
interface ViewState {
  rings: Map<number, SlotsMessage>;
  /** Retired generations whose handles an in-flight import may still use. */
  held: Set<number>;
  /** A shared-texture transfer of this viewport is in flight. */
  inFlight: boolean;
  /** Which transfer is in flight (a page reset abandons it: the dead page's late settle is ignored). */
  transfer: number;
  /** Main's reference to the texture in flight (released at once when the transfer is abandoned). */
  inFlightImport: { release(): void } | null;
  /** A newer ring arrived while a transfer was in flight: retire the older ones when it ends. */
  retirePending: boolean;
  /** Route C: the newest frame that arrived during the transfer in flight; forwarded when it ends. */
  waiting: FrameReadyMessage | null;
  geometry: { generation: number; frame: number; layers: FrameGeometryMessage['layers']; views: FrameGeometryMessage['views']; complete: boolean } | null;
}

function slotKey(generation: number, slot: number): string {
  return `${generation}:${slot}`;
}

// ── the host ─────────────────────────────────────────────────────────────────

export interface EngineHostOptions {
  isDev: boolean;
  isPackaged: boolean;
  resourcesPath: string;
  /** Repo root in development (for native/build/<preset>/engine). */
  appPath: string;
  hostPid: number;
  appVersion: string;
  getGPUInfo(level: 'complete'): Promise<unknown>;
  getWindow(): BrowserWindow | null;
  /**
   * F2: every window that mirrors the engine (the main window and its pop-outs).
   * Events and notices go to each; frames only to `getWindow()`. Default: the
   * main window alone.
   */
  getWindows?(): BrowserWindow[];
  /** F2: keep the command log here and replay it into a restarted engine (default true). */
  recordLog?: boolean;
  sharedTexture: SharedTextureApi | null;
  /** The OS (tests); default process.platform. Decides how slot handles are imported. */
  platform?: NodeJS.Platform;
  /** The environment the route switch reads (tests); default process.env. */
  env?: Record<string, string | undefined>;
  supervisor?: Partial<SupervisorOptions>;
  /** G1: the native plugin folder (bundles with premation-plugin.json) the engine scans. */
  nativePluginDir?: string;
  /** Per-launch plugin arguments (nativePluginStore `engineArgsFor`, after pending installs are applied). */
  nativePluginLaunchArgs?: () => Promise<readonly string[]>;
  /** G1: the plugin crash journal — a plugin that killed the engine is quarantined at the next start. */
  nativePluginJournal?: string;
  /** F2 / D5: the recovery copy the engine-owned document's autosave writes (reported with ownsDocument). */
  recoveryPath?: string;
  /**
   * The engine's log on disk (<userData>/logs/engine.log, engineLogFile.ts): its
   * stderr and the supervisor's events — what a user sends us after a crash.
   */
  engineLogPath?: string;
  /** Where the engine caches imported bytes / session footage as files (<userData>/session-footage). */
  sessionFootageDir?: string;
  /** The user's installed Object Matte model folder (<userData>/models/object-matte; objectMatteModel.ts). */
  samUserDir?: string;
  /** The float Object Matte encoder for the GPU (<userData>/models/object-matte-gpu; models.json `object-matte-gpu`). */
  samGpuUserDir?: string;
  /** The face landmark model folder (<userData>/models/face-landmarks; faceModel.ts). */
  faceUserDir?: string;
  /** The depth model folder (<userData>/models/depth-anything; depthModel.ts) — camera program D3. */
  depthUserDir?: string;
  /** The hand models for live performance input (<userData>/models/hand-landmarks; handModel.ts). */
  handUserDir?: string;
  /** The SAM 2.1 video model for Object Matte walks (<userData>/models/sam2-video; sam2Model.ts). */
  sam2UserDir?: string;
  /** Refine Edge's learned matting model (<userData>/models/vitmatte; models.json `vitmatte`). */
  vitmatteUserDir?: string;
  /** app.getPath('userData'): lets PREMATION_FFMPEG find the in-app repaired ffmpeg (ffmpegRepair.ts). */
  userDataPath?: string;
  log?(line: string): void;
  /**
   * The user's speech-provider key for a transcribe job ('openai' …), from
   * main's keystore; null when none is connected. Written into the startJob
   * on its way to the engine only (engineFraming.withTranscribeCredential) —
   * never logged, never sent back to a page. Absent: transcribe jobs get no key.
   */
  transcribeCredential?(provider: string): Promise<string | null>;
  /**
   * The engine cannot run (see UnavailableInfo.fatal). Main shows the fatal
   * startup dialog, or the blocking crash-loop dialog with a recovery save.
   */
  onUnavailable?(info: UnavailableInfo): void;
}

/**
 * The engine's plugin arguments (G1, docs/PLUGIN_SDK.md). The engine process
 * hosts native SDK plugins itself; `PREMATION_PLUGIN_PATH` adds folders on its side.
 */
export function nativePluginArgs(dir: string | undefined, journal: string | undefined): string[] {
  const args: string[] = [];
  if (dir) args.push('--plugins', dir);
  if (journal) args.push('--plugin-journal', journal);
  return args;
}

export interface EngineHostStatusReply {
  /** Always true: the engine is the only one (kept on the wire for the page's EngineHostStatus). */
  enabled: true;
  state: SupervisorState;
  engine?: string;
  engineVersion?: string;
  revision?: number;
  /** Why the engine is `unavailable` (with that state). */
  unavailableReason?: string;
  /** Always true: the engine owns the document (the page's lifecycle goes through engine requests). */
  ownsDocument: true;
  /** F2 / D5: where autosave writes the recovery copy (with ownsDocument). */
  recoveryPath?: string;
  /** F2: main keeps the command log and replays it after a restart (renderer clients record none). */
  hostCommandLog?: boolean;
}

/** Where a request came from: the webContents id of the window that sent it. */
export type EngineRequestSender = number;

interface InFlight {
  sender: EngineRequestSender | undefined;
  seq: number;
}

/**
 * Which window holds the engine's ONE gesture slot (§5.1). The engine never
 * sees a page: main is its only client, so a page reload (location.reload)
 * closes no pipe and the gesture that page opened — an AI turn's, a drag's —
 * stays open in an engine that lives on; every later `beginGesture` from the
 * reloaded page answers `gestureOpen` and the editor cannot edit. Main watches
 * the begin/end pairs go by (it never decodes a request; the response of a
 * `beginGesture` is decoded for the id) and, when the owner's page goes away
 * (`pageReset`), ends that gesture itself.
 */
export class OpenGestureTracker {
  private owner: { sender: EngineRequestSender; gesture: number } | null = null;

  /** The open gesture `sender` holds, or null. */
  held(sender: EngineRequestSender): number | null {
    return this.owner !== null && this.owner.sender === sender ? this.owner.gesture : null;
  }

  /** One answered request from `sender` (both encoded). */
  note(request: Uint8Array, response: Uint8Array, sender: EngineRequestSender): void {
    const cmd = peekRequest(request);
    if (!cmd || cmd.body !== 'command') return;
    if (cmd.commandId !== CMD.beginGesture && cmd.commandId !== CMD.endGesture) return;
    if (responseIsError(response) !== false) return;
    if (cmd.commandId === CMD.endGesture) {
      // `0` ends "the open one", whoever opened it (uiEdits' leaked-gesture recovery).
      this.owner = null;
      return;
    }
    let msg: EngineMessage;
    try {
      msg = decodeEngineMessage(response);
    } catch {
      return;
    }
    if (msg.kind !== 'response' || msg.value.outcome.kind !== 'command' || msg.value.outcome.value.type !== 'beginGesture') return;
    this.owner = { sender, gesture: msg.value.outcome.value.gesture };
  }

  /** `sender`'s page is gone: its gesture (if any) is no longer owned. Returns the orphan's id. */
  release(sender: EngineRequestSender): number | null {
    const gesture = this.held(sender);
    if (gesture !== null) this.owner = null;
    return gesture;
  }

  /** The engine forgot everything (a restart replayed from the log; the log holds the ends main sent). */
  reset(): void {
    this.owner = null;
  }
}

/** What the renderer is told after a restart the HOST recovered (the renderer client must not replay). */
export interface HostRecoveryInfo {
  replayedByHost: true;
  replayed: number;
  mismatches: number;
  ms: number;
}

export class EngineHost {
  readonly supervisor: EngineSupervisor;
  readonly frames: FrameForwarder;
  private unavailableReason: string | undefined;
  /** F2: the engine's command log (engineCommandLog.ts), replayed by main after a restart. */
  readonly commandLog: EngineCommandLog;
  /** Main's seq space on the engine connection: every window's requests renumbered. */
  private hostSeq = 0;
  private readonly inFlight = new Map<number, InFlight>();
  /** Which window holds the engine's gesture slot; ended by main when that page goes away. */
  readonly gestures = new OpenGestureTracker();
  /** While a restarted engine is being replayed into: requests wait, events are not relayed. */
  private recovering: Promise<void> | null = null;
  private lastRecovery: HostRecoveryInfo | null = null;
  /** <userData>/logs/engine.log (EngineHostOptions.engineLogPath), or null. */
  readonly engineLog: EngineLogFile | null;

  constructor(private readonly o: EngineHostOptions) {
    this.commandLog = new EngineCommandLog(o.recordLog ?? true);
    const consoleLog = o.log ?? ((line: string) => console.info(line));
    this.engineLog = o.engineLogPath ? new EngineLogFile(o.engineLogPath, `Premation ${o.appVersion} (${process.platform})`) : null;
    const log = (line: string): void => {
      consoleLog(line);
      this.engineLog?.event(line);
    };
    const platform = o.platform ?? process.platform;
    const resolveExe = (): string | null =>
      resolveEngineExecutable({
        isPackaged: o.isPackaged,
        resourcesPath: o.resourcesPath,
        appPath: o.appPath,
        platform,
        vars: process.env,
        exists: existsSync,
      });
    // Route C where this OS can import the engine's slots; otherwise (Linux,
    // macOS without the host bridge, no sharedTexture module) the engine is
    // not offered `frames.sharedTexture`. PREMATION_VIEWPORT_ROUTE=copy forces
    // route A everywhere (viewportRoute).
    const forceCopy = viewportRoute(o.env ?? process.env) === 'copy';
    if (forceCopy) log('[engine] viewport route forced to copy (PREMATION_VIEWPORT_ROUTE=copy)');
    const handles = o.sharedTexture && !forceCopy
      ? slotHandleSourceFor(
        platform,
        () => loadIoSurfaceBridge({ platform, file: hostBridgePath(resolveExe(), process.env), exists: existsSync, log: (m) => log(`[engine] warn ${m}`) }),
        (m) => log(`[engine] warn shared_texture ${m}`),
        {
          loadDmabuf: () => loadDmabufBridge({ platform, file: hostBridgePath(resolveExe(), process.env), exists: existsSync, log: (m) => log(`[engine] warn ${m}`) }),
          enginePid: () => this.supervisor.enginePid,
        },
      )
      : null;
    this.frames = new FrameForwarder({
      sharedTexture: o.sharedTexture,
      // C: a viewport's frames go to the window that set it up (a pop-out's to the pop-out).
      target: (viewport) => {
        const w = this.windowOfViewport(viewport);
        return w ? w.webContents.mainFrame : null;
      },
      ownerOf: (viewport) => this.viewportOwners.get(viewport) ?? this.mainWindowKey(),
      release: (g, s) => this.supervisor.releaseSlot(g, s),
      ...(handles ? { handles } : {}),
      sendPixels: (meta, pixels) => {
        const w = this.windowOfViewport(meta.viewport);
        if (!w) return false;
        w.webContents.send('engine:pixels', meta, pixels);
        return true;
      },
    });
    const capabilities = offeredFrameCapabilities(handles !== null);
    this.supervisor = new EngineSupervisor(
      {
        spawn: (exe, args) =>
          // fd 3/4 frame channel, fd 5 route-A pixel stream (pixelChannel.ts).
          spawn(exe, args, {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // Engine jobs (proxies) run the same ffmpeg an export does (ffmpegBinary.ts).
            env: {
              ...process.env,
              PREMATION_FFMPEG: resolveFfmpegBinary({ vars: process.env, resourcesPath: o.resourcesPath, platform: process.platform, exists: existsSync, ...(o.userDataPath ? { userDataPath: o.userDataPath } : {}) }),
              // importBytes caches bytes as files here (the page's session-footage
              // cache, file:sessionFootageDir): the engine never holds a blob: URL.
              ...(o.sessionFootageDir ? { PREMATION_SESSION_FOOTAGE: o.sessionFootageDir } : {}),
              // The model the user installed wins when both its files are there (read per job).
              ...(o.samUserDir ? { PREMATION_SAM_USER_DIR: o.samUserDir } : {}),
              // The float encoder (models.json `object-matte-gpu`, on demand): the engine runs it on
              // a GPU provider when the folder holds vision_encoder.onnx (read per job). A developer's
              // own PREMATION_SAM_GPU_DIR wins.
              ...(o.samGpuUserDir && !process.env.PREMATION_SAM_GPU_DIR ? { PREMATION_SAM_GPU_DIR: o.samGpuUserDir } : {}),
              ...(o.faceUserDir ? { PREMATION_FACE_USER_DIR: o.faceUserDir } : {}),
              ...(o.depthUserDir ? { PREMATION_DEPTH_USER_DIR: o.depthUserDir } : {}),
              // Read at every startLiveInput, so an install applies to the next start.
              ...(o.handUserDir ? { PREMATION_HAND_USER_DIR: o.handUserDir } : {}),
              // SAM 2.1 (models.json `sam2-video`, pinned, on demand): with all six files
              // there an objectMatte walk tracks with its memory instead of SlimSAM per frame.
              ...(o.sam2UserDir ? { PREMATION_SAM2_USER_DIR: o.sam2UserDir } : {}),
              ...(o.vitmatteUserDir ? { PREMATION_VITMATTE_USER_DIR: o.vitmatteUserDir } : {}),
              // The bundled copies (models.json `bundled`: the SAM pair, the hand
              // models): <resources>/models/<id> packaged, dist/models/<id> in
              // development — PREMATION_SAM_DIR, PREMATION_HAND_DIR, …
              ...bundledModelEnv(o),
              // The fonts the app ships (resources/fonts, scripts/fetchFonts.cjs): the
              // default Inter and the Noto families every script falls back to, so
              // text renders the same on every machine — not only in what is installed.
              ...bundledFontsManifest(o),
            },
          }) as unknown as EngineChild,
        resolveExe,
        gpuVendor: () => chromiumGpuVendor(o.getGPUInfo),
        hostPid: o.hostPid,
        hello: { client: 'premation-ui', clientVersion: o.appVersion, capabilities },
        log: (level, event, data) => log(`[engine] ${level} ${event}${data ? ` ${JSON.stringify(data)}` : ''}`),
      },
      {
        ...o.supervisor,
        extraArgs: [
          ...(o.supervisor?.extraArgs ?? []),
          ...nativePluginArgs(o.nativePluginDir, o.nativePluginJournal),
          // Dawn's blob cache: shaders compile once per machine, not once per launch (gpu.cpp).
          ...(o.userDataPath ? ['--shader-cache-dir', path.join(o.userDataPath, 'shader-cache')] : []),
        ],
        ...(o.nativePluginLaunchArgs ? { launchArgs: o.nativePluginLaunchArgs } : {}),
      },
    );
    const sup = this.supervisor;
    sup.on('ready', () => this.frames.engineStarted());
    sup.on('frame', (m) => this.frames.onFrame(m));
    sup.on('pixels', (p) => this.frames.onPixels(p));
    sup.on('events', (b) => this.relayEvents(b.bytes, b.causedBy));
    sup.on('log-record', (edit) => this.commandLog.absorbJobEdit(edit.bytes, edit.revisionAfter, edit.job));
    sup.on('state', (s) => this.push('engine:state', s));
    // The core thread deep in one item (what, how long) — the viewport's status line says so instead of going quiet.
    sup.on('busy', (b) => this.push('engine:busy', b));
    sup.on('engine-restarted', (info: EngineRestartedInfo) => void this.recoverRestarted(info));
    sup.on('unavailable', (info: UnavailableInfo) => {
      this.unavailableReason = info.reason;
      this.push('engine:unavailable', { reason: info.reason, fatal: info.fatal, logTail: info.logTail.slice(-20) });
      o.onUnavailable?.(info);
    });
    sup.on('ready', () => { this.unavailableReason = undefined; });
    // Every engine line on disk; warnings and errors in a dev terminal too (its stderr is JSON lines, "lvl").
    sup.on('log', (line) => {
      this.engineLog?.write(line);
      if (o.isDev && /"lvl":"(warn|error)"/.test(line)) consoleLog(`[premation-engine] ${line}`);
    });
  }


  /**
   * C: which window owns each engine viewport — the sender of its last
   * setViewport (main peeks the command id and the viewport field; it never
   * decodes the request). A viewport nobody claimed belongs to the main window.
   */
  private readonly viewportOwners = new Map<number, number>();

  /** The main window's receiver key (its webContents id), or 0 before it exists. */
  private mainWindowKey(): number {
    const w = this.o.getWindow();
    return w && !w.isDestroyed() && !w.webContents.isDestroyed() ? w.webContents.id : 0;
  }

  /** The live window that owns `viewport` (see viewportOwners), or null. */
  private windowOfViewport(viewport: number): BrowserWindow | null {
    const owner = this.viewportOwners.get(viewport);
    const list = this.windows();
    const w = owner === undefined ? this.o.getWindow() : list.find((x) => x.webContents.id === owner) ?? null;
    return w && !w.isDestroyed() && !w.webContents.isDestroyed() ? w : null;
  }

  /**
   * C: the first engine viewport id a window may use. The main window keeps
   * 1, 2, … (ENGINE_SURFACE_VIEWPORT = 1); every other window gets a block of
   * 256 of its own (webContents id × 256), so two windows never name the same
   * engine surface.
   */
  viewportBase(sender: number): number {
    return sender === this.mainWindowKey() ? 0 : sender * 256;
  }

  /** A window went away: its receivers, its copied frames and its viewports' ownership go. */
  windowClosed(sender: number): void {
    this.frames.forgetReceiver(sender);
    for (const [v, owner] of [...this.viewportOwners]) if (owner === sender) this.viewportOwners.delete(v);
  }

  start(): Promise<void> {
    return this.supervisor.start();
  }

  /** After a crash loop: start the engine again (main's "Try again"); the command log is replayed into it. */
  retry(): Promise<void> {
    return this.supervisor.retry();
  }

  /** Clean shutdown (before-quit): Goodbye, then the supervisor's kill timer. */
  stop(): Promise<void> {
    return this.supervisor.stop();
  }

  /**
   * The Cache & Memory panel's "Restart engine to free memory": a requested
   * restart (never counted as a crash), the document replayed into the new
   * process from main's command log (F2) as after any restart.
   */
  restartToFreeMemory(): boolean {
    if (this.supervisor.state !== 'running') return false;
    this.supervisor.restart('free memory (Cache & Memory panel)');
    return true;
  }

  /** Chromium's GPU process went away: the engine follows it onto the (possibly new) adapter. */
  gpuProcessGone(reason: string): void {
    this.supervisor.restart(`chromium GPU process gone (${reason})`);
  }

  /**
   * A page (re)loaded or went away (default: the main window's): its receivers
   * are gone until it says otherwise, and a gesture it held is ended by main —
   * the engine lives on and would otherwise keep the slot for ever.
   */
  pageReset(sender: number = this.mainWindowKey()): void {
    this.frames.setReceiverReady(false, false, sender);
    const orphan = this.gestures.release(sender);
    if (orphan !== null) void this.endOrphanGesture(orphan, sender);
  }

  /**
   * End a gesture whose page is gone. COMMIT, as the engine itself does when
   * its client disconnects (§5.1): the gesture's edits were applied and shown
   * while they were made, so committing loses nothing the user saw and keeps
   * them undoable as one entry; discarding would silently revert work the user
   * may have gone on from. The request is main's own (no window to answer) and
   * goes on the command log like any other, so a replay after a restart ends
   * the gesture at the same point.
   */
  private async endOrphanGesture(gesture: number, sender: EngineRequestSender): Promise<void> {
    const sup = this.supervisor;
    while (this.recovering) await this.recovering;
    this.hostSeq += 1;
    const bytes = encodeEngineMessage({
      kind: 'request',
      value: { seq: this.hostSeq, body: { kind: 'command', value: { type: 'endGesture', gesture, commit: true } }, origin: 'ui' },
    });
    try {
      const res = await sup.request(bytes);
      this.commandLog.record(bytes, res, peekEnvelope(res)?.revision ?? 0);
      this.o.log?.(`[engine] gesture ${gesture} of window ${sender} committed by main: its page went away${responseIsError(res) ? ' (the engine had already closed it)' : ''}`);
    } catch (e) {
      // The engine is gone too: a restart replays the log, which holds no end for
      // this gesture; the replayed `beginGesture` reopens it, and the tracker
      // starts over (reset in recoverRestarted) — the page's own recovery
      // (uiEdits, aiTransaction) closes a slot nobody owns.
      this.o.log?.(`[engine] gesture ${gesture} of window ${sender} not ended: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  status(): EngineHostStatusReply {
    const sup = this.supervisor;
    const w = sup.welcome;
    return {
      enabled: true,
      state: sup.state,
      ...(w ? { engine: w.engine, engineVersion: w.engineVersion, revision: w.revision } : {}),
      ...(this.unavailableReason && sup.state === 'unavailable' ? { unavailableReason: this.unavailableReason } : {}),
      ownsDocument: true,
      ...(this.o.recoveryPath ? { recoveryPath: this.o.recoveryPath } : {}),
      ...((this.o.recordLog ?? true) ? { hostCommandLog: true } : {}),
    };
  }

  /** The last restart main recovered by replaying its command log (HUD, tests). */
  get recovery(): HostRecoveryInfo | null {
    return this.lastRecovery;
  }

  /**
   * One request from a window. F2: main is the engine's ONE client — the
   * window's `seq` is renumbered into main's space (two windows both number
   * from 1), the response is renumbered back, and the applied request goes on
   * the command log. Requests wait while a restarted engine is being replayed.
   */
  async request(bytes: Uint8Array, sender?: EngineRequestSender): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'gone' | 'invalid'; message: string }> {
    const sup = this.supervisor;
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'invalid', message: 'engine:request takes the encoded request bytes' };
    const peek = peekEnvelope(bytes);
    if (!peek || peek.kind !== 'request' || peek.seq === undefined) return { ok: false, reason: 'invalid', message: 'not an encoded EngineMessage{request}' };
    while (this.recovering) await this.recovering;
    // C: the window that sets a viewport up owns its frames.
    if (sender !== undefined) {
      const cmd = peekRequest(bytes);
      if (cmd && cmd.body !== 'query' && cmd.commandId === CMD.setViewport && cmd.firstVarint !== undefined) {
        this.viewportOwners.set(cmd.firstVarint, sender);
      }
    }
    this.hostSeq += 1;
    const seq = this.hostSeq;
    // A copy either way: the IPC buffer is not ours to keep while the pipe write is pending.
    const out = withEnvelopeSeq(bytes, seq);
    if (!out) return { ok: false, reason: 'invalid', message: 'not an encoded EngineMessage{request}' };
    // A transcribe job: the provider key goes in here, main → engine only.
    // What the log keeps (and anything a page could see) has no credential.
    const logged = withTranscribeCredential(out, '');
    let sent = logged;
    const provider = transcribeProviderOf(out);
    if (provider !== null) {
      let key: string | null = null;
      try {
        key = (await this.o.transcribeCredential?.(provider || 'openai')) ?? null;
      } catch {
        key = null;
      }
      if (key) sent = withTranscribeCredential(logged, key);
    }
    this.inFlight.set(seq, { sender, seq: peek.seq });
    try {
      const res = await sup.request(sent);
      const revision = peekEnvelope(res)?.revision ?? 0;
      this.commandLog.record(logged, res, revision);
      if (sender !== undefined) this.gestures.note(logged, res, sender);
      return { ok: true, bytes: withEnvelopeSeq(res, peek.seq) ?? res };
    } catch (e) {
      if (e instanceof EngineGoneError) return { ok: false, reason: 'gone', message: e.message };
      return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) };
    } finally {
      // The response comes after its events (§8.1): nothing can still name this seq.
      this.inFlight.delete(seq);
    }
  }

  /**
   * An event batch to every mirror window. `causedBy` is main's seq: the window
   * that sent the request gets its own seq back; every other window gets the
   * batch without it and a `foreign` mark (its page replica refreshes).
   */
  private relayEvents(bytes: Uint8Array, causedBy: number | undefined): void {
    if (this.recovering) return;  // the documentReset{engineRestarted} after the replay covers these
    const origin = causedBy !== undefined ? this.inFlight.get(causedBy) : undefined;
    for (const w of this.windows()) {
      const mine = origin !== undefined && origin.sender !== undefined && origin.sender === w.webContents.id;
      const own = origin !== undefined && (mine || origin.sender === undefined);
      const payload = causedBy === undefined ? bytes : (withCausedBy(bytes, own ? origin!.seq : null) ?? bytes);
      w.webContents.send('engine:events', payload, { foreign: causedBy !== undefined && !own });
    }
  }

  /**
   * The engine came back EMPTY: replay the command log into it before any
   * window's request, then tell every window (with `replayedByHost`, so no
   * renderer client replays its own copy).
   */
  private async recoverRestarted(info: EngineRestartedInfo): Promise<void> {
    const sup = this.supervisor;
    const notice = { attempt: info.attempt, cause: info.cause, exitCode: info.exitCode, signal: info.signal, logTail: info.logTail.slice(-20) };
    if ((this.o.recordLog ?? true) === false) {
      this.push('engine:restarted', notice);
      return;
    }
    let done!: () => void;
    const gate = new Promise<void>((resolve) => { done = resolve; });
    this.recovering = gate;
    this.gestures.reset();
    const t0 = Date.now();
    let replayed = 0;
    let mismatches = 0;
    try {
      for (const rec of this.commandLog.plan()) {
        if (sup.state !== 'running') break;  // crashed again mid-replay: the next restart starts over
        try {
          const res = await sup.request(rec.bytes);
          replayed += 1;
          if (peekEnvelope(res)?.revision !== rec.revisionAfter) mismatches += 1;
        } catch {
          mismatches += 1;
          break;
        }
      }
    } finally {
      this.recovering = null;
      done();
    }
    this.lastRecovery = { replayedByHost: true, replayed, mismatches, ms: Date.now() - t0 };
    this.push('engine:restarted', { ...notice, ...this.lastRecovery });
  }

  private windows(): BrowserWindow[] {
    const list = this.o.getWindows?.() ?? [this.o.getWindow()].filter((w): w is BrowserWindow => w !== null);
    return list.filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed());
  }

  private push(channel: (typeof ENGINE_PUSH_CHANNELS)[number], payload: unknown): void {
    for (const w of this.windows()) w.webContents.send(channel, payload);
  }
}

/** Register the engine channels (all of them: the engine always runs). */
export function registerEngineIpc(host: EngineHost): void {
  handle('engine:status', () => host.status());
  handle('engine:restartToFreeMemory', () => host.restartToFreeMemory());
  // C: the first engine viewport id this window may use (EngineHost.viewportBase).
  handle('engine:viewportBase', (e: IpcMainInvokeEvent) => host.viewportBase(e.sender.id));
  handle('engine:request', (e: IpcMainInvokeEvent, bytes: Uint8Array) => host.request(bytes, e.sender.id));
  // Receivers are per window: a pop-out's never stands in for the editor's.
  on('engine:receiverReady', (e: IpcMainEvent, ready: boolean, copyReady?: boolean) =>
    host.frames.setReceiverReady(ready === true, copyReady === undefined ? ready === true : copyReady === true, e.sender.id));
  on('engine:pixelsRelease', (_e: IpcMainEvent, generation: number, slot: number) => {
    if (Number.isInteger(generation) && Number.isInteger(slot)) host.frames.pixelsReleased(generation, slot);
  });
}
