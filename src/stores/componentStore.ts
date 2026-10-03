/**
 * componentStore — a reusable-component library. The user saves any selection
 * (a single layer subtree, or several layers) as a named component, then inserts
 * copies of it anywhere. This is the practical "component reuse" the ad
 * benchmark needs: define a Card / Button / Phone once, reuse it many times.
 *
 * Phase 1 = template copies (each insert is an independent, fully-editable
 * clone). Live master→instance linking is a deliberate later phase; this covers
 * the day-to-day reuse workflow without touching the scene model or renderer.
 *
 * B4 round 5: a component is stored as the engine's clipboard form — the
 * `copyLayers` fragment of the saved layers (keyframes, expressions and bars
 * included, which the old component-record capture dropped) — and inserted with
 * ONE `pasteLayers` (a multi-layer component grouped under its name, the root
 * placed at the drop point or the composition centre), one undo entry. Libraries
 * saved before that hold the legacy `SerializedNode` tree (`root`): such a
 * component is still inserted from its tree (built off-document) and MIGRATED on
 * that first insert — the inserted copy's fragment replaces the tree.
 *
 * Definitions persist to localStorage so the library survives reloads.
 */

import { create } from 'zustand';
import type { Command, DocumentFragment } from '@motion/engine-api';
import type { SceneNode, Component, Transform } from '@core/types';
import { documentMirror } from './documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { useSelectionStore } from './selectionStore';
import { insertFragment } from '@/engine-client/insertFragment';
import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { trackWrites } from '@layout/Inspector/inspectorEdits';
import { getTime } from './playbackClockStore';

/** The legacy (v1) saved form: a component-record tree with no ids. */
export interface SerializedNode {
  name: string;
  transform: Transform;
  components: Component[];
  children: SerializedNode[];
}

/** A `copyLayers` fragment as stored: its version and its bytes as UTF-8 text. */
export interface StoredFragment {
  version: number;
  data: string;
}

export interface ComponentDef {
  id: string;
  name: string;
  createdAt: number;
  /** The saved layers (the engine's copyLayers fragment). */
  fragment?: StoredFragment;
  /** Legacy (v1) libraries: the saved tree, until the component is first inserted (then `fragment`). */
  root?: SerializedNode;
}

const STORE_KEY = 'motion-editor.components';
let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 6);

function toStored(f: DocumentFragment): StoredFragment {
  return { version: f.version, data: new TextDecoder().decode(f.data) };
}
function fromStored(f: StoredFragment): DocumentFragment {
  return { version: f.version, data: new TextEncoder().encode(f.data) };
}

// ── a legacy (v1) tree as fresh nodes (parents first); the insert adds them ───
function instantiate(def: SerializedNode, parentId: string, pos: { x: number; y: number } | null, out: SceneNode[] = []): SceneNode[] {
  const id = `cmp_${(seq += 1)}_${rand()}`;
  const components: Component[] = def.components.map((c) => ({
    id: `${id}_${c.type}_${rand()}`,
    type: c.type,
    props: { ...(c.props as Record<string, unknown>) },
  }));
  const transform: Transform = JSON.parse(JSON.stringify(def.transform));
  // Root is placed at `pos`; children keep their positions relative to it.
  if (pos) {
    transform.position = { ...transform.position, x: pos.x, y: pos.y };
    const t = components.find((c) => c.type === 'Transform');
    if (t) { (t.props as Record<string, unknown>).x = pos.x; (t.props as Record<string, unknown>).y = pos.y; }
  }
  const node: SceneNode = { id, name: def.name, parent: parentId, children: [], visible: true, locked: false, transform, components } as unknown as SceneNode;
  out.push(node);
  for (const child of def.children) instantiate(child, id, null, out);
  return out;
}

function rootId(): string {
  return activeCompIdNow() ?? 'comp_root';
}
function compCenter(): { x: number; y: number } {
  const s = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
  return { x: (s?.width ?? 1920) / 2, y: (s?.height ?? 1080) / 2 };
}

function load(): ComponentDef[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    return raw ? (JSON.parse(raw) as ComponentDef[]) : [];
  } catch { return []; }
}
function persist(defs: ComponentDef[]): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(defs)); } catch { /* quota / private mode */ }
}

