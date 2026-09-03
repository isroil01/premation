/**
 * materialStore — the project's named 3D materials.
 *
 * TWO LISTS, ONE STRIP, and the split is the same one `swatchStore` draws
 * between an authored palette and a derived one:
 *
 *  • **Built-ins** ship with the app. They are the six "Pro 3D Material
 *    Presets" that used to be a hard-coded grid inside the Transform panel and
 *    then moved into the Style panel's preset registry — imported here from
 *    that one registry rather than re-typed, so there is still exactly one
 *    place where "Gold" is defined. Never persisted (they would be stale the
 *    next time the registry changed) and never deletable.
 *
 *  • **Project materials** are AUTHORED. A user saves "Hero glass", renames it
 *    and expects it back tomorrow, so it belongs to the DOCUMENT and
 *    round-trips through `EditorDocument.materials` exactly the way swatches
 *    do. A material library that followed the app rather than the file would be
 *    the previous project's library the moment a second file opened.
 *
 * A material is MATERIAL OPTIONS AND NOTHING ELSE. The Style presets it is
 * seeded from also state a fill colour; that half stays in the Style panel,
 * because a panel that does not own fill must not replace it — which is the
 * exact bug the old in-Transform grid had. The preset colour survives here only
 * as `swatch`, the tint the library thumbnail is drawn in.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';
import { batchHistory } from '@stores/historyStore';
import {
  applyMaterialParams,
  normalizeMaterialParams,
  DEFAULT_MATERIAL_PARAMS,
  type MaterialParams,
} from '@core/scene/material';
import { STYLE_PRESETS } from '@core/style/stylePresets';

/** One named surface in the project (or one built-in). */
export interface NamedMaterial {
  id: string;
  name: string;
  params: MaterialParams;
  /** True for the shipped library. Not persisted, not deletable, not renamable. */
  builtin?: boolean;
  /** `#rrggbb` used to tint the thumbnail. Presentation only — never applied. */
  swatch?: string;
}

/** Persisted + document state: every mutation must tell autosave. */
function touched(): void {
  try {
    getEventBus().emit('DocumentChanged', { source: 'composition' });
  } catch {
    /* no bus in headless tests */
  }
}

