/**
 * Project items (footage, folders) and the render queue (ENGINE_API.md §4.2).
 *
 * Items are DOCUMENT state now (ENGINE_API.md §2.5 #12): the engine edits the
 * asset store's records and folders, the `items` part is the inverse, and
 * `captureDocument` saves them (`projectItems`). Removing an item takes it out
 * of the project — it never deletes the file or the library copy, so undo can
 * put it back.
 */

import type { InterpretationPatch, RenderItemInfo, RenderSettings, RenderSettingsPatch } from '@motion/engine-api';
import { useAssetStore, replaceProjectItems, type ImportedAsset, type AssetFolder } from '@stores/assetStore';
import { useProjectStore } from '@stores/projectStore';
import { getRenderQueue, setRenderQueueState } from '@core/project/documentExtras';
import type { FootageInterpretation } from '@core/source/sourceInfo';
import { deleteLayerNode } from '@core/scene/deleteLayerNode';
import { defaultAnimation } from '@motion/animation';
import { fail } from '../errors';
import { graph, requireItem, isCompItem, layersUsingItem, compItemIds, layerIdsOfComp } from '../doc';
import { K, documentScope, newScope, type Scope } from '../state';
import { rationalToFps, framesToFlicks } from '../time';
import { labelColorOf, labelIdOf, compSettings } from '../model';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { HandlerTable } from '../handler';
import { plural } from './common';

function itemsScope(extraComps: string[] = []): Scope {
  const s = newScope();
  s.keys.add(K.items);
  for (const c of extraComps) s.keys.add(K.comp(c));
  return s;
}

function assetsSnapshot(): { assets: ImportedAsset[]; folders: AssetFolder[] } {
  const s = useAssetStore.getState();
  return { assets: structuredClone(s.assets), folders: structuredClone(s.folders) };
}

function patchAsset(id: string, fn: (a: ImportedAsset) => ImportedAsset): void {
  const snap = assetsSnapshot();
  replaceProjectItems({ assets: snap.assets.map((a) => (a.id === id ? fn(a) : a)), folders: snap.folders });
}

function patchComp(id: string, fields: Record<string, unknown>): void {
  const comps = { ...useProjectStore.getState().comps };
  const next = { ...comps[id]!, ...fields } as Record<string, unknown>;
  for (const [k, v] of Object.entries(fields)) if (v === undefined) delete next[k];
  comps[id] = next as never;
  useProjectStore.getState().actions.replaceComps(comps);
}

function interpretationPatch(p: InterpretationPatch): Partial<FootageInterpretation> & { __clear?: string[] } {
  const out: Partial<FootageInterpretation> & { __clear?: string[] } = {};
  const clear: string[] = [];
  if (p.alpha !== undefined) {
    if (p.alpha === 'ignore') fail('unsupported', 'Interpret ▸ Ignore alpha is not implemented by the TypeScript renderer');
    if (p.alpha === 'auto') clear.push('alpha');
    else out.alpha = p.alpha;
  }
  if (p.conformFrameRate !== undefined) out.conformFps = rationalToFps(p.conformFrameRate);
  if (p.clearConform) clear.push('conformFps');
  if (p.pixelAspect !== undefined) {
    if (!(p.pixelAspect > 0)) fail('outOfRange', 'pixel aspect must be positive');
    out.par = p.pixelAspect;
  }
  if (p.fieldOrder !== undefined) {
    if (p.fieldOrder === 'progressive') clear.push('fields');
    else out.fields = p.fieldOrder === 'upperFirst' ? 'upper' : 'lower';
  }
  if (p.loops !== undefined) out.loopCount = p.loops;
  // B3z: Remove Pulldown (sourceInfo.ts pulldownPhase, 0..4).
  if (p.removePulldown !== undefined) {
    if (p.clearRemovePulldown) fail('invalidArgument', 'send removePulldown or clearRemovePulldown, not both');
    if (!Number.isInteger(p.removePulldown) || p.removePulldown > 4) fail('outOfRange', 'the pulldown phase is 0..4');
    out.pulldownPhase = p.removePulldown;
  }
  if (p.clearRemovePulldown) clear.push('pulldownPhase');
  if (p.invertAlpha) fail('unsupported', 'Invert Alpha is not implemented by the TypeScript renderer');
  if (p.premultipliedMatte !== undefined || p.startTimecode !== undefined || (p.colorProfile !== undefined && p.colorProfile !== 'auto')) {
    fail('unsupported', 'premultiplied matte colour, start timecode and colour profiles are not stored by the TypeScript engine');
  }
  if (clear.length > 0) out.__clear = clear;
  return out;
}

