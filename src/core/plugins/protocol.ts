/**
 * The host ⇄ plugin wire protocol.
 *
 * Deliberately tiny and fully serialisable: the whole point of the sandbox is
 * that a plugin never holds a reference to a host object. It holds message
 * shapes, and the host decides — per message, against the plugin's granted
 * permissions — whether to act on one.
 */

import type { PluginManifest, PluginPermission } from './manifest';

/** A command a plugin contributes to the palette / menus. */
export interface PluginCommandSpec {
  /** Plugin-local id; namespaced with the plugin id by the host. */
  id: string;
  label: string;
  /** Icon name; falls back to the generic plugin glyph when unknown. */
  icon?: string;
  /** When true the host only enables it with a non-empty selection. */
  needsSelection?: boolean;
}

/** Host → worker. */
export type HostMessage =
  | { k: 'boot'; manifest: PluginManifest; code: string; permissions: PluginPermission[] }
  | { k: 'result'; id: number; ok: true; value: unknown }
  | { k: 'result'; id: number; ok: false; error: string }
  | { k: 'invoke'; commandId: string; selection: string[] }
  | { k: 'panelMessage'; data: unknown }
  | { k: 'ping'; id: number };

/** A line in a plugin's log, as shown in the manager. */
export type PluginLogLevel = 'log' | 'warn' | 'error';

/** Worker → host. */
export type WorkerMessage =
  | { k: 'ready' }
  | { k: 'activated' }
  | { k: 'call'; id: number; method: string; args: unknown[] }
  | { k: 'pong'; id: number }
  | { k: 'toPanel'; data: unknown }
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
  'scene.setProperty': 'scene:write',
  'scene.renameLayer': 'scene:write',
  'scene.deleteLayer': 'scene:write',

  'animation.getTracks': 'animation:read',
  'animation.sample': 'animation:read',

  'animation.setKeyframe': 'animation:write',
  'animation.setKeyframes': 'animation:write',
  'animation.removeKeyframe': 'animation:write',
  'animation.setExpression': 'animation:write',

  'timeline.getTime': 'timeline',
  'timeline.setTime': 'timeline',
};
