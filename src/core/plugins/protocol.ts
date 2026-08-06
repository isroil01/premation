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
export type HostMessage =
  | { k: 'boot'; manifest: PluginManifest; code: string; permissions: PluginPermission[] }
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
  // Regenerating a proxy layer's children writes to the document, so it needs
  // the same permission creating one does.
  'scene.setProxyChildren': 'scene:write',
  // Observing an authored edit on a layer means reading its properties.
  'scene.onLayerChanged': 'scene:read',
  'scene.setProperty': 'scene:write',
  'scene.renameLayer': 'scene:write',
  'scene.deleteLayer': 'scene:write',

  'animation.getTracks': 'animation:read',
  'animation.sample': 'animation:read',

  'animation.setKeyframe': 'animation:write',
  'animation.setKeyframes': 'animation:write',
  'animation.removeKeyframe': 'animation:write',
  'animation.setExpression': 'animation:write',

  'assets.getImage': 'assets:read',
  'assets.createImage': 'assets:write',

  'timeline.getTime': 'timeline',
  'timeline.setTime': 'timeline',
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

  return out;
}
