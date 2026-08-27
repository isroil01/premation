/**
 * The host ⇄ plugin wire protocol.
 *
 * Deliberately tiny and fully serialisable: the whole point of the sandbox is
 * that a plugin never holds a reference to a host object. It holds message
 * shapes, and the host decides — per message, against the plugin's granted
 * permissions — whether to act on one.
 *
 * "Serialisable" now means *structured-clone* serialisable rather than
 * JSON-serialisable. Image payloads travel as `Uint8Array` inside the same
 * `{k:'call', …}` envelope, with the backing buffer in the `postMessage`
 * transfer list. This is not an optimisation: base64 inside JSON is 33% larger
 * and, worse, `JSON.stringify` of a 4K frame is a synchronous multi-hundred-
 * millisecond stall on whichever thread does it — the main thread, in the
 * host's direction. See `assets.ts` for the transfer-list helpers.
 */

import type {
  PluginCommandContribution,
  PluginManifest,
  PluginPermission,
} from './manifest';

/**
 * A command a plugin contributes to the palette / menus.
 *
 * The same shape whether it was DECLARED in `contributes.commands` or
 * registered at runtime — one type, so the two paths cannot drift into
 * accepting different things.
 */
export type PluginCommandSpec = PluginCommandContribution;

/** Host → worker. */
/**
 * What a plugin is told when a render leaves the queue.
 *
 * Metadata ONLY — never the encoded bytes and never a directory. `fileName` is
 * the basename, because a plugin that learns where a user keeps their renders
 * has learned something about their machine it has no use for, and a plugin
 * holding `net:fetch` could send it. The deliverable itself stays on the user's
 * disk: handing a plugin the file would make "post-render action" mean
 * "exfiltrate the render", which is a different feature with a different
 * consent screen.
 */
export interface RenderFinishedInfo {
  /** `done` wrote a file; `skipped` rendered but the user dismissed the save
   *  dialog; `failed` did not finish. */
  status: 'done' | 'skipped' | 'failed';
  compositionName: string;
  /** Basename with extension, or null when nothing was written. */
  fileName: string | null;
  format: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  elapsedMs: number;
  /** Present only for `failed`. */
  error?: string;
}

export type HostMessage =
  /**
   * `capabilities` is what this host has RIGHT NOW, including the ones that
   * depend on the machine rather than the build (`webgpu`). Sent with the boot
   * message rather than fetched on demand, because a plugin branching on it in
   * `activate()` cannot await a round trip — and because a capability set that
   * changed mid-session would mean a plugin's `optional` handling depends on
   * when it happened to ask.
   */
  | {
      k: 'boot';
      manifest: PluginManifest;
      code: string;
      permissions: PluginPermission[];
      capabilities: string[];
    }
  | { k: 'result'; id: number; ok: true; value: unknown }
  | { k: 'result'; id: number; ok: false; error: string }
  | { k: 'invoke'; commandId: string; selection: string[] }
  | { k: 'panelMessage'; panelId: string; data: unknown }
  /**
   * A user AUTHORED one of this plugin's custom layers.
   *
   * Never sent for an animated value change — see `layerChangeNotifier.ts`.
   * Coalesced by the host, so a drag delivers one of these rather than one per
   * pointer event.
   */
  | { k: 'layerChanged'; layerId: string; kindId: string; props: string[] }
  | { k: 'renderFinished'; render: RenderFinishedInfo }
  /**
   * One step of an export a plugin's format is driving.
   *
   * Request/response, which host→worker otherwise is not — `invoke` and
   * `layerChanged` are told-not-asked. It carries an `id` for the same reason
   * `ping` does: the host has to know which reply belongs to which step, and an
   * encoder that silently dropped a frame would produce a file that is wrong
   * rather than one that failed.
   *
   * `pixels` is RGBA8, `width * height * 4` bytes, TRANSFERRED rather than
   * copied — a 4K frame is 33 MB and copying one per frame would cost more than
   * the encode. The host does not touch the buffer after sending.
   */
  | {
      k: 'export';
      id: number;
      exporterId: string;
      phase: 'begin';
      info: { width: number; height: number; fps: number; durationSec: number; compositionName: string };
    }
  | { k: 'export'; id: number; exporterId: string; phase: 'frame'; index: number; width: number; height: number; pixels: ArrayBuffer }
  | { k: 'export'; id: number; exporterId: string; phase: 'finish' }
  | { k: 'export'; id: number; exporterId: string; phase: 'dispose' }
  /**
   * Decode one file a plugin's importer claimed.
   *
   * A single request rather than the four-phase shape `export` uses: a decode
   * takes a whole file and produces a whole image, so there is no stream to
   * stage. `bytes` is transferred, like an export frame and for the same
   * reason — a raw camera file is not small.
   */
  | { k: 'import'; id: number; importerId: string; fileName: string; bytes: ArrayBuffer }
  | { k: 'ping'; id: number };