/** The saved layers' fragment (`copyLayers`), or null when the engine refused. */
async function copyFragment(layers: readonly string[]): Promise<StoredFragment | null> {
  const res = await engine().query({ type: 'copyLayers', layers: [...layers] });
  return res.ok ? toStored(res.value) : null;
}

/** Paste a stored component into `comp` as ONE entry: grouped under `name` when it holds several top-level layers, the root moved to `at`. */
async function pasteComponent(def: ComponentDef & { fragment: StoredFragment }, comp: string, at: { x: number; y: number }): Promise<string | null> {
  const label = `Insert ${def.name}`;
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let root: string | null = null;
  const pasted = await client.execute({ type: 'pasteLayers', comp, fragment: fromStored(def.fragment), index: 0 });
  if (pasted.ok) {
    const ids = (pasted.value as { layers?: string[] }).layers ?? [];
    // The top-level pasted layers: those whose parent was not pasted with them (the engine's LayerInfo).
    const info = await client.query({ type: 'getLayers', layers: ids });
    const parents = new Map((info.ok ? info.value.layers : []).map((l) => [l.id, l.parent]));
    const tops = ids.filter((id) => {
      const parent = parents.get(id);
      return !parent || !ids.includes(parent);
    });
    root = tops.length === 1 ? tops[0]! : null;
    if (tops.length > 1) {
      const grouped = await client.execute({ type: 'groupLayers', layers: tops, name: def.name });
      if (grouped.ok) root = (grouped.value as { layer: string }).layer;
      else reportEngineError(label, grouped.error);
    }
    if (root) {
      const writes = trackWrites(root, { x: at.x, y: at.y }, getTime());
      if (writes.length > 0) {
        const moved = await client.execute({ type: 'setProperties', writes } as Command);
        if (!moved.ok) reportEngineError(label, moved.error);
      }
    }
  } else {
    reportEngineError(label, pasted.error);
  }
  const closed = await client.endGesture(opened.value.gesture, root !== null);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (root) useSelectionStore.getState().set([root]);
  return root;
}

interface ComponentState {
  components: ComponentDef[];
}
interface ComponentActions {
  /** Save the current selection as a named component (the engine's copyLayers). Resolves to the def id (or null). */
  saveFromSelection: (name: string) => Promise<string | null>;
  /**
   * Insert a copy of a saved component at the composition centre (or at the
   * world point `at`, a canvas drop); selects it. ONE undo entry (one
   * `pasteLayers`). Resolves to the new root layer id, or null.
   */
  insert: (id: string, at?: { x: number; y: number }) => Promise<string | null>;
  remove: (id: string) => void;
}

export const useComponentStore = create<ComponentState & ComponentActions>((set, get) => ({
  components: load(),

  saveFromSelection: async (name) => {
    const m = documentMirror();
    const ids = useSelectionStore.getState().ids.filter((id) => m.layer(id) !== undefined);
    if (ids.length === 0) return null;
    const fragment = await copyFragment(ids);
    if (!fragment) return null;
    const def: ComponentDef = { id: `def_${Date.now()}_${rand()}`, name: name.trim() || 'Component', createdAt: Date.now(), fragment };
    const next = [def, ...get().components];
    persist(next);
    set({ components: next });
    return def.id;
  },

  insert: async (id, at) => {
    const def = get().components.find((c) => c.id === id);
    if (!def) return null;
    const comp = rootId();
    if (def.fragment) return pasteComponent(def as ComponentDef & { fragment: StoredFragment }, comp, at ?? compCenter());
    if (!def.root) return null;
    // Legacy (v1): the saved tree laid into a fragment (its root at the drop point or the
    // comp centre) and pasted as one entry, then migrated to the inserted copy's fragment.
    const legacyRoot = def.root;
    const ids = await insertFragment(`Insert ${def.name}`, (b) => {
      const nodes = instantiate(legacyRoot, comp, at ?? compCenter());
      for (const node of nodes) b.addChild(node.parent!, node);
      return nodes[0]!.id;
    }, { comp });
    const root = ids?.[0] ?? null;
    if (root) {
      const fragment = await copyFragment([root]);
      if (fragment) {
        const next = get().components.map((c) => (c.id === def.id ? { id: c.id, name: c.name, createdAt: c.createdAt, fragment } : c));
        persist(next);
        set({ components: next });
      }
    }
    return root;
  },

  remove: (id) => {
    const next = get().components.filter((c) => c.id !== id);
    persist(next);
    set({ components: next });
  },
}));
