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
import { useProjectStore } from '@stores/projectStore';
import { audioComponent } from '@core/audio/audioScene';
import { amplitudeAt, type WaveformPeaks } from '@core/audio/waveform';
import { audioEngine } from '@core/audio/AudioEngine';
import { createComposition, renameComposition, deleteComposition } from '@core/composition/compositionOps';
import { useUIStore } from '@stores/uiStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { readNodeKind } from '@core/scene/sceneDerive';
import { bumpScene, batchScene } from '@stores/sceneStore';
import { insertImageNode } from '@core/scene/sceneInsert';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { checkOwnership } from './layerKindRegistry';
import { buildCustomLayerNode, isReservedPropPath, readCustomLayer } from './customLayers';
import { planStructuredWrite, STRUCTURED_PROP_NAMES } from './structuredProps';
import { regenerateProxyChildren } from './proxySubtree';
import { onLayerChanged } from './layerChangeNotifier';
import type { PluginManifest, PluginPermission } from './manifest';
import type { PluginCommandSpec } from './protocol';
import { createImageAsset, readAssetPixels, requireAsset } from './assets';
import { reparentNode } from '@core/scene/parenting';
import {
  addEffect, removeEffect, updateEffectParam, getNodeEffects, effectDefFor,
} from '@core/effects/effects';
import { pluginEffectsCanRender } from '@core/effects/pluginEffectDefs';
import { noteInertPluginEffect } from './pluginEffects';
import {
  assertScope, storageDelete, storageGet, storageList, storageSet,
} from './pluginStorage';
import { BatchError, validateBatch, type BatchOp, type OpRef } from './sceneBatch';
import { pluginNetFetch } from './pluginNetFetch';
import { mainProcessFetch } from './pluginNetBridge';

/** What a plugin may create. Deliberately the primitives plus `image`, not
 *  every internal node kind — a plugin has no business minting a camera or a
 *  comp root. `image` is here because the asset API would otherwise be able to
 *  make a picture and have nowhere to put it. */
const CREATABLE: SceneKind[] = ['shape', 'text', 'group', 'null', 'image'];

const MAX_STRING = 500;
const MAX_KEYFRAMES_PER_CALL = 5000;

/**
 * Tell the app the scene changed.
 *
 * A thin alias for `bumpScene`, and the reason it exists is `scene.apply`:
 * every mutating handler goes through this name so a reader looking for "what
 * announces a change" finds one place. The coalescing itself is NOT here — see
 * `batchScene` in `sceneStore`, which the batch wraps around the whole run.
 *
 * A counter of my own was the first attempt and was wrong. `bumpScene` is not
 * the only thing that announces: `insertPrimitive` and the scene graph bump
 * independently, so suppressing calls made from this file alone left 82
 * notifications for a 40-op batch. `batchScene` holds the notification at the
 * store, which is the only place that sees all of them.
 */
function notifyScene(): void {
  bumpScene();
}

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

/**
 * The decoded waveform behind an audio layer, or null.
 *
 * Null rather than an error for every "not available" case, because they are
 * not the plugin's mistake and they are not distinguishable to it either: the
 * layer may be a shape (no audio), or audio whose file has not finished
 * decoding yet. A plugin polling until it gets peaks is the correct shape for
 * both, and an exception would make the ordinary case look like a failure.
 */