const DEFAULT_RENDER: RenderSettings = {
  format: 'mp4-h264', outputPath: '', range: { start: 0, duration: 0 }, bitDepth: 'u8',
  includeAudio: true, includeAlpha: false, quality: 80, outputColorSpace: '', motionBlur: true, frameBlending: true,
};

function applyRenderPatch(s: RenderSettings, p: RenderSettingsPatch): RenderSettings {
  const out: RenderSettings = { ...s };
  for (const [k, v] of Object.entries(p)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

export const itemHandlers: HandlerTable = {
  importFiles: (cmd, ctx) => {
    if (cmd.files.length === 0) fail('invalidArgument', 'no files given');
    const port = ctx.ports.importFile;
    if (!port) fail('unsupported', 'no media import port is attached to this engine');
    for (const f of cmd.files) {
      if (f.folder && !useAssetStore.getState().folders.some((x) => x.id === f.folder)) fail('notFound', `no folder '${f.folder}'`, { item: f.folder });
      if (f.createComposition) fail('unsupported', 'import then createComposition{fromItems} (one batch) — the TS engine does not fold the two');
      if (f.interpretation) interpretationPatch(f.interpretation);
    }
    const ids = cmd.files.map(() => ctx.mintId('item_'));
    const records: ImportedAsset[] = [];
    return {
      scope: itemsScope(),
      label: `Import ${plural(cmd.files.length, 'File')}`,
      prepare: async () => {
        for (let i = 0; i < cmd.files.length; i++) {
          try {
            records.push(await port(cmd.files[i]!, ids[i]!));
          } catch (err) {
            fail('io', `could not import '${cmd.files[i]!.path}': ${err instanceof Error ? err.message : String(err)}`, { commandIndex: undefined });
          }
        }
      },
      apply: () => {
        const snap = assetsSnapshot();
        const added = records.map((r, i) => {
          const f = cmd.files[i]!;
          let a: ImportedAsset = { ...r, id: ids[i]!, ...(f.folder ? { folderId: f.folder } : {}), path: r.path ?? f.path };
          if (f.interpretation) {
            const { __clear, ...patch } = interpretationPatch(f.interpretation);
            const interp: Record<string, unknown> = { ...(a.interpret ?? {}), ...patch };
            for (const k of __clear ?? []) delete interp[k];
            a = { ...a, interpret: interp as FootageInterpretation };
          }
          return a;
        });
        replaceProjectItems({ assets: [...snap.assets, ...added], folders: snap.folders });
        return { items: ids };
      },
    };
  },

  importBytes: (cmd, ctx) => {
    if (cmd.files.length === 0) fail('invalidArgument', 'no files given');
    const port = ctx.ports.importBytes;
    if (!port) fail('unsupported', 'no media import port is attached to this engine');
    for (const f of cmd.files) {
      if (f.data.byteLength === 0) fail('invalidArgument', `'${f.name}' has no bytes`);
      if (f.name.trim() === '') fail('invalidArgument', 'a file name is required');
      if (f.folder && !useAssetStore.getState().folders.some((x) => x.id === f.folder)) fail('notFound', `no folder '${f.folder}'`, { item: f.folder });
      if (f.interpretation) interpretationPatch(f.interpretation);
    }
    const ids = cmd.files.map(() => ctx.mintId('item_'));
    const records: ImportedAsset[] = [];
    return {
      scope: itemsScope(),
      label: `Import ${plural(cmd.files.length, 'File')}`,
      prepare: async () => {
        for (let i = 0; i < cmd.files.length; i++) {
          try {
            records.push(await port(cmd.files[i]!, ids[i]!));
          } catch (err) {
            fail('io', `could not import '${cmd.files[i]!.name}': ${err instanceof Error ? err.message : String(err)}`, { commandIndex: undefined });
          }
        }
      },
      apply: () => {
        const snap = assetsSnapshot();
        const added = records.map((r, i) => {
          const f = cmd.files[i]!;
          let a: ImportedAsset = { ...r, id: ids[i]!, ...(f.folder ? { folderId: f.folder } : {}) };
          if (f.interpretation) {
            const { __clear, ...patch } = interpretationPatch(f.interpretation);
            const interp: Record<string, unknown> = { ...(a.interpret ?? {}), ...patch };
            for (const k of __clear ?? []) delete interp[k];
            a = { ...a, interpret: interp as FootageInterpretation };
          }
          return a;
        });
        replaceProjectItems({ assets: [...snap.assets, ...added], folders: snap.folders });
        return { items: ids };
      },
    };
  },

  relinkItem: (cmd, ctx) => {
    const ref = requireItem(cmd.item);
    if (ref.kind !== 'footage') fail('invalidArgument', 'only footage can be relinked', { item: cmd.item });
    if (cmd.path.trim() === '') fail('invalidArgument', 'path is empty');
    let probed: Partial<ImportedAsset> = {};
    return {
      scope: itemsScope(),
      label: 'Relink Footage',
      prepare: async () => {
        if (ctx.ports.probeFile) probed = await ctx.ports.probeFile(cmd.path);
      },
      apply: () => {
        patchAsset(cmd.item, (a) => {
          const next: ImportedAsset = { ...a, ...probed, id: a.id, path: cmd.path };
          if (!cmd.keepInterpretation) delete next.interpret;
          return next;
        });
        return {};
      },
    };
  },

  removeItems: (cmd) => {
    if (cmd.items.length === 0) fail('invalidArgument', 'no items given');
    const refs = cmd.items.map(requireItem);
    const layers: string[] = [];
    for (const r of refs) {
      if (r.kind === 'folder') continue;
      const using = layersUsingItem(r.id);
      if (using.length > 0 && !cmd.removeUsingLayers) fail('locked', `item '${r.id}' is used by ${plural(using.length, 'layer')}`, { item: r.id });
      layers.push(...using);
    }
    return {
      scope: documentScope(),
      label: `Remove ${plural(refs.length, 'Item')}`,
      apply: () => {
        for (const l of layers) if (graph.getNode(l)) deleteLayerNode(l);
        const snap = assetsSnapshot();
        const doomedFolders = new Set(refs.filter((r) => r.kind === 'folder').map((r) => r.id));
        // A removed folder takes its sub-folders and contents with it (AE).
        let grew = true;
        while (grew) {
          grew = false;
          for (const f of snap.folders) if (f.parentId && doomedFolders.has(f.parentId) && !doomedFolders.has(f.id)) { doomedFolders.add(f.id); grew = true; }
        }
        const doomedAssets = new Set(refs.filter((r) => r.kind === 'footage').map((r) => r.id));
        for (const a of snap.assets) if (a.folderId && doomedFolders.has(a.folderId)) doomedAssets.add(a.id);
        replaceProjectItems({
          assets: snap.assets.filter((a) => !doomedAssets.has(a.id)),
          folders: snap.folders.filter((f) => !doomedFolders.has(f.id)),
        });
        for (const r of refs) {
          if (r.kind !== 'composition') continue;
          for (const id of layerIdsOfComp(r.id)) defaultAnimation.restoreNode(id, null);
          graph.removeNode(r.id);
          const comps = { ...useProjectStore.getState().comps };
          delete comps[r.id];
          useProjectStore.getState().actions.replaceComps(comps);
          getTimelineController().dropTimeline(r.id);
        }
        return {};
      },
    };
  },

  renameItem: (cmd) => {
    const ref = requireItem(cmd.item);
    if (cmd.name.trim() === '') fail('invalidArgument', 'a name cannot be empty');
    const s = ref.kind === 'composition' ? itemsScope([ref.id]) : itemsScope();
    if (ref.kind === 'composition') s.keys.add(K.node(ref.id));
    return {
      scope: s,
      label: 'Rename Item',
      apply: () => {
        if (ref.kind === 'composition') {
          patchComp(ref.id, { name: cmd.name });
          graph.getNode(ref.id)!.name = cmd.name;
        } else if (ref.kind === 'footage') {
          patchAsset(ref.id, (a) => ({ ...a, name: cmd.name }));
        } else {
          const snap = assetsSnapshot();
          replaceProjectItems({ assets: snap.assets, folders: snap.folders.map((f) => (f.id === ref.id ? { ...f, name: cmd.name } : f)) });
        }
        return {};
      },
    };
  },

  createFolder: (cmd, ctx) => {
    if (cmd.parent && !useAssetStore.getState().folders.some((f) => f.id === cmd.parent)) fail('notFound', `no folder '${cmd.parent}'`, { item: cmd.parent });
    const id = ctx.mintId('folder_');
    return {
      scope: itemsScope(),
      label: 'New Folder',
      apply: () => {
        const snap = assetsSnapshot();
        replaceProjectItems({ assets: snap.assets, folders: [...snap.folders, { id, name: cmd.name.trim() || 'Untitled Folder', parentId: cmd.parent ?? null }] });
        return { item: id };
      },
    };
  },

  moveItems: (cmd) => {
    const refs = cmd.items.map(requireItem);
    const folders = useAssetStore.getState().folders;
    if (cmd.folder !== undefined && !folders.some((f) => f.id === cmd.folder)) fail('notFound', `no folder '${cmd.folder}'`, { item: cmd.folder });
    for (const r of refs) {
      if (r.kind !== 'folder' || !cmd.folder) continue;
      // A folder cannot move into itself or its descendants.
      let cur: string | null = cmd.folder;
      while (cur) {
        if (cur === r.id) fail('cycle', `folder '${r.id}' cannot move into itself`, { item: r.id });
        cur = folders.find((f) => f.id === cur)?.parentId ?? null;
      }
    }
    return {
      scope: itemsScope(refs.filter((r) => r.kind === 'composition').map((r) => r.id)),
      label: 'Move Items',
      apply: () => {
        const snap = assetsSnapshot();
        const ids = new Set(refs.map((r) => r.id));
        replaceProjectItems({
          assets: snap.assets.map((a) => (ids.has(a.id) ? { ...a, folderId: cmd.folder ?? null } : a)),
          folders: snap.folders.map((f) => (ids.has(f.id) ? { ...f, parentId: cmd.folder ?? null } : f)),
        });
        for (const r of refs) if (r.kind === 'composition') patchComp(r.id, { folderId: cmd.folder });
        return {};
      },
    };
  },

  setInterpretation: (cmd) => {
    const refs = cmd.items.map(requireItem);
    for (const r of refs) if (r.kind !== 'footage') fail('invalidArgument', 'only footage has an interpretation', { item: r.id });
    const { __clear, ...patch } = interpretationPatch(cmd.patch);
    return {
      scope: itemsScope(),
      label: 'Interpret Footage',
      apply: () => {
        const snap = assetsSnapshot();
        const ids = new Set(cmd.items);
        replaceProjectItems({
          assets: snap.assets.map((a) => {
            if (!ids.has(a.id)) return a;
            const interp: Record<string, unknown> = { ...(a.interpret ?? {}), ...patch };
            for (const k of __clear ?? []) delete interp[k];
            return { ...a, interpret: interp as FootageInterpretation };
          }),
          folders: snap.folders,
        });
        return {};
      },
    };
  },

  setItemLabel: (cmd) => {
    const refs = cmd.items.map(requireItem);
    for (const r of refs) if (r.kind === 'folder') fail('unsupported', 'folders carry no label in this engine', { item: r.id });
    if (cmd.label > 0 && !labelColorOf(cmd.label)) fail('outOfRange', `label ${cmd.label} does not exist`);
    return {
      scope: itemsScope(refs.filter((r) => r.kind === 'composition').map((r) => r.id)),
      label: 'Item Label',
      apply: () => {
        for (const r of refs) {
          if (r.kind === 'composition') patchComp(r.id, { label: cmd.label || undefined });
          else patchAsset(r.id, (a) => {
            const next = { ...a };
            // B3z: the palette id — the Project panel's (and the bundle's) form.
            const c = labelIdOf(cmd.label);
            if (c) next.label = c;
            else delete next.label;
            return next;
          });
        }
        return {};
      },
    };
  },

  removeUnusedItems: () => {
    const unused = useAssetStore.getState().assets.filter((a) => layersUsingItem(a.id).length === 0).map((a) => a.id);
    return {
      scope: itemsScope(),
      label: 'Remove Unused Footage',
      apply: () => {
        const snap = assetsSnapshot();
        const doomed = new Set(unused);
        replaceProjectItems({ assets: snap.assets.filter((a) => !doomed.has(a.id)), folders: snap.folders });
        return { items: unused };
      },
    };
  },

  setProxy: (cmd) => {
    const ref = requireItem(cmd.item);
    if (ref.kind !== 'footage') fail('unsupported', 'composition proxies are not implemented by the TypeScript engine', { item: cmd.item });
    return {
      scope: itemsScope(),
      label: 'Set Proxy',
      apply: () => {
        patchAsset(cmd.item, (a) => {
          const next = { ...a };
          if (!cmd.path && !cmd.enabled) delete next.proxy;
          else {
            const src = cmd.path ?? a.proxy?.src;
            next.proxy = { ...(a.proxy ?? {}), status: cmd.enabled && src ? 'ready' : 'none', ...(src ? { src } : {}), userSupplied: true } as ImportedAsset['proxy'];
          }
          return next;
        });
        return {};
      },
    };
  },

  setItemComment: (cmd) => {
    const ref = requireItem(cmd.item);
    if (ref.kind === 'folder') fail('unsupported', 'folders carry no comment in this engine', { item: cmd.item });
    return {
      scope: ref.kind === 'composition' ? itemsScope([ref.id]) : itemsScope(),
      label: 'Item Comment',
      apply: () => {
        if (ref.kind === 'composition') patchComp(ref.id, { comment: cmd.comment || undefined });
        else patchAsset(ref.id, (a) => {
          const next = { ...a };
          if (cmd.comment) next.comment = cmd.comment;
          else delete next.comment;
          return next;
        });
        return {};
      },
    };
  },

  setItemTags: (cmd) => {
    const ref = requireItem(cmd.item);
    if (ref.kind !== 'footage') fail('unsupported', 'only footage carries tags in this engine', { item: cmd.item });
    return {
      scope: itemsScope(),
      label: 'Item Tags',
      apply: () => {
        patchAsset(cmd.item, (a) => {
          const next = { ...a };
          if (cmd.tags.length > 0) next.tags = [...cmd.tags];
          else delete next.tags;
          return next;
        });
        return {};
      },
    };
  },

  // ── Render queue ────────────────────────────────────────────────────

  addRenderItems: (cmd, ctx) => {
    if (cmd.comps.length === 0) fail('invalidArgument', 'no compositions given');
    for (const c of cmd.comps) if (!isCompItem(c)) fail('notFound', `no composition '${c}'`, { item: c });
    const ids = cmd.comps.map(() => ctx.mintId('render_'));
    const s = newScope();
    s.keys.add(K.rq);
    return {
      scope: s,
      label: 'Add to Render Queue',
      apply: () => {
        const items: RenderItemInfo[] = cmd.comps.map((comp, i) => {
          const cs = compSettings(comp);
          return {
            id: ids[i]!, comp,
            settings: applyRenderPatch({ ...DEFAULT_RENDER, range: { start: 0, duration: cs.duration } }, cmd.settings),
            status: 'queued', queued: true, progress: 0, error: '',
          };
        });
        setRenderQueueState([...getRenderQueue(), ...items]);
        return { items: ids };
      },
    };
  },

  setRenderItem: (cmd) => {
    const q = getRenderQueue();
    if (!q.some((r) => r.id === cmd.item)) fail('notFound', `no render item '${cmd.item}'`);
    const s = newScope();
    s.keys.add(K.rq);
    return {
      scope: s,
      label: 'Render Settings',
      apply: () => {
        setRenderQueueState(getRenderQueue().map((r) => (r.id === cmd.item
          ? { ...r, settings: applyRenderPatch(r.settings, cmd.patch), ...(cmd.queued !== undefined ? { queued: cmd.queued, status: cmd.queued ? 'queued' : 'unqueued' } : {}) }
          : r)));
        return {};
      },
    };
  },

  removeRenderItems: (cmd) => {
    const q = getRenderQueue();
    for (const id of cmd.items) if (!q.some((r) => r.id === id)) fail('notFound', `no render item '${id}'`);
    const s = newScope();
    s.keys.add(K.rq);
    return {
      scope: s,
      label: 'Remove from Render Queue',
      apply: () => {
        const doomed = new Set(cmd.items);
        setRenderQueueState(getRenderQueue().filter((r) => !doomed.has(r.id)));
        return {};
      },
    };
  },

  reorderRenderItems: (cmd) => {
    const q = getRenderQueue();
    for (const id of cmd.items) if (!q.some((r) => r.id === id)) fail('notFound', `no render item '${id}'`);
    if (cmd.toIndex > q.length) fail('outOfRange', 'toIndex past the end');
    const s = newScope();
    s.keys.add(K.rq);
    return {
      scope: s,
      label: 'Reorder Render Queue',
      apply: () => {
        const moving = new Set(cmd.items);
        const cur = getRenderQueue();
        const movers = cur.filter((r) => moving.has(r.id));
        const rest = cur.filter((r) => !moving.has(r.id));
        const at = Math.min(rest.length, cur.slice(0, cmd.toIndex).filter((r) => !moving.has(r.id)).length);
        setRenderQueueState([...rest.slice(0, at), ...movers, ...rest.slice(at)]);
        return {};
      },
    };
  },
};

export { compItemIds, framesToFlicks };