/** A line in a plugin's log, as shown in the manager. */
export type PluginLogLevel = 'log' | 'warn' | 'error';

/** Worker → host. */
export type WorkerMessage =
  | { k: 'ready' }
  | { k: 'activated' }
  | { k: 'call'; id: number; method: string; args: unknown[] }
  | { k: 'pong'; id: number }
  | { k: 'toPanel'; panelId: string; data: unknown }
  | { k: 'log'; level: PluginLogLevel; text: string }
  /** The reply to one `export` step. `bytes` only ever accompanies `finish`. */
  | { k: 'exportResult'; id: number; ok: true; bytes?: ArrayBuffer }
  | { k: 'exportResult'; id: number; ok: false; error: string }
  /** RGBA8, `width * height * 4` bytes. */
  | { k: 'importResult'; id: number; ok: true; width: number; height: number; pixels: ArrayBuffer }
  | { k: 'importResult'; id: number; ok: false; error: string }
  | { k: 'fatal'; error: string };

/** Every RPC method the host implements, with the permission it requires.
 *  `null` means the method is core: it neither reads project data nor changes
 *  it, so gating it would only add a dialog with nothing behind it. */
export const METHOD_PERMISSIONS: Record<string, PluginPermission | null> = {
  'ui.notify': null,
  'ui.openPanel': null,
  'ui.closePanel': null,
  'commands.register': null,
  'composition.get': null,

  'scene.getSelection': 'scene:read',
  'scene.setSelection': 'scene:read',
  'scene.getLayers': 'scene:read',
  'scene.getLayer': 'scene:read',

  'scene.createLayer': 'scene:write',
  /*
    The NARROW permission — satisfied by `scene:write` through
    `PERMISSION_IMPLIES` rather than by naming both here.

    It used to require `scene:write`, which was the widest grant in the API, for
    no benefit. A `proxy` layer kind cannot render without this call, so the
    most useful class of plugin could not be installed without also being able
    to delete anything in the project, and the consent screen had no way to
    express the difference.

    The scope is enforced by the HANDLER, not by the permission: the target must
    be a layer of a kind this plugin itself declared, that kind must be
    `render: "proxy"`, and a child the user has edited is refused outright. See
    `hostApi.ts` — that is why the narrower grant is safe, and it was already
    true before the permission existed.
  */
  'scene.setProxyChildren': 'scene:proxy',
  // Observing an authored edit on a layer means reading its properties.
  'scene.onLayerChanged': 'scene:read',
  /*
    Compositions. Reading the list is `scene:read` (comp names are project data
    of the same kind as layer names); everything that changes the SET of
    compositions is its own permission — see PERMISSIONS in `manifest.ts` for
    why it is not folded into `scene:write`.
  */
  'audio.getPeaks': 'audio:read',
  'audio.getAmplitude': 'audio:read',
  'composition.list': 'scene:read',
  'composition.create': 'composition:write',
  'composition.open': 'composition:write',
  'composition.rename': 'composition:write',
  'composition.delete': 'composition:write',
  'scene.setProperty': 'scene:write',
  'scene.renameLayer': 'scene:write',
  'scene.deleteLayer': 'scene:write',
  /*
    Structure and per-layer state.

    All `scene:write`, and none of them gets a permission of its own. The
    consent screen is a list somebody reads, and splitting "can change layers"
    into six lines makes it longer without making it more informative — nobody
    grants "may reparent" while withholding "may delete". What a user actually
    decides is whether this plugin may rearrange their project.
  */
  'scene.setParent': 'scene:write',
  'scene.setVisible': 'scene:write',
  'scene.setLocked': 'scene:write',

  /*
    The effect stack.

    Reading is `scene:read`, changing is `scene:write` — because that is what an
    effect is here: a property of a layer, stored on the layer, saved with the
    document. A separate `effects:*` permission would imply effects are a
    different kind of thing to grant, and they are not.
  */
  'effects.list': 'scene:read',
  'effects.add': 'scene:write',
  'effects.remove': 'scene:write',
  'effects.setParam': 'scene:write',

  'animation.getTracks': 'animation:read',
  'animation.sample': 'animation:read',

  'animation.setKeyframe': 'animation:write',
  'animation.setKeyframes': 'animation:write',
  'animation.removeKeyframe': 'animation:write',
  'animation.setExpression': 'animation:write',

  'assets.getImage': 'assets:read',
  'assets.createImage': 'assets:write',

  // The one verb that SENDS. Gated on the permission, and the host checks the
  // URL against the plugin's declared hosts before anything leaves the machine.
  'net.fetch': 'net:fetch',

  'timeline.getTime': 'timeline',
  'timeline.setTime': 'timeline',

  /*
    A BATCH needs whatever its operations need, which is not knowable here.

    Null rather than 'scene:write': a batch of pure animation ops would then be
    over-charged, and one that deletes layers under-charged. The union is
    computed from the ops and checked in the handler, before anything runs —
    see `sceneBatch.ts` and `OP_PERMISSIONS`.

    The cost is that the registry's scanner cannot infer a permission from a
    `scene.apply` call, because the ops are data rather than method names. A
    package doing everything through the batch therefore looks permission-free
    to it. That is a real loss and the honest one: the alternative is a table
    entry that lies about what the method needs.
  */
  'scene.apply': null,

  /*
    Storage needs NO permission, and that is a decision rather than an omission.

    Neither scope touches the user's layers. A ninth consent line reading
    "remembers its own settings" buys nothing and costs attention on the one
    screen where attention is the entire point — a user who reads eight lines
    carefully and skims the ninth has been made worse off by the ninth.

    It is disclosed instead, as an informational line on the consent screen when
    the manifest declares `storage.global` or `storage.project`. That is the
    honest weight: a fact, not a decision.

    The `project` scope does ride in the user's file, which is the one thing
    here that could be called their data. It is bounded at 256 KB and disclosed
    the same way. See `pluginStorage.ts`.
  */
  'storage.get': null,
  'storage.set': null,
  'storage.delete': null,
  'storage.list': null,
};