const waveformFor = (layerId: string): WaveformPeaks | null => {
  const n = defaultSceneGraph.getNode(layerId);
  if (!n) return null;
  const comp = audioComponent(n);
  const assetId = comp && typeof comp.props.__assetId === 'string' ? comp.props.__assetId : '';
  if (!assetId) return null;
  return audioEngine.getWaveform(assetId) ?? null;
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
    /**
     * What the user granted, expanded through `PERMISSION_IMPLIES`.
     *
     * Needed only by `scene.apply`, which is the one method whose required
     * permission depends on its arguments. Every other method is gated by
     * `PluginHost` before it reaches this file, which is why this is a hook
     * rather than a captured value: the gate stays in one place and this is an
     * addition to it, not a second copy.
     */
    granted: () => ReadonlySet<PluginPermission>;
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

  const table: Record<string, (...args: unknown[]) => unknown> = {
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
    /*
      The project's other compositions.

      `composition.get` answers "what am I drawing into"; this answers "what
      else is here", which is what a plugin that builds a sequence, or copies a
      title into every scene, actually needs. Reading it is `scene:read` — comp
      names are project data of exactly the same kind as layer names, and the
      permission that covers one should cover the other.

      `active` is included rather than left to be inferred by comparing against
      `composition.get().name`, because names are not unique.
    */
    /*
      ── Audio analysis ────────────────────────────────────────────────────

      The decoded waveform, so a plugin can drive animation from sound — the
      "convert audio to keyframes" shape, which is one of the oldest reasons
      anybody writes a motion-graphics plugin at all.

      READ ONLY, and deliberately narrow: peaks and an amplitude, never the
      samples. A plugin that could read PCM could reconstruct the audio, and
      combined with `net:fetch` that is exfiltration of the user's media rather
      than analysis of it. Peaks are a lossy envelope — enough to animate from,
      not enough to rebuild a recording.

      Level, pan and fades are NOT here: they are ordinary animatable
      properties, already reachable through `animation.*`. Adding a second way
      to read them would be a parallel path that can disagree with the first.
    */
    'audio.getPeaks': (id) => {
      const wave = waveformFor(str(id, 'layer id'));
      if (!wave) return null;
      // A plain array, not the Float32Array: the structured clone would carry
      // the buffer across intact, but a plugin author reaching for `.map` on
      // what looks like an array should get an array.
      return { buckets: wave.buckets, duration: wave.duration, peaks: Array.from(wave.peaks) };
    },
    'audio.getAmplitude': (id, seconds) => {
      const wave = waveformFor(str(id, 'layer id'));
      if (!wave) return null;
      const t = seconds;
      if (typeof t !== 'number' || !Number.isFinite(t)) return fail('Time must be a finite number of seconds.');
      return amplitudeAt(wave, t);
    },
    'composition.list': () => {
      const p = useProjectStore.getState();
      return Object.values(p.comps).map((c) => ({
        id: c.id,
        name: c.name,
        width: c.width,
        height: c.height,
        fps: c.fps,
        durationSeconds: c.durationSeconds,
        active: p.activeTabId ? p.tabs[p.activeTabId]?.compositionId === c.id : false,
      }));
    },
    'composition.create': (settings) => {
      const o = (settings ?? {}) as Record<string, unknown>;
      const init: Record<string, unknown> = {};
      if (o.name !== undefined) init.name = str(o.name, 'composition name').trim().slice(0, 120);
      // Bounded because these become a render target. A comp 900 000 px wide is
      // not a composition, it is an allocation failure with a plugin's name on
      // it — and the numbers crossed `postMessage`, so "the dialog would never
      // send that" is not an argument that applies here.
      for (const [key, lo, hi] of [['width', 1, 16384], ['height', 1, 16384], ['fps', 1, 240], ['durationSeconds', 0.1, 36000]] as const) {
        if (o[key] === undefined) continue;
        const v = o[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
          return fail(`"${key}" must be a number between ${lo} and ${hi}.`);
        }
        init[key] = v;
      }
      return edit('create composition', () => createComposition(init));
    },
    'composition.open': (id) => {
      const cid = str(id, 'composition id');
      const p = useProjectStore.getState();
      if (!p.comps[cid]) return fail(`No composition "${cid}".`);
      // An already-open comp has a tab; a closed one needs one. `openTab` is
      // idempotent on the id, so this is the single call for both.
      p.actions.openTab(cid, [cid], p.comps[cid]!.name);
      return true;
    },
    'composition.rename': (id, name) => {
      const cid = str(id, 'composition id');
      if (!useProjectStore.getState().comps[cid]) return fail(`No composition "${cid}".`);
      const next = str(name, 'composition name').trim().slice(0, 120);
      if (!next) return fail('A composition name cannot be empty.');
      return edit('rename composition', () => { renameComposition(cid, next); return true; });
    },
    'composition.delete': (id) => {
      const cid = str(id, 'composition id');
      if (!useProjectStore.getState().comps[cid]) return fail(`No composition "${cid}".`);
      /*
        Deleting the LAST composition does not fail — it mints a fresh pristine
        one to replace it, because a project with no composition has nowhere to
        draw. So a plugin can empty a project this way, and `true` is the honest
        answer: the comp it named is gone.

        That is why this is not `scene:write`. The consent line for
        `composition:write` says deleting one removes every layer it contains,
        which is exactly the power being granted.
      */
      return edit('delete composition', () => deleteComposition(cid));
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
          notifyScene();
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
          notifyScene();
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
        notifyScene();
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
      /*
        Structured values — a path, a gradient, a stroke.

        Routed by the VALUE's shape rather than by the prop name, so a scalar
        written to a structured prop still takes the ordinary path and fails the
        way it always did. `planStructuredWrite` validates completely before it
        returns the applier, so a refusal here has changed nothing.
      */
      if (value !== null && typeof value === 'object') {
        const plan = planStructuredWrite(p, value, n.id);
        if (!plan.ok) return fail(plan.message);
        return edit(`set ${p}`, () => {
          plan.apply();
          notifyScene();
          return true;
        });
      }
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
        return fail(
          'Property values must be a number, string or boolean — or a structured value for: '
          + `${STRUCTURED_PROP_NAMES.join(', ')}.`,
        );
      }
      const target = n.components.find((c) => p in (c.props as Record<string, unknown>))
        ?? n.components.find((c) => c.type === 'Transform');
      if (!target) return fail(`Layer "${n.name}" has no component that can hold "${p}".`);
      return edit(`set ${p}`, () => {
        const ok = defaultSceneGraph.writeProp(n.id, target.id, p, value);
        notifyScene();
        return ok;
      });
    },

    'scene.renameLayer': (id, name) => {
      const n = node(id);
      const nm = str(name, 'layer name').slice(0, 80);
      return edit('rename layer', () => { n.name = nm; notifyScene(); return true; });
    },

    'scene.deleteLayer': (id) => {
      const n = node(id);
      // A comp root is not a layer; deleting one would take the composition
      // with it, and no plugin asked for that.
      if (n.parent === null) return fail('That is a composition root, not a layer.');
      return edit(`delete ${n.name}`, () => { defaultSceneGraph.removeNode(n.id); notifyScene(); return true; });
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
        notifyScene();
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
        notifyScene();
        return true;
      });
    },

    /** Lock or unlock a layer. A locked layer refuses edits from the canvas. */
    'scene.setLocked': (id, locked) => {
      const n = node(id);
      if (typeof locked !== 'boolean') return fail('locked must be true or false.');
      return edit(`${locked ? 'lock' : 'unlock'} ${n.name}`, () => {
        n.locked = locked;
        notifyScene();
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
        notifyScene();

        /*
          Succeeds on the WebGL2 tier, and says it will not draw.

          Not a failure, deliberately. The effect IS in the document, it is
          saved with it, and it renders the moment that file is opened on a
          WebGPU machine — refusing here would make a plugin that works
          everywhere look broken on this laptop and, worse, would tempt an
          author to strip the effect out of the document to "fix" it.

          A bare id, though, leaves the plugin unable to tell its own user
          anything, which is the defect: the effect appears in the stack, shows
          its parameters, and does nothing. The flag is how a plugin says so in
          its own words. The host says it too, once per session.
        */
        const inactive = t.includes('.') && !pluginEffectsCanRender();
        if (inactive) noteInertPluginEffect(manifest.name);
        return inactive
          ? { id: added.id, active: false, reason: 'webgpu-unavailable' }
          : added.id;
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
        notifyScene();
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
        notifyScene();
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

    // ── Storage ──────────────────────────────────────────────────────────
    //
    // Namespaced by `manifest.id` HERE, not by the caller. The scope and key
    // cross a `postMessage` from third-party code; the identity does not, and
    // the isolation between plugins rests entirely on that asymmetry — a plugin
    // that could name the bag could read the one beside it.
    //
    // Synchronous. `storage.get` returning a promise would make every plugin
    // that reads a preference during `activate()` pay a round trip against the
    // 8 s boot deadline, for a value already in memory. See `pluginStorage.ts`.
    'storage.get': (scope, key) => storageGet(assertScope(scope), manifest.id, key),

    'storage.set': (scope, key, value) => {
      const s = assertScope(scope);
      storageSet(s, manifest.id, key, value);
      /*
        A project write marks the document dirty, and is NOT undoable.

        Deliberately outside `edit()`, which every other mutating verb here goes
        through. Undo is a promise about the user's work, and a plugin
        remembering a panel's scroll position must not make Ctrl+Z do nothing
        visible. A plugin that wants undoable state has layer props, which are
        exactly that.
      */
      if (s === 'project') notifyScene();
      return true;
    },

    'storage.delete': (scope, key) => {
      const s = assertScope(scope);
      storageDelete(s, manifest.id, key);
      if (s === 'project') notifyScene();
      return true;
    },

    'storage.list': (scope, prefix) => storageList(assertScope(scope), manifest.id, prefix),

    // ── Batch ────────────────────────────────────────────────────────────
    /**
     * Many mutations, one round trip, one undo entry, one notification.
     *
     * Every op is dispatched through the SAME handler above that a single call
     * would reach. Re-implementing them here would be a second definition of
     * what `createLayer` means, free to drift from the first and certain to
     * eventually — and the drift would be invisible, because a plugin using the
     * batch and a plugin using the single call would each behave correctly
     * against their own path.
     *
     * What differs is only bookkeeping: `notifyScene` is suppressed for the
     * duration and fired once at the end, and `runDocumentEdit` nests, which it
     * already handles by suspending inner history pushes.
     */
    'scene.apply': (rawOps) => {
      const { ops, permissions } = validateBatch(rawOps);

      /*
        Permissions checked per op, against the UNION, before anything runs.

        `scene.apply` needs none of its own in `METHOD_PERMISSIONS`, and
        claiming one would either over-charge a batch of pure animation ops or
        under-charge one that deletes layers. The gate belongs here, where the
        ops are known.
      */
      const held = hooks.granted();
      for (const p of permissions) {
        if (!held.has(p)) {
          return fail(
            `This batch needs "${p}", which was not granted to this plugin. `
            + `It requires: ${[...permissions].join(', ')}.`,
          );
        }
      }

      /*
        `batchScene` holds every scene notification until the whole run is
        done, then fires one.

        At the STORE, not here. Suppressing only the `notifyScene` calls this
        file makes was the first attempt and left 82 notifications for a 40-op
        batch: `insertPrimitive` and the scene graph announce independently, and
        the store is the only place that sees all of them. The graph is still
        mutated immediately, so an op reading the scene mid-batch sees the
        truth — only the announcement waits.
      */
      const value = batchScene(() => edit(`apply ${ops.length} operation${ops.length === 1 ? '' : 's'}`, () => {
        {
          /** Op index → the layer id it created. Only creating ops appear. */
          const created = new Map<number, string>();
          const resolve = (target: string | OpRef): string =>
            typeof target === 'string'
              ? target
              // Validation already proved this ref points at an earlier
              // `createLayer`. A miss means that op produced no id, which
              // cannot happen without it having thrown — and a throw aborts.
              : created.get(target.ref) ?? fail(`op ${target.ref} produced no layer.`);

          /*
            Where an unparented `createLayer` goes.

            Wherever the FIRST created layer landed — learned, not chosen.

            `insertPrimitive` puts a layer under whatever is selected and then
            selects it, so inside a batch every create nests inside its
            predecessor: "create a thousand layers" built a thousand-deep chain.
            Nothing errored; the result was simply not what anyone would read
            the batch as meaning.

            Two anchors were tried and are worse. The selection's parent still
            moves underneath the loop. The first scene ROOT is wrong in a
            multi-composition project — it can name a composition the batch has
            nothing to do with, and reparenting across compositions is refused,
            so the batch fails with a message about ancestry that has no
            relation to what the plugin asked for.

            Letting op 0 land naturally and following it means a one-op batch is
            identical to the single call it replaces, and every later op joins
            it as a sibling rather than a descendant.
          */
          let defaultParent: string | null = null;

          const results: unknown[] = [];
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i]!;
            try {
              const result = runOp(table, op, resolve, defaultParent);
              if (op.op === 'createLayer' && typeof result === 'string') {
                created.set(i, result);
                // The anchor, learned from op 0 and then fixed. `?? null` keeps
                // a root-level layer's `undefined` parent from re-arming this.
                defaultParent ??= defaultSceneGraph.getNode(result)?.parent ?? null;
              }
              results.push(result ?? null);
            } catch (err) {
              /*
                Re-thrown with the index attached, and deliberately not caught.

                `runDocumentEdit` snapshots before and after; an exception
                escaping it restores the document, so nothing is applied. That
                is the guarantee — a batch failing at op 4,999 leaves the
                document byte-identical — and it is why the failure has to keep
                travelling upward rather than becoming a partial result the
                plugin has no way to interpret.
              */
              throw new BatchError(i, err instanceof Error ? err.message : String(err));
            }
          }
          return results;
        }
      }));

      return value;
    },
  };

  return table;
}

