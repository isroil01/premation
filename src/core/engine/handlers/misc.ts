/** Project settings, project import, jobs, plugin data (ENGINE_API.md §4.1, §4.9). */

import { defaultAnimation } from '@motion/animation';
import type { ProjectSettings } from '@motion/engine-api';
import { useColorManagementStore } from '@stores/colorManagementStore';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useAssetStore, replaceProjectItems } from '@stores/assetStore';
import { getProjectSettings, setProjectSettingsState } from '@core/project/documentExtras';
import { useGuidesStore, type GuidesSettings } from '@stores/guidesStore';
import { canonicalHex, useSwatchStore } from '@stores/swatchStore';
import { useMaterialStore } from '@stores/materialStore';
import { migrateDocument } from '@core/project/migrations';
import { getTimelineController } from '@core/timeline/TimelineController';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { SceneNode } from '@core/types';
import { fail } from '../errors';
import { graph, requireLayer } from '../doc';
import { K, documentScope, newScope, scopeLayer } from '../state';
import type { HandlerTable } from '../handler';
import { remintKeyIds } from './common';
import { loadDocumentIntoStores } from '../documentLoad';

export const miscHandlers: HandlerTable = {
  /**
   * B3z: a saved / cloud version restored as ONE undoable entry. The version is
   * parsed and migrated before anything changes (a newer format refuses whole);
   * the load is openProject's (documentLoad.ts) inside document scope, so undo
   * writes every part back exactly. Plugin storage follows the version but is
   * not a part (not in the entry). Guides, swatches and materials are.
   */
  restoreDocument: (cmd) => {
    let doc: EditorDocument;
    try {
      doc = JSON.parse(new TextDecoder().decode(cmd.document)) as EditorDocument;
    } catch {
      return fail('decode', 'the document is not a .motion project (malformed JSON)');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('decode', 'the document is not a .motion project');
    try {
      doc = migrateDocument(doc);
    } catch (err) {
      fail('unsupported', `this engine cannot read that document: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      scope: documentScope(),
      label: cmd.label || 'Restore Version',
      apply: () => {
        loadDocumentIntoStores(doc);
        return {};
      },
    };
  },

  setGuides: (cmd) => {
    let patch: unknown;
    try {
      patch = JSON.parse(cmd.patch);
    } catch {
      return fail('decode', 'the guides patch is not JSON');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('invalidArgument', 'the guides patch must be a JSON object');
    const s = newScope();
    s.keys.add(K.guides);
    return {
      scope: s,
      label: 'Guides',
      apply: () => {
        useGuidesStore.getState().restore(patch as Partial<GuidesSettings>);
        return {};
      },
    };
  },

  setSwatches: (cmd) => {
    cmd.swatches.forEach((sw, i) => {
      if (!canonicalHex(sw.hex)) fail('invalidArgument', `swatch ${i} is not a hex colour`);
    });
    const s = newScope();
    s.keys.add(K.swatches);
    return {
      scope: s,
      label: 'Swatches',
      apply: () => {
        useSwatchStore.getState().restore(cmd.swatches);
        return {};
      },
    };
  },

  setMaterials: (cmd) => {
    const raw = cmd.materials.map((m, i) => {
      let params: unknown;
      try {
        params = JSON.parse(m.params);
      } catch {
        fail('invalidArgument', `material ${i} params are not a JSON object`);
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) fail('invalidArgument', `material ${i} params are not a JSON object`);
      return { id: m.id, name: m.name, params, ...(m.swatch ? { swatch: m.swatch } : {}) };
    });
    const s = newScope();
    s.keys.add(K.materials);
    return {
      scope: s,
      label: 'Materials',
      apply: () => {
        useMaterialStore.getState().restore(raw);
        return {};
      },
    };
  },

  setProjectSettings: (cmd) => {
    const p = cmd.patch;
    if (p.framesStartAt !== undefined && p.framesStartAt > 1) fail('outOfRange', 'frames start at 0 or 1');
    if (p.audioSampleRate !== undefined && !(p.audioSampleRate >= 8000 && p.audioSampleRate <= 192000)) fail('outOfRange', 'sample rate must be 8000…192000');
    const s = newScope();
    s.keys.add(K.project);
    s.keys.add(K.cm);
    return {
      scope: s,
      label: 'Project Settings',
      apply: () => {
        const next: ProjectSettings = { ...getProjectSettings() };
        for (const [k, v] of Object.entries(p)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
        setProjectSettingsState(next);
        // Mirror what today's renderer can honour into colour management.
        const cm = useColorManagementStore.getState();
        if (p.workingSpace === 'srgbLinear') cm.setWorkingSpace('srgb-linear');
        if (p.workingSpace === 'acescg') cm.setWorkingSpace('aces-cg');
        if (p.bitDepth === 'f32') cm.setBitDepth(32);
        if (p.bitDepth === 'u16' || p.bitDepth === 'u8') cm.setBitDepth(16);
        return {};
      },
    };
  },

  importProject: (cmd, ctx) => {
    const port = ctx.ports.readProject;
    if (!port) fail('unsupported', 'no project file port is attached to this engine');
    if (!/\.motion$/i.test(cmd.path)) fail('unsupported', 'importing .aep/.aepx into an open project goes through the editor\'s importer until it moves into the engine');
    if (cmd.folder && !useAssetStore.getState().folders.some((f) => f.id === cmd.folder)) fail('notFound', `no folder '${cmd.folder}'`, { item: cmd.folder });
    let doc: EditorDocument | null = null;
    const folderId = ctx.mintId('folder_');
    return {
      scope: documentScope(),
      label: 'Import Project',
      prepare: async () => {
        try {
          doc = migrateDocument(await port(cmd.path));
        } catch (err) {
          fail('io', `could not read '${cmd.path}': ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      apply: () => {
        const d = doc!;
        const idMap = new Map<string, string>();
        const nodes = d.scene?.nodes ?? [];
        for (const n of nodes) idMap.set(n.id, ctx.mintId(n.parent ? 'layer_' : 'comp_'));
        const created: string[] = [];
        const snap = useAssetStore.getState();
        replaceProjectItems({
          assets: structuredClone(snap.assets),
          folders: [...structuredClone(snap.folders), { id: folderId, name: cmd.path.replace(/^.*[\\/]/, '').replace(/\.motion$/i, ''), parentId: cmd.folder ?? null }],
        });
        created.push(folderId);
        const comps = { ...useProjectStore.getState().comps };
        for (const n of nodes) {
          const id = idMap.get(n.id)!;
          const row: SceneNode = {
            ...structuredClone(n),
            id,
            parent: n.parent ? idMap.get(n.parent) ?? null : null,
            children: n.children.map((c) => idMap.get(c) ?? c),
            components: n.components.map((c) => {
              const props = structuredClone(c.props) as Record<string, unknown>;
              if (typeof props[COMP_REF_PROP] === 'string') props[COMP_REF_PROP] = idMap.get(props[COMP_REF_PROP] as string) ?? props[COMP_REF_PROP];
              return { ...c, id: `${id}_${c.type}`, props };
            }),
          };
          graph.addNode(row);
          if (!n.parent) {
            const src = d.comps?.[n.id];
            comps[id] = { ...(src ?? { width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0, name: n.name ?? 'Composition' }), id, name: src?.name ?? n.name ?? 'Composition', folderId } as unknown as CompositionSettings;
            created.push(id);
          }
        }
        useProjectStore.getState().actions.replaceComps(comps);
        for (const [oldId, newId] of idMap) {
          const tracks = d.animation?.tracks?.[oldId];
          const exprs = d.animation?.expressions?.[oldId];
          const data = d.animation?.data?.[oldId];
          if (!tracks && !exprs && !data) continue;
          defaultAnimation.restoreNode(newId, {
            tracks: Object.fromEntries(Object.entries(tracks ?? {}).map(([p, t]) => [p, structuredClone(t.keyframes)])),
            expressions: structuredClone(exprs ?? {}),
            data: Object.fromEntries(Object.entries(data ?? {}).map(([p, t]) => [p, { ...structuredClone(t), nodeId: newId }])),
          });
          remintKeyIds(newId, ctx);
        }
        for (const id of created) if (useProjectStore.getState().comps[id]) getTimelineController().timelineForComp(id);
        return { items: created };
      },
    };
  },

  applyJobResult: (cmd) => fail('notFound', `no finished job '${cmd.job}' (jobs run in the editor until phase E/F)`),

  setPluginData: (cmd) => {
    requireLayer(cmd.layer);
    if (cmd.key === '') fail('invalidArgument', 'a plugin data key is required');
    if (cmd.data.length > 256 * 1024) fail('outOfRange', 'plugin data is limited to 256 KB per key');
    return {
      scope: scopeLayer(newScope(), cmd.layer),
      label: 'Plugin Data',
      apply: () => {
        const node = graph.getNode(cmd.layer)!;
        const fx = node.components.find((c) => c.type === 'fx');
        const cur = structuredClone(((fx?.props as Record<string, unknown> | undefined)?.pluginData ?? {}) as Record<string, Record<string, string>>);
        const group = { ...(cur[cmd.group] ?? {}) };
        if (cmd.data.length === 0) delete group[cmd.key];
        else group[cmd.key] = toBase64(cmd.data);
        if (Object.keys(group).length > 0) cur[cmd.group] = group;
        else delete cur[cmd.group];
        graph.setFxKey(cmd.layer, 'pluginData', Object.keys(cur).length > 0 ? cur : undefined);
        return {};
      },
    };
  },
};

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
