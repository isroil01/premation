/**
 * componentStore — a reusable-component library. The user saves any selection
 * (a single node subtree, or several layers) as a named component, then inserts
 * copies of it anywhere. This is the practical "component reuse" the ad
 * benchmark needs: define a Card / Button / Phone once, reuse it many times.
 *
 * Phase 1 = template copies (each insert is an independent, fully-editable
 * clone). Live master→instance linking is a deliberate later phase; this covers
 * the day-to-day reuse workflow without touching the scene model or renderer.
 *
 * Definitions persist to localStorage so the library survives reloads.
 */

import { create } from 'zustand';
import type { SceneNode, Component, Transform } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useSelectionStore } from './selectionStore';
import { useCompositionStore } from './compositionStore';
import { bumpScene } from './sceneStore';

interface SerializedNode {
  name: string;
  transform: Transform;
  components: Component[];
  children: SerializedNode[];
}
export interface ComponentDef {
  id: string;
  name: string;
  createdAt: number;
  root: SerializedNode;
}

const STORE_KEY = 'motion-editor.components';
let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 6);

// ── serialize a live subtree into a template (deep, id-free) ──────────
function serialize(nodeId: string): SerializedNode | null {
  const n = defaultSceneGraph.getNode(nodeId);
  if (!n) return null;
  return {
    name: n.name ?? 'Node',
    transform: JSON.parse(JSON.stringify(n.transform)) as Transform,
    components: JSON.parse(JSON.stringify(n.components)) as Component[],
    children: defaultSceneGraph.getChildren(nodeId)
      .map((c) => serialize(c.id))
      .filter((x): x is SerializedNode => x !== null),
  };
}

// ── instantiate a template into the live scene with fresh ids ─────────
function instantiate(def: SerializedNode, parentId: string, pos: { x: number; y: number } | null): string {
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
  defaultSceneGraph.addChild(parentId, node);
  for (const child of def.children) instantiate(child, id, null);
  return id;
}

function rootId(): string {
  return activeCompRootId();
}
function compCenter(): { x: number; y: number } {
  const s = useCompositionStore.getState();
  return { x: (s.width ?? 1920) / 2, y: (s.height ?? 1080) / 2 };
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

interface ComponentState {
  components: ComponentDef[];
}
interface ComponentActions {
  /** Save the current selection as a named component. Returns the def id (or null). */
  saveFromSelection: (name: string) => string | null;
  /** Insert a copy of a saved component at the composition centre; selects it. */
  insert: (id: string) => string | null;
  remove: (id: string) => void;
}

export const useComponentStore = create<ComponentState & ComponentActions>((set, get) => ({
  components: load(),

  saveFromSelection: (name) => {
    const ids = useSelectionStore.getState().ids;
    if (ids.length === 0) return null;

    let root: SerializedNode | null;
    if (ids.length === 1) {
      root = serialize(ids[0]!);
    } else {
      // Wrap a multi-selection under a synthetic group so it reuses as one unit.
      const children = ids.map((i) => serialize(i)).filter((x): x is SerializedNode => x !== null);
      root = {
        name,
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{ id: 'g', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
        children,
      };
    }
    if (!root) return null;

    const def: ComponentDef = { id: `def_${Date.now()}_${rand()}`, name: name.trim() || 'Component', createdAt: Date.now(), root };
    const next = [def, ...get().components];
    persist(next);
    set({ components: next });
    return def.id;
  },

  insert: (id) => {
    const def = get().components.find((c) => c.id === id);
    if (!def) return null;
    const gid = instantiate(def.root, rootId(), compCenter());
    useSelectionStore.getState().set([gid]);
    bumpScene();
    return gid;
  },

  remove: (id) => {
    const next = get().components.filter((c) => c.id !== id);
    persist(next);
    set({ components: next });
  },
}));