/**
 * Collect the `ArrayBuffer`s in a message so `postMessage` can transfer rather
 * than copy them.
 *
 * Transfer is the difference between moving a 256 MB RGBA buffer and cloning
 * it. Deliberately shallow — it looks in `args` and in a result `value`, which
 * is where every binary payload in this protocol lives, and nowhere else. A
 * general deep walk over third-party data would be its own denial-of-service.
 *
 * Transferring NEUTERS the buffer on the sending side. Every caller here is
 * done with the payload at the point it posts, which is why this is safe; a
 * future caller that still needs its bytes must copy before posting.
 */
export function collectTransferables(msg: HostMessage | WorkerMessage): Transferable[] {
  const seen = new Set<ArrayBuffer>();
  const out: Transferable[] = [];

  const take = (v: unknown): void => {
    let buf: ArrayBuffer | null = null;
    if (v instanceof ArrayBuffer) buf = v;
    else if (ArrayBuffer.isView(v)) buf = v.buffer as ArrayBuffer;
    if (!buf || seen.has(buf)) return;
    // A SharedArrayBuffer is a view's buffer too, and transferring one throws.
    if (typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) return;
    seen.add(buf);
    out.push(buf);
  };

  const scan = (v: unknown): void => {
    if (!v) return;
    take(v);
    if (typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer)) {
      for (const inner of Object.values(v as Record<string, unknown>)) take(inner);
    }
  };

  if (msg.k === 'call') for (const a of msg.args) scan(a);
  else if (msg.k === 'result' && msg.ok) scan(msg.value);
  // An export frame is the largest payload in the protocol by two orders of
  // magnitude — 33 MB for 4K — and the one place copying instead of
  // transferring would show up as the export taking twice as long.
  else if (msg.k === 'export' && msg.phase === 'frame') take(msg.pixels);
  else if (msg.k === 'exportResult' && msg.ok && msg.bytes) take(msg.bytes);
  else if (msg.k === 'import') take(msg.bytes);
  else if (msg.k === 'importResult' && msg.ok) take(msg.pixels);

  return out;
}
