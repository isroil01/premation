/**
 * The host side of the plugin API — the only door between a sandboxed plugin
 * and the user's document.
 *
 * Every method here is reached by exactly one route: a `call` message from a
 * worker, dispatched by `PluginHost` only after the method's required
 * permission (`METHOD_PERMISSIONS`) has been checked against what the user
 * granted at install time. A plugin cannot reach a singleton, so it cannot
 * reach anything this file does not deliberately hand it.
 *
 * Two rules the implementations follow:
 *
 *   1. **Arguments are untrusted.** They crossed a `postMessage` boundary from
 *      third-party code. Every one is re-validated here; a `NaN` time or a
 *      1 MB layer name is a bug report against us, not against the plugin.
 *   2. **Writes are undoable, as one entry.** A plugin command the user did not
 *      like has to be one Ctrl-Z, not fifty — so each mutating call runs inside
 *      `runDocumentEdit` labelled with the plugin's name.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { readNodeKind } from '@core/scene/sceneDerive';
import { bumpScene } from '@stores/sceneStore';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import type { PluginManifest } from './manifest';
import type { PluginCommandSpec } from './protocol';

/** What a plugin may create. Deliberately the primitives, not every internal
 *  node kind — a plugin has no business minting a camera or a comp root. */
const CREATABLE: SceneKind[] = ['shape', 'text', 'group', 'null'];

const MAX_STRING = 500;
const MAX_KEYFRAMES_PER_CALL = 5000;

class PluginApiError extends Error {}

const fail = (msg: string): never => { throw new PluginApiError(msg); };

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STRING) {
    return fail(`${what} must be a string of 1–${MAX_STRING} characters.`);
  }
  return v;
};

