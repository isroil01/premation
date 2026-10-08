/**
 * A native plugin's panel (docs/PLUGIN_PLATFORM_PLAN.md P5, docs/PLUGIN_SDK.md
 * "Plugin panels"): the bundle's `ui/index.html`, shown in a sandboxed frame
 * (`plugin-ui://<id>/index.html`: no Node, no network, `connect-src 'none'`).
 *
 * The panel never touches the document or the render. It talks to the editor
 * through `postMessage` only, and every message becomes an ordinary engine
 * command or query — so undo, redo, save and the command log treat a panel's
 * edit like any other:
 *
 *   panel → editor                         engine
 *   { type: 'ready' }                      (the editor answers with `state`)
 *   { id, type: 'setParam', key, value }   setProperty effects/<fx>/<key> (keys at the time when animated)
 *   { id, type: 'setArbitraryData', key, data }   setPluginData (an ARBITRARY_DATA param's bytes, base64)
 *   { id, type: 'invokeButton', key, payload? }   invokeEffectAction (a button; `payload` reaches the plugin)
 *   { id, type: 'requestPreview', maxSize? }      getThumbnail of the layer — the engine renders, never the panel
 *
 *   editor → panel
 *   { type: 'state', effect, plugin, time, params, values, data }   on ready and after every document change
 *   { type: 'reply', id, ok, error?, image? }                       one per request
 *
 * Every message carries `premation: 1`. Pure: no React, no engine import (the
 * component in src/layout/Effects/PluginPanel.tsx runs the commands).
 */

import type { Command, EffectParamUi, PluginDataEntry, Value } from '@motion/engine-api';

export const PANEL_PROTOCOL = 1;
export const PANEL_SCHEME = 'plugin-ui';
/** The largest payload / arbitrary data a panel may send (the engine's limits are 64 KiB and 256 KiB). */
export const MAX_PANEL_PAYLOAD = 64 * 1024;
export const MAX_PANEL_DATA = 256 * 1024;
const MAX_PREVIEW = 1024;

/** The frame's address for a plugin's panel. */
export function panelUrl(pluginId: string): string {
  return `${PANEL_SCHEME}://${encodeURIComponent(pluginId.toLowerCase())}/index.html`;
}

/**
 * The frame's sandbox: scripts only. No `allow-same-origin` (the panel is an
 * opaque origin: no storage, no cookies, no reach into the editor), no forms,
 * popups, top navigation or downloads.
 */
export const PANEL_SANDBOX = 'allow-scripts';

/** A param value from a panel: a number (slider, angle, popup, a point's `p<id>X` / `p<id>Y`), a checkbox or a colour (0..1). */
export type PanelParamValue = number | boolean | { r: number; g: number; b: number; a?: number };

export type PanelRequest =
  | { id: number; type: 'setParam'; key: string; value: PanelParamValue }
  | { id: number; type: 'setArbitraryData'; key: string; data: string }
  | { id: number; type: 'invokeButton'; key: string; payload?: string }
  | { id: number; type: 'requestPreview'; maxSize: number };

export type PanelMessage = { type: 'ready' } | PanelRequest;

/** A native plugin param's document key: `p<id>` (a point's `p<id>X` / `p<id>Y`). */
const PARAM_KEY = /^p\d{1,9}[XYZ]?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function paramValue(v: unknown): PanelParamValue | null {
  if (finite(v) || typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    const c = v as Record<string, unknown>;
    if (finite(c.r) && finite(c.g) && finite(c.b) && (c.a === undefined || finite(c.a))) {
      return { r: c.r, g: c.g, b: c.b, ...(finite(c.a) ? { a: c.a } : {}) };
    }
  }
  return null;
}

/**
 * A message from the frame → what it asks, or null (dropped: not ours, malformed
 * or over a limit). Never throws: the frame is untrusted.
 */