/**
 * Dispatch one batch op to the single-call handler that already implements it.
 *
 * A `switch` rather than a map from op name to method name, because the
 * ARGUMENT ORDER differs per op — a table would need a shaping function beside
 * every entry, at which point it is a switch with extra indirection.
 */
function runOp(
  table: Record<string, (...args: unknown[]) => unknown>,
  op: BatchOp,
  resolve: (t: string | OpRef) => string,
  /** Where a `createLayer` with no `parent` belongs. See below. */
  defaultParent: string | null,
): unknown {
  switch (op.op) {
    case 'createLayer': {
      const id = table['scene.createLayer']!({
        ...(op.kind !== undefined ? { kind: op.kind } : {}),
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.props !== undefined ? { props: op.props } : {}),
      });

      /*
        Parented EXPLICITLY, every time, and this is not a convenience.

        `insertPrimitive` puts a new layer under whatever is SELECTED, and it
        then selects what it made. In a batch that compounds: op 1 creates a
        layer and selects it, op 2 creates a layer INSIDE op 1's, op 3 inside
        op 2's — so "create a thousand layers" built a thousand-deep chain
        rather than a thousand siblings. Nothing errored; the result was simply
        not what anyone would read the batch as meaning.

        A programmatic bulk API must not depend on what the user happened to
        have selected when they invoked the plugin, so the batch decides: the
        `parent` the op named, or — for an op that named none — wherever the
        FIRST layer of this batch landed, captured before any of them ran.
      */
      if (typeof id === 'string') {
        const target = op.parent !== undefined && op.parent !== null
          ? resolve(op.parent)
          : defaultParent;
        /*
          `reparentNode` directly, not through `scene.setParent`.

          That handler re-validates the parent id with `node()`, and the
          composition root is not a layer it can find — a batch anchored there
          failed with "No layer with id comp_root", which is true and useless.
          `reparentNode` already understands the root.

          Skipped when the layer is already in the right place, so op 0 (which
          sets the anchor) and any op that landed correctly cost nothing.
        */
        const current = defaultSceneGraph.getNode(id)?.parent ?? null;
        if (target !== null && target !== current) reparentNode(id, target);
      }
      return id;
    }
    case 'setProperty':
      return table['scene.setProperty']!(resolve(op.layer), op.path, op.value);
    case 'setParent':
      return table['scene.setParent']!(resolve(op.layer), op.parent === null ? null : resolve(op.parent));
    case 'rename':
      return table['scene.renameLayer']!(resolve(op.layer), op.name);
    case 'delete':
      return table['scene.deleteLayer']!(resolve(op.layer));
    case 'setVisible':
      return table['scene.setVisible']!(resolve(op.layer), op.visible);
    case 'setLocked':
      return table['scene.setLocked']!(resolve(op.layer), op.locked);
    case 'effects.add':
      return table['effects.add']!(resolve(op.layer), op.type);
    case 'effects.remove':
      return table['effects.remove']!(resolve(op.layer), op.effect);
    case 'effects.setParam':
      return table['effects.setParam']!(resolve(op.layer), op.effect, op.key, op.value);
    case 'animation.setKeyframes':
      return table['animation.setKeyframes']!(resolve(op.layer), op.path, op.keyframes);
    case 'animation.setExpression':
      return table['animation.setExpression']!(resolve(op.layer), op.path, op.expression);
    default: {
      const exhaustive: never = op;
      throw new Error(`unhandled batch operation ${JSON.stringify(exhaustive)}`);
    }
  }
}