let seq = 0;
function materialId(): string {
  seq += 1;
  return `mat_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * The material axes each built-in implies, beyond the two the old grid could
 * state.
 *
 * The grid predates the PBR and Toon models and predates the roughness/metal
 * pair, so all six of its entries could say only "specular + shininess" — which
 * is why "Steel" and "Gold" differed by nothing but a colour the library is not
 * allowed to write. Naming a material Gold and giving it no metalness would
 * make the library's thumbnails lie, so each built-in states the surface its
 * name means. Specular and shininess still come from the registry.
 */
const BUILTIN_AXES: Readonly<Record<string, Partial<MaterialParams>>> = {
  steel: { shading: 'pbr', metal: 90, roughness: 32, diffuse: 40 },
  gold: { shading: 'pbr', metal: 100, roughness: 20, diffuse: 35 },
  plastic: { shading: 'phong', metal: 0, diffuse: 70 },
  'glass-3d': { shading: 'pbr', metal: 0, roughness: 4, lightTransmission: 85, diffuse: 25 },
  'neon-3d': { shading: 'phong', metal: 0, ambient: 100, diffuse: 90 },
  obsidian: { shading: 'pbr', metal: 25, roughness: 10, diffuse: 20 },
};

/**
 * Build the shipped library from the Style panel's `material` presets.
 *
 * `acceptsLights` is forced on: every one of these is a description of how a
 * surface answers a light, and applying one to a layer that ignores lights
 * would visibly do nothing at all.
 */
export function builtinMaterials(): NamedMaterial[] {
  return STYLE_PRESETS.filter((p) => p.category === 'material').map((p) => {
    // A material preset's fill is a single solid — the thumbnail tint.
    const paint = p.fills('#2b7eff')[0];
    const swatch = paint && paint.type === 'solid' ? paint.color : undefined;
    return {
      id: `builtin:${p.id}`,
      name: p.label,
      builtin: true,
      ...(typeof swatch === 'string' ? { swatch: swatch.slice(0, 7) } : {}),
      params: {
        ...DEFAULT_MATERIAL_PARAMS,
        acceptsLights: true,
        ...(p.specular !== undefined ? { specular: p.specular } : {}),
        ...(p.shininess !== undefined ? { shininess: p.shininess } : {}),
        ...BUILTIN_AXES[p.id],
      },
    };
  });
}

/**
 * Coerce whatever a document carried into a valid library.
 *
 * Entries without a usable id or name are repaired rather than dropped (unlike
 * a swatch, whose whole content is the colour that failed to parse — here the
 * params always normalize to *something* renderable). Anything claiming to be a
 * built-in is stripped of that claim: built-ins come from the registry, and a
 * document that could inject one would be able to shadow a shipped material.
 */
export function normalizeMaterials(raw: unknown): NamedMaterial[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedMaterial[] = [];
  const usedIds = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Partial<NamedMaterial>;
    const id = typeof rec.id === 'string' && rec.id && !usedIds.has(rec.id) && !rec.id.startsWith('builtin:')
      ? rec.id
      : materialId();
    usedIds.add(id);
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Material';
    const swatch = typeof rec.swatch === 'string' && /^#[0-9a-fA-F]{6}$/.test(rec.swatch)
      ? rec.swatch.toLowerCase()
      : undefined;
    out.push({
      id,
      name,
      params: normalizeMaterialParams(rec.params),
      ...(swatch ? { swatch } : {}),
    });
  }
  return out;
}

interface MaterialStore {
  /** Authored, in the user's order. Persisted in the document. */
  materials: NamedMaterial[];
  /** Built-ins first, then the project's own — the order the strip renders. */
  all: () => NamedMaterial[];
  find: (id: string) => NamedMaterial | undefined;
  addMaterial: (name: string, params: MaterialParams, swatch?: string) => NamedMaterial;
  renameMaterial: (id: string, name: string) => void;
  /** No-op for a built-in: the shipped library is not the user's to delete. */
  removeMaterial: (id: string) => void;
  /** Capture for the document — project materials only. */
  list: () => NamedMaterial[];
  /** Restore from a document. Replaces the library wholesale. */
  restore: (raw: unknown) => void;
}

export const useMaterialStore = create<MaterialStore>((set, get) => ({
  materials: [],

  all: () => [...builtinMaterials(), ...get().materials],

  find: (id) => get().all().find((m) => m.id === id),

  addMaterial: (name, params, swatch) => {
    const material: NamedMaterial = {
      id: materialId(),
      name: name.trim() || 'Material',
      // Copied, not referenced: the caller's object is usually the live
      // read of a layer, and a library entry that kept moving with the layer
      // it was saved from would not be a library entry.
      params: { ...params },
      ...(swatch ? { swatch } : {}),
    };
    set((s) => ({ materials: [...s.materials, material] }));
    touched();
    return material;
  },

  renameMaterial: (id, name) => {
    const trimmed = name.trim();
    set((s) => ({
      materials: s.materials.map((m) => (m.id === id ? { ...m, name: trimmed || m.name } : m)),
    }));
    touched();
  },

  removeMaterial: (id) => {
    if (id.startsWith('builtin:')) return;
    set((s) => ({ materials: s.materials.filter((m) => m.id !== id) }));
    touched();
  },

  list: () => get().materials.map((m) => ({ ...m, params: { ...m.params } })),

  restore: (raw) => {
    // Assigned unconditionally: a project opened after one that had a library
    // must not inherit it. `restoreDocument` only calls this when the key is
    // present, and `projectDocumentIO.createEmpty` states an empty library
    // explicitly so File ▸ New really does clear it.
    set({ materials: normalizeMaterials(raw) });
  },
}));

/**
 * Apply one library material to every given layer, as ONE undo step.
 *
 * `batchHistory` is load-bearing rather than decoration: the history recorder
 * debounces per TARGET, so twelve prop writes across three layers would
 * otherwise land as up to thirty-six separate undo steps for one click on a
 * thumbnail. Mirrors `SwatchesPanel`'s apply-to-selection exactly.
 *
 * Returns false when the id names no material — the caller can then say so
 * instead of reporting a silent success.
 */
export function applyMaterialToNodes(ids: readonly string[], materialRefId: string): boolean {
  const material = useMaterialStore.getState().find(materialRefId);
  if (!material) return false;
  batchHistory(`material:apply:${materialRefId}`, () => {
    for (const id of ids) applyMaterialParams(id, material.params);
  });
  return true;
}