const finite = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${what} must be a finite number.`);
  return v;
};

const node = (id: unknown) => {
  const n = defaultSceneGraph.getNode(str(id, 'layer id'));
  return n ?? fail(`No layer with id "${String(id)}".`);
};

/** Serialisable view of a layer — never the live node. */
function layerView(id: string) {
  const n = node(id);
  const props: Record<string, unknown> = {};
  for (const c of n.components) {
    for (const [k, v] of Object.entries(c.props as Record<string, unknown>)) {
      // Only JSON-safe scalars cross the boundary; geometry arrays and nested
      // config would balloon the message and mean nothing without the types.
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') props[k] = v;
    }
  }
  return {
    id: n.id,
    name: n.name,
    kind: readNodeKind(n),
    parent: n.parent,
    visible: n.visible !== false,
    locked: n.locked === true,
    children: [...n.children],
    props,
  };
}

/**
 * Build the method table for ONE plugin.
 *
 * Bound per plugin rather than shared so every undo entry can carry the name of
 * the plugin that caused it, and so `openPanel` knows whose panel to open.
 */
export function createHostApi(
  manifest: PluginManifest,
  hooks: {
    registerCommand: (spec: PluginCommandSpec) => void;
    openPanel: () => void;
    closePanel: () => void;
  },
): Record<string, (...args: unknown[]) => unknown> {
  const edit = <T>(what: string, fn: () => T): T => runDocumentEdit(`${manifest.name}: ${what}`, fn);

  return {
    // ── UI / core ────────────────────────────────────────────────────────
    'ui.notify': (message, level) => {
      const lv = level === 'success' || level === 'warning' || level === 'error' ? level : 'info';
      useUIStore.getState().notify({
        level: lv,
        // Prefixed, always: a toast that looks like it came from the editor is
        // a phishing surface, and the user has to be able to tell who is talking.
        message: `${manifest.name}: ${String(message).slice(0, MAX_STRING)}`,
        durationMs: 4000,
      });
      return true;
    },
    'ui.openPanel': () => {
      // Refuse rather than open an empty frame: a plugin that forgot to declare
      // `panel` in its manifest has a bug, and it should read as one.
      if (!manifest.panel) {
        return fail('This plugin declares no "panel" in its manifest, so there is no panel to open.');
      }
      hooks.openPanel();
      return true;
    },
    'ui.closePanel': () => { hooks.closePanel(); return true; },

    'commands.register': (spec) => {
      const s = spec as Partial<PluginCommandSpec>;
      hooks.registerCommand({
        id: str(s?.id, 'command id'),
        label: str(s?.label, 'command label').slice(0, 80),
        ...(typeof s?.icon === 'string' ? { icon: s.icon } : {}),
        ...(s?.needsSelection === true ? { needsSelection: true } : {}),
      });
      return true;
    },

    'composition.get': () => {
      const c = useCompositionStore.getState();
      return { name: c.name, width: c.width, height: c.height, fps: c.fps, durationSeconds: c.durationSeconds };
    },

    // ── Scene, read ──────────────────────────────────────────────────────
    'scene.getSelection': () => [...useSelectionStore.getState().ids],
    'scene.setSelection': (ids) => {
      if (!Array.isArray(ids)) return fail('setSelection expects an array of layer ids.');
      const valid = ids.filter((i): i is string => typeof i === 'string' && !!defaultSceneGraph.getNode(i));
      useSelectionStore.getState().set(valid);
      return valid;
    },
    'scene.getLayers': () => {
      const out: ReturnType<typeof layerView>[] = [];
      const walk = (id: string): void => {
        out.push(layerView(id));
        for (const c of defaultSceneGraph.getChildren(id)) walk(c.id);
      };
      for (const r of defaultSceneGraph.getRoots()) walk(r.id);
      return out;
    },
    'scene.getLayer': (id) => layerView(str(id, 'layer id')),

    // ── Scene, write ─────────────────────────────────────────────────────
    'scene.createLayer': (opts) => {
      const o = (opts ?? {}) as Record<string, unknown>;
      const kind = String(o.kind ?? 'shape') as SceneKind;
      if (!CREATABLE.includes(kind)) {
        return fail(`Cannot create a "${kind}" layer. Creatable kinds: ${CREATABLE.join(', ')}.`);
      }
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : kind;
      return edit(`create ${name}`, () => {
        insertPrimitive(kind, name);
        const id = useSelectionStore.getState().ids[0];
        if (!id) return fail('The layer could not be created.');
        if (o.x !== undefined || o.y !== undefined) {
          const n = defaultSceneGraph.getNode(id)!;
          const t = n.components.find((c) => c.type === 'Transform');
          if (t) {
            if (o.x !== undefined) defaultSceneGraph.writeProp(id, t.id, 'x', finite(o.x, 'x'));
            if (o.y !== undefined) defaultSceneGraph.writeProp(id, t.id, 'y', finite(o.y, 'y'));
          }
        }
        bumpScene();
        return id;
      });
    },

    'scene.setProperty': (id, prop, value) => {
      const n = node(id);
      const p = str(prop, 'property name');
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
        return fail('Property values must be a number, string or boolean.');
      }
      const target = n.components.find((c) => p in (c.props as Record<string, unknown>))
        ?? n.components.find((c) => c.type === 'Transform');
      if (!target) return fail(`Layer "${n.name}" has no component that can hold "${p}".`);
      return edit(`set ${p}`, () => {
        const ok = defaultSceneGraph.writeProp(n.id, target.id, p, value);
        bumpScene();
        return ok;
      });
    },

    'scene.renameLayer': (id, name) => {
      const n = node(id);
      const nm = str(name, 'layer name').slice(0, 80);
      return edit('rename layer', () => { n.name = nm; bumpScene(); return true; });
    },

    'scene.deleteLayer': (id) => {
      const n = node(id);
      // A comp root is not a layer; deleting one would take the composition
      // with it, and no plugin asked for that.
      if (n.parent === null) return fail('That is a composition root, not a layer.');
      return edit(`delete ${n.name}`, () => { defaultSceneGraph.removeNode(n.id); bumpScene(); return true; });
    },

    // ── Animation, read ──────────────────────────────────────────────────
    'animation.getTracks': (id) =>
      defaultAnimation.tracksFor(node(id).id).map((t) => ({
        prop: t.prop,
        keyframes: t.keyframes.map((k) => ({ t: k.t, value: k.value, easing: k.easing })),
      })),

    'animation.sample': (id, prop, time) =>
      defaultAnimation.sample(node(id).id, str(prop, 'property') as never, finite(time, 'time')) ?? null,

    // ── Animation, write ─────────────────────────────────────────────────
    'animation.setKeyframe': (id, prop, time, value, easing) => {
      const n = node(id);
      const p = str(prop, 'property') as never;
      const t = finite(time, 'time');
      const v = finite(value, 'value');
      return edit(`keyframe ${String(prop)}`, () => {
        defaultAnimation.setKeyframe(n.id, p, t, v, typeof easing === 'string' ? (easing as never) : undefined);
        return true;
      });
    },

    'animation.setKeyframes': (id, prop, kfs) => {
      const n = node(id);
      const p = str(prop, 'property') as never;
      if (!Array.isArray(kfs)) return fail('setKeyframes expects an array.');
      if (kfs.length > MAX_KEYFRAMES_PER_CALL) {
        return fail(`A single call may write at most ${MAX_KEYFRAMES_PER_CALL} keyframes.`);
      }
      const clean = kfs.map((k, i) => {
        const o = (k ?? {}) as Record<string, unknown>;
        return {
          t: finite(o.t, `keyframe[${i}].t`),
          value: finite(o.value, `keyframe[${i}].value`),
          ...(typeof o.easing === 'string' ? { easing: o.easing as never } : {}),
        };
      });
      return edit(`animate ${String(prop)}`, () => {
        // The bulk API: one sort, one notification. Writing these one at a time
        // is what made generated tracks freeze the app.
        defaultAnimation.setKeyframes(n.id, p, clean);
        return true;
      });
    },

    'animation.removeKeyframe': (id, prop, time) => {
      const n = node(id);
      const p = str(prop, 'property') as never;
      const t = finite(time, 'time');
      return edit(`remove keyframe ${String(prop)}`, () => { defaultAnimation.removeKeyframe(n.id, p, t); return true; });
    },

    'animation.setExpression': (id, prop, source) => {
      const n = node(id);
      const p = str(prop, 'property') as never;
      const src = str(source, 'expression source');
      return edit(`expression ${String(prop)}`, () => { defaultAnimation.setExpression(n.id, p, src); return true; });
    },

    // ── Timeline ─────────────────────────────────────────────────────────
    'timeline.getTime': () => getTimelineController().currentSeconds,
    'timeline.setTime': (seconds) => {
      getTimelineController().seekSeconds(Math.max(0, finite(seconds, 'time')));
      return true;
    },
  };
}
