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
import { insertImageNode } from '@core/scene/sceneInsert';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { checkOwnership } from './layerKindRegistry';
import { buildCustomLayerNode, isReservedPropPath, readCustomLayer } from './customLayers';
import { regenerateProxyChildren } from './proxySubtree';
import { onLayerChanged } from './layerChangeNotifier';
import type { PluginManifest } from './manifest';
import type { PluginCommandSpec } from './protocol';
import { createImageAsset, readAssetPixels, requireAsset } from './assets';
import { reparentNode } from '@core/scene/parenting';
import {
  addEffect, removeEffect, updateEffectParam, getNodeEffects, effectDefFor,
} from '@core/effects/effects';
import { pluginNetFetch } from './pluginNetFetch';
import { mainProcessFetch } from './pluginNetBridge';

/** What a plugin may create. Deliberately the primitives plus `image`, not
 *  every internal node kind — a plugin has no business minting a camera or a
 *  comp root. `image` is here because the asset API would otherwise be able to
 *  make a picture and have nowhere to put it. */
const CREATABLE: SceneKind[] = ['shape', 'text', 'group', 'null', 'image'];

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
    openPanel: (panelId: string) => void;
    closePanel: (panelId: string) => void;
    /** Write a line to this plugin's log — used to nudge authors toward
     *  declaring what they register, without breaking anything today. */
    warn: (text: string) => void;
    /** Deliver an authored-edit event to the plugin's worker. */
    emitLayerChanged?: (event: unknown) => void;
  },
): Record<string, (...args: unknown[]) => unknown> {
  const edit = <T>(what: string, fn: () => T): T => runDocumentEdit(`${manifest.name}: ${what}`, fn);

  /**
   * Which panel a panel-shaped call means.
   *
   * The id is optional and defaults to the sole panel, because the
   * overwhelmingly common plugin has exactly one and `openPanel()` reading
   * naturally matters more than uniformity. With two or more, guessing would
   * open the wrong one silently — so it is an error that names the choices.
   */
  const panelId = (raw: unknown): string => {
    const panels = manifest.contributes.panels;
    if (panels.length === 0) {
      return fail('This plugin declares no panels in its manifest, so there is no panel to open.');
    }
    if (raw === undefined || raw === null) {
      if (panels.length === 1) return panels[0]!.id;
      return fail(
        `This plugin declares ${panels.length} panels — name one: ${panels.map((p) => p.id).join(', ')}.`,
      );
    }
    const id = str(raw, 'panel id');
    if (!panels.some((p) => p.id === id)) {
      return fail(`No panel "${id}" in this plugin's manifest. Declared: ${panels.map((p) => p.id).join(', ')}.`);
    }
    return id;
  };

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
    // Refuses rather than opening an empty frame: a plugin that forgot to
    // declare its panel has a bug, and it should read as one.
    'ui.openPanel': (id) => { hooks.openPanel(panelId(id)); return true; },
    'ui.closePanel': (id) => { hooks.closePanel(panelId(id)); return true; },

    'commands.register': (spec) => {
      const s = spec as Partial<PluginCommandSpec>;
      const id = str(s?.id, 'command id');
      // Still supported, and still works — this is how every API-1 plugin
      // contributes. But an undeclared command cannot appear in the palette
      // until the worker has booted, which is the whole thing `contributes`
      // exists to fix, so an API-2 author gets told. A warning, not an error:
      // the goal is migration, not breakage.
      if (
        manifest.apiVersion >= 2 &&
        !manifest.contributes.commands.some((c) => c.id === id)
      ) {
        hooks.warn(
          `command "${id}" was registered at runtime but is not in "contributes.commands" — ` +
          'declare it so it appears before the plugin starts.',
        );
      }
      hooks.registerCommand({
        id,
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

      /*
        A plugin's own layer kind.

        Recognised by the dot: a native kind is a bare word (`shape`, `text`),
        a custom one is always `<pluginId>.<kindId>`. Ownership is checked
        HOST-side against the registry, on the resolved string, because this
        argument crossed `postMessage` and is untrusted text — and a plugin
        that could create another's layers could forge the authored interface
        of software the user trusts differently.
      */
      if (kind.includes('.')) {
        const check = checkOwnership(manifest.id, kind);
        if (!check.ok) return fail(check.message);
        const { kind: schema } = check.entry;

        const name = typeof o.name === 'string' && o.name.trim()
          ? o.name.trim().slice(0, 80)
          : schema.label;
        const rawProps = o.props && typeof o.props === 'object' && !Array.isArray(o.props)
          ? (o.props as Record<string, unknown>)
          : {};

        return edit(`create ${name}`, () => {
          const id = `n_${Math.random().toString(36).slice(2, 10)}`;
          // `buildCustomLayerNode` seeds every declared prop from its default
          // and validates each override against the schema, so a value the
          // plugin sent that its own manifest forbids never reaches the graph.
          defaultSceneGraph.addNode(buildCustomLayerNode(id, manifest.id, schema, {
            name,
            ...(o.x !== undefined ? { x: finite(o.x, 'x') } : {}),
            ...(o.y !== undefined ? { y: finite(o.y, 'y') } : {}),
            props: rawProps,
          }));
          bumpScene();
          return id;
        });
      }

      if (!CREATABLE.includes(kind)) {
        return fail(`Cannot create a "${kind}" layer. Creatable kinds: ${CREATABLE.join(', ')}.`);
      }
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : kind;

      // An image layer is not a primitive — it needs a source, and the only
      // source a plugin can name is an asset id it either read or created.
      if (kind === 'image') {
        const asset = requireAsset(str(o.assetId, 'assetId'));
        return edit(`create ${name}`, () => {
          const id = insertImageNode({
            name: name === 'image' ? asset.name : name,
            src: asset.src,
            width: asset.metadata?.width ?? 400,
            height: asset.metadata?.height ?? 400,
            ...(o.x !== undefined ? { x: finite(o.x, 'x') } : {}),
            ...(o.y !== undefined ? { y: finite(o.y, 'y') } : {}),
          });
          // Bind the layer back to the library entry, exactly as a drag-drop
          // import does — without this the picture works but is not the asset,
          // so reinterpretation and proxying skip it.
          //
          // Through `writeProp`, NOT `t.props.assetId = …`. The node is already
          // in the graph by this point, so `getNode` hands back a copy and a
          // direct assignment is discarded in silence — the layer would render
          // correctly and simply never be linked to the asset.
          const n = defaultSceneGraph.getNode(id);
          const t = n?.components.find((c) => c.type === 'Transform');
          if (t) defaultSceneGraph.writeProp(id, t.id, 'assetId', asset.id);
          bumpScene();
          return id;
        });
      }

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

    /**
     * Replace a proxy layer's generated children.
     *
     * DIFFED against what is there, not recreated — a child whose `key` is
     * unchanged keeps its scene-graph id, so selection, parenting and other
     * layers' expressions keep working across a parameter tweak.
     */
    'scene.setProxyChildren': (layerId, children) => {
      const n = node(layerId);
      const record = readCustomLayer(n);
      if (!record) return fail('That layer is not a plugin layer kind.');

      const check = checkOwnership(manifest.id, record.kind);
      if (!check.ok) return fail(check.message);
      if (check.entry.kind.render !== 'proxy') {
        return fail(`"${record.kind}" declares render: "${check.entry.kind.render}", so it has no generated children.`);
      }
      if (!Array.isArray(children)) return fail('`children` must be an array.');

      const specs = children.map((raw, i) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        const key = typeof c.key === 'string' && c.key ? c.key : '';
        if (!key) return fail(`children[${i}].key is required, and must be stable across regenerations.`);
        return {
          key,
          kind: typeof c.kind === 'string' ? c.kind : 'shape',
          ...(typeof c.name === 'string' ? { name: c.name } : {}),
          ...(c.props && typeof c.props === 'object' ? { props: c.props as Record<string, unknown> } : {}),
          ...(c.expressions && typeof c.expressions === 'object'
            ? { expressions: c.expressions as Record<string, string> }
            : {}),
        };
      });

      const result = regenerateProxyChildren(n.id, manifest.id, manifest.name, specs, Date.now());
      if (result.refused === 'detached') {
        return fail(
          'The user has edited these layers, so this plugin no longer manages them. '
          + 'Silently overwriting them is what the ownership mark exists to prevent.',
        );
      }
      return result;
    },

    /**
     * Be told when a user AUTHORS one of this plugin's layers.
     *
     * Never fires for animated value changes — see `layerChangeNotifier.ts`.
     * Animated values reach generated children through expression bindings the
     * engine evaluates, with no plugin involved at runtime.
     */
    'scene.onLayerChanged': (kindId) => {
      const id = str(kindId, 'layer kind id');
      const check = checkOwnership(manifest.id, `${manifest.id}.${id}`);
      if (!check.ok) return fail(check.message);
      onLayerChanged(manifest.id, id, (event) => hooks.emitLayerChanged?.(event));
      return true;
    },

    'scene.setProperty': (id, prop, value) => {
      const n = node(id);
      const p = str(prop, 'property name');
      // Reserved. A plugin's own declared props are addressed by name through
      // its layer kind, not by their internal track path — writing one here
      // would create a junk key on the Transform component that renders
      // nothing and animates nothing.
      if (isReservedPropPath(p)) {
        return fail(`"${p}" is reserved. Set a layer kind's own property by its declared name.`);
      }
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

    /**
     * Reparent a layer, or move it to the composition root with `null`.
     *
     * The world pose is preserved: the child adopts whatever local transform
     * reproduces where it already sits. Grouping a layer must not move it, and
     * a plugin compensating by hand would get it wrong for anything rotated or
     * scaled.
     *
     * `canReparent` owns the rules — no cycles, no self-parent, one composition
     * — and it says in as many words that they live there rather than in the
     * dropdown BECAUSE scripting paths call this directly. This is one.
     */
    'scene.setParent': (id, parentId) => {
      const n = node(id);
      const target = parentId === null || parentId === undefined ? null : str(parentId, 'parent id');
      if (target !== null) node(target); // exists — same message as any bad id
      return edit(`reparent ${n.name}`, () => {
        // `reparentNode` returns false rather than throwing, and a false
        // swallowed here is a plugin believing it built a hierarchy it did not.
        if (!reparentNode(n.id, target)) {
          return fail(
            `"${n.name}" cannot be parented there — a layer cannot be its own ancestor, `
            + 'and parenting only works within one composition.',
          );
        }
        bumpScene();
        return true;
      });
    },

    /**
     * Show or hide a layer.
     *
     * Assigned through the node VIEW, which writes through to the entity —
     * unlike `components[].props`, which are rebuilt on read and need
     * `writeProp`. Both come out of `getNode`, which is why the two look
     * interchangeable and are not.
     */
    'scene.setVisible': (id, visible) => {
      const n = node(id);
      if (typeof visible !== 'boolean') return fail('visible must be true or false.');
      return edit(`${visible ? 'show' : 'hide'} ${n.name}`, () => {
        n.visible = visible;
        bumpScene();
        return true;
      });
    },

    /** Lock or unlock a layer. A locked layer refuses edits from the canvas. */
    'scene.setLocked': (id, locked) => {
      const n = node(id);
      if (typeof locked !== 'boolean') return fail('locked must be true or false.');
      return edit(`${locked ? 'lock' : 'unlock'} ${n.name}`, () => {
        n.locked = locked;
        bumpScene();
        return true;
      });
    },

    // ── Effects ──────────────────────────────────────────────────────────

    /** The effect stack on a layer, in draw order. */
    'effects.list': (id) => {
      const n = node(id);
      return getNodeEffects(n.id).map((e) => ({
        id: e.id,
        type: e.type,
        enabled: e.enabled !== false,
        params: { ...e.params },
      }));
    },

    /**
     * Add an effect to a layer, returning its id.
     *
     * ★ The type is checked HERE, before `addEffect` sees it.
     *
     * `addEffect` opens with `const def = DEF.get(type); if (!def) return;` — an
     * unknown type is a silent no-op with no return value and no error. That is
     * defensible for a menu which can only offer types it has, and exactly
     * wrong for an API taking a string across `postMessage`: the plugin would
     * report success, the user would see nothing, and the only evidence would be
     * an effect stack that did not grow. It is also the shape of the bug that
     * made plugin-contributed effects unaddable when they first shipped.
     */
    'effects.add': (id, type) => {
      const n = node(id);
      const t = str(type, 'effect type');
      if (!effectDefFor(t)) {
        return fail(
          `"${t}" is not an effect this editor has. A plugin's own effect is addressed as `
          + '"<pluginId>.<effectId>", and only once that plugin is running.',
        );
      }
      return edit(`add ${t}`, () => {
        const before = new Set(getNodeEffects(n.id).map((e) => e.id));
        addEffect(n.id, t as never);
        // Read back rather than trusting a requested id: `addEffect` falls back
        // to a generated one when the id it was given is taken, silently.
        const added = getNodeEffects(n.id).find((e) => !before.has(e.id));
        if (!added) return fail(`"${t}" could not be added to "${n.name}".`);
        bumpScene();
        return added.id;
      });
    },

    'effects.remove': (id, effectId) => {
      const n = node(id);
      const fx = str(effectId, 'effect id');
      // `removeEffect` filters, so removing something absent succeeds quietly.
      // A plugin removing the wrong id should hear about it.
      if (!getNodeEffects(n.id).some((e) => e.id === fx)) {
        return fail(`"${n.name}" has no effect "${fx}".`);
      }
      return edit('remove effect', () => {
        removeEffect(n.id, fx);
        bumpScene();
        return true;
      });
    },

    'effects.setParam': (id, effectId, key, value) => {
      const n = node(id);
      const fx = str(effectId, 'effect id');
      const k = str(key, 'parameter name');
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
        return fail('Effect parameter values must be a number, string or boolean.');
      }
      if (!getNodeEffects(n.id).some((e) => e.id === fx)) {
        return fail(`"${n.name}" has no effect "${fx}".`);
      }
      return edit(`set ${k}`, () => {
        updateEffectParam(n.id, fx, k, value as never);
        bumpScene();
        return true;
      });
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
      return edit(`expression ${String(prop)}`, () => {
        // Stamped with the plugin id. This is the one API that writes text the
        // engine will later EXECUTE, and what it writes outlives the plugin:
        // the expression is saved into the document, survives uninstalling the
        // plugin, and re-evaluates for collaborators who never had it. Without
        // the stamp, a user looking at wrong animation cannot tell a formula
        // they wrote from one a plugin left behind.
        defaultAnimation.setExpression(n.id, p, src, manifest.id);
        return true;
      });
    },

    // ── Assets ───────────────────────────────────────────────────────────
    /**
     * Read an image's pixels, by asset id or by the layer showing it.
     *
     * `{ layerId }` is the ref that makes the API usable: a plugin acting on
     * the selection has layer ids and nothing else, and making it look up an
     * asset id first would mean exposing the layer's internal props to find one.
     */
    'assets.getImage': async (ref) => {
      const r = (ref ?? {}) as Record<string, unknown>;
      if (typeof r.assetId === 'string') {
        return readAssetPixels(manifest.id, requireAsset(r.assetId));
      }
      if (typeof r.layerId === 'string') {
        const n = node(r.layerId);
        const t = n.components.find((c) => 'assetId' in (c.props as Record<string, unknown>));
        const assetId = t?.props.assetId;
        if (typeof assetId !== 'string') {
          return fail(`Layer "${n.name}" is not showing an image from the asset library.`);
        }
        return readAssetPixels(manifest.id, requireAsset(assetId));
      }
      return fail('getImage expects { layerId } or { assetId }.');
    },

    'assets.createImage': async (opts) => {
      const o = (opts ?? {}) as Record<string, unknown>;
      // NOT wrapped in `edit`: adding to the asset library is not a document
      // mutation, and `addAsset` is async — an async body inside `runDocumentEdit`
      // would close the undo entry before the work finished and produce an
      // empty one. The undoable step is `scene.createLayer`, which is where the
      // picture actually enters the composition.
      return createImageAsset(manifest.id, {
        width: o.width,
        height: o.height,
        bytes: o.bytes,
        mime: o.mime,
        name: o.name,
      });
    },

    // ── Network ──────────────────────────────────────────────────────────
    /**
     * The one verb that SENDS.
     *
     * The declared host list is read from THIS plugin's own manifest, never
     * from anything the call passes — so a plugin cannot name a destination it
     * did not disclose and the user did not approve. That is the whole reason
     * the list lives on the manifest rather than being an argument.
     *
     * Every other guard — https, private addresses, redirect re-checking, size,
     * timeout, rate — is inside `pluginNetFetch`, so there is one place to read
     * them and one place they can be wrong.
     */
    'net.fetch': async (url, init) =>
      pluginNetFetch(
        manifest.id,
        manifest.contributes.net,
        str(url, 'url'),
        (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string },
        // The transport, not the policy. On the desktop build the request is
        // made by the MAIN process: the app shell's `connect-src` names our
        // backend and our media origins, never a plugin's hosts, so a
        // renderer-side request would be refused before it left — and widening
        // the policy would widen the whole renderer rather than this plugin.
        // Falls back to the renderer's own `fetch` in a browser build, where
        // there is no other process to ask.
        mainProcessFetch(),
      ),

    // ── Timeline ─────────────────────────────────────────────────────────
    'timeline.getTime': () => getTimelineController().currentSeconds,
    'timeline.setTime': (seconds) => {
      getTimelineController().seekSeconds(Math.max(0, finite(seconds, 'time')));
      return true;
    },
  };
}