export function parsePanelMessage(raw: unknown): PanelMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.premation !== PANEL_PROTOCOL || typeof m.type !== 'string') return null;
  if (m.type === 'ready') return { type: 'ready' };
  const id = m.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  switch (m.type) {
    case 'setParam': {
      if (typeof m.key !== 'string' || !PARAM_KEY.test(m.key)) return null;
      const value = paramValue(m.value);
      return value === null ? null : { id, type: 'setParam', key: m.key, value };
    }
    case 'setArbitraryData': {
      if (typeof m.key !== 'string' || !PARAM_KEY.test(m.key)) return null;
      if (typeof m.data !== 'string' || !BASE64.test(m.data) || (m.data.length * 3) / 4 > MAX_PANEL_DATA) return null;
      return { id, type: 'setArbitraryData', key: m.key, data: m.data };
    }
    case 'invokeButton': {
      if (typeof m.key !== 'string' || !PARAM_KEY.test(m.key)) return null;
      if (m.payload !== undefined && (typeof m.payload !== 'string' || m.payload.length > MAX_PANEL_PAYLOAD)) return null;
      return { id, type: 'invokeButton', key: m.key, ...(typeof m.payload === 'string' ? { payload: m.payload } : {}) };
    }
    case 'requestPreview': {
      const size = m.maxSize === undefined ? 512 : m.maxSize;
      if (!finite(size)) return null;
      return { id, type: 'requestPreview', maxSize: Math.max(16, Math.min(MAX_PREVIEW, Math.round(size))) };
    }
    default:
      return null;
  }
}

function toValue(v: PanelParamValue): Value {
  if (typeof v === 'number') return { kind: 'scalar', value: v };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  return { kind: 'color', value: { r: v.r, g: v.g, b: v.b, a: v.a ?? 1 } };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Where a panel's edit lands: the effect instance it was opened for. */
export interface PanelTarget {
  layer: string;
  effectId: string;
  /** The editor's time, flicks: an animated param keys here. */
  time: number;
}

/** The engine command for an edit request (not for `requestPreview`). */
export function panelCommand(req: Exclude<PanelRequest, { type: 'requestPreview' }>, t: PanelTarget): Command {
  const group = `effects/${t.effectId}`;
  switch (req.type) {
    case 'setParam':
      return { type: 'setProperty', prop: { layer: t.layer, path: `${group}/${req.key}` }, value: toValue(req.value), time: t.time };
    case 'setArbitraryData':
      return { type: 'setPluginData', layer: t.layer, group, key: `arb:${req.key}`, data: base64ToBytes(req.data) };
    case 'invokeButton':
      return {
        type: 'invokeEffectAction',
        group: { layer: t.layer, path: group },
        action: req.key,
        ...(req.payload !== undefined ? { payload: req.payload } : {}),
      };
  }
}

/** The undo label of a panel edit. */
export function panelLabel(req: PanelRequest, effectName: string, params: readonly EffectParamUi[]): string {
  if (req.type === 'requestPreview') return effectName;
  const base = req.key.replace(/[XYZ]$/, '');
  const name = params.find((p) => p.key === req.key || p.key === base)?.name;
  return name ? `${effectName}: ${name}` : effectName;
}

export interface PanelState {
  premation: typeof PANEL_PROTOCOL;
  type: 'state';
  effect: { id: string; type: string; name: string };
  plugin: string;
  /** The editor's time, seconds. */
  time: number;
  /** The plugin's params as it shows them (UPDATE_PARAMS_UI). */
  params: Array<{ key: string; name: string; enabled: boolean; hidden: boolean }>;
  /** The effect's stored values by key (static; an animated one as the document stores it). */
  values: Record<string, unknown>;
  /** `sequence` and the ARBITRARY_DATA params' bytes, base64. */
  data: Record<string, string>;
}

export function panelState(input: {
  effect: { id: string; type: string; name: string };
  plugin: string;
  time: number;
  params: readonly EffectParamUi[];
  values: Record<string, unknown> | undefined;
  data: readonly PluginDataEntry[];
}): PanelState {
  const data: Record<string, string> = {};
  for (const d of input.data) data[d.key] = bytesToBase64(d.data);
  return {
    premation: PANEL_PROTOCOL,
    type: 'state',
    effect: input.effect,
    plugin: input.plugin,
    time: input.time,
    params: input.params.map((p) => ({ key: p.key, name: p.name, enabled: p.enabled, hidden: p.hidden })),
    values: { ...(input.values ?? {}) },
    data,
  };
}

export interface PanelReply {
  premation: typeof PANEL_PROTOCOL;
  type: 'reply';
  id: number;
  ok: boolean;
  error?: string;
  /** requestPreview: a `data:image/png;base64,…` URL of the engine's render. */
  image?: string;
}

export function panelReply(id: number, r: { ok: true; image?: string } | { ok: false; error: string }): PanelReply {
  return r.ok
    ? { premation: PANEL_PROTOCOL, type: 'reply', id, ok: true, ...(r.image ? { image: r.image } : {}) }
    : { premation: PANEL_PROTOCOL, type: 'reply', id, ok: false, error: r.error };
}
