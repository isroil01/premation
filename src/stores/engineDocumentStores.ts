/**
 * F2 — the guides, swatch and material stores as VIEWS of the engine's
 * document when the engine owns it (docs/NATIVE_CORE_PLAN.md §5 Phase F2,
 * inventory row "motionBlurStore, guidesStore, colorManagementStore,
 * swatchStore, materialStore, transitionStore").
 *
 * With the TypeScript engine as owner (the default) these stores ARE the
 * document's guides / palette / material library: the panels write them and
 * `captureDocument` saves them. With the C++ engine as owner that would lose
 * every edit — the engine never sees a page store — so, behind the flag:
 *
 *   engine → store   the mirror carries `guides` / `swatches` / `materials`
 *                    (DocumentSnapshot + guidesChanged / swatchesChanged /
 *                    materialsChanged); whenever they change (an edit, undo,
 *                    redo, open, another window) the store is set from them.
 *                    The engine's value is the truth — canonicalized ids,
 *                    colours and material axes included.
 *   store → engine   a USER edit to the store (the Swatches panel, the
 *                    material library, the guide/grid toggles) becomes ONE
 *                    undoable engine command — `setSwatches`, `setMaterials`,
 *                    `setGuides` — with the whole new value. A write made by
 *                    `restoreDocument` (the page replica catching up) is not a
 *                    user edit and is never sent.
 *
 * The stores keep their API, so no panel changes. Their session-only state
 * (the 3D view mode, the channel, the camera tool) is not document state and
 * never leaves the page.
 *
 * Motion blur and colour management (2026-09-27) follow the same route: the
 * mirror carries `motionBlur` / `colorManagement` (DocumentSnapshot +
 * motionBlurChanged / colorManagementChanged) and a user edit is ONE
 * `setMotionBlur` / `setColorManagement` with the whole record. Transitions
 * already are engine commands with the mirror carrying them
 * (`CompInfo.transitions`), their store written by the replica.
 */

import type { ColorManagementSettings, Command, EngineResult, LibraryMaterial, MotionBlurSettings, Swatch } from '@motion/engine-api';
import { DEFAULT_GUIDES_SETTINGS, useGuidesStore, type GuidesSettings } from './guidesStore';
import { useSwatchStore, type ProjectSwatch } from './swatchStore';
import { useMaterialStore, type NamedMaterial } from './materialStore';
import { useMotionBlurStore } from './motionBlurStore';
import { useColorManagementStore } from './colorManagementStore';

/** What the binder reads from the document mirror (DocumentMirror satisfies it). */
export interface StoreMirrorView {
  readonly guides: string;
  readonly swatches: readonly Swatch[];
  readonly materials: readonly LibraryMaterial[];
  readonly motionBlur: MotionBlurSettings;
  readonly colorManagement: ColorManagementSettings;
  subscribe(keys: readonly string[], listener: () => void): () => void;
}

export interface EngineDocumentStoresOptions {
  mirror: StoreMirrorView;
  /** Send one undoable edit to the owner (uiEdits `edit` in the app). */
  send: (label: string, cmd: Command) => Promise<EngineResult<unknown>>;
}

/** The persisted guide settings with every key stated, so a patch also CLEARS (an emptied bookmark list, a reset opacity). */
function fullGuides(): GuidesSettings {
  const s = useGuidesStore.getState();
  return {
    ...s.settings(),
    cameraBookmarks: s.cameraBookmarks,
    overlayOpacity: s.overlayOpacity,
    motionPathShow: s.motionPathShow,
    motionPathWindowSeconds: s.motionPathWindowSeconds,
    userGuides: s.userGuides,
  };
}

const swatchesOf = (list: readonly ProjectSwatch[]): Swatch[] => list.map((s) => ({ id: s.id, name: s.name, hex: s.hex }));

/** The motion-blur store as the engine's record (every field stated, so the command is the whole value). */
function motionBlurOf(): MotionBlurSettings {
  const m = useMotionBlurStore.getState().settings();
  return { enabled: m.enabled, shutterAngle: m.shutterAngle, shutterPhase: m.shutterPhase, samplesPerFrame: m.samples, adaptiveSampleLimit: m.adaptiveSampleLimit };
}

function colorManagementOf(): ColorManagementSettings {
  const c = useColorManagementStore.getState().settings();
  return { workingSpace: c.workingSpace === 'aces-cg' ? 'acesCg' : 'srgbLinear', displayTransform: c.displayTransform, bitDepth: c.bitDepth };
}

const materialsOf = (list: readonly NamedMaterial[]): LibraryMaterial[] =>
  list.map((m) => ({ id: m.id, name: m.name, params: JSON.stringify(m.params), swatch: m.swatch ?? '' }));

interface Binding {
  label: string;
  /** The store's document value, serialized for comparison. */
  storeKey(): string;
  /** Set the store from the mirror. */
  applyMirror(): void;
  /** The command that makes the engine hold the store's value. */
  command(): Command;
  subscribeStore(listener: () => void): () => void;
  mirrorKey: 'guides' | 'swatches' | 'materials' | 'motionBlur' | 'colorManagement';
}

/**
 * Install the binding (the engine-owned session does, and disposes it with the
 * session). Applies the mirror's values at once.
 */
export function bindEngineDocumentStores(o: EngineDocumentStoresOptions): () => void {
  const bindings: Binding[] = [
    {
      label: 'Guides',
      mirrorKey: 'guides',
      storeKey: () => JSON.stringify(fullGuides()),
      applyMirror: () => {
        let parsed: Partial<GuidesSettings> = {};
        try {
          const v = JSON.parse(o.mirror.guides || '{}') as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Partial<GuidesSettings>;
        } catch {
          parsed = {};
        }
        // The engine omits defaults; the store's restore only sets what it is given.
        useGuidesStore.getState().restore({ ...DEFAULT_GUIDES_SETTINGS, ...parsed });
      },
      command: () => ({ type: 'setGuides', patch: JSON.stringify(fullGuides()) }),
      subscribeStore: (l) => useGuidesStore.subscribe(l),
    },
    {
      label: 'Swatches',
      mirrorKey: 'swatches',
      storeKey: () => JSON.stringify(swatchesOf(useSwatchStore.getState().swatches)),
      applyMirror: () => useSwatchStore.getState().restore(o.mirror.swatches.map((s) => ({ id: s.id, name: s.name, hex: s.hex }))),
      command: () => ({ type: 'setSwatches', swatches: swatchesOf(useSwatchStore.getState().swatches) }),
      subscribeStore: (l) => useSwatchStore.subscribe(l),
    },
    {
      label: 'Materials',
      mirrorKey: 'materials',
      storeKey: () => JSON.stringify(materialsOf(useMaterialStore.getState().materials)),
      applyMirror: () =>
        useMaterialStore.getState().restore(
          o.mirror.materials.map((m) => {
            let params: unknown = {};
            try {
              params = JSON.parse(m.params);
            } catch {
              params = {};
            }
            return { id: m.id, name: m.name, params, ...(m.swatch ? { swatch: m.swatch } : {}) };
          }),
        ),
      command: () => ({ type: 'setMaterials', materials: materialsOf(useMaterialStore.getState().materials) }),
      subscribeStore: (l) => useMaterialStore.subscribe(l),
    },
    {
      label: 'Motion Blur',
      mirrorKey: 'motionBlur',
      storeKey: () => JSON.stringify(motionBlurOf()),
      applyMirror: () => {
        const m = o.mirror.motionBlur;
        useMotionBlurStore.getState().restore({
          enabled: m.enabled ?? true,
          shutterAngle: m.shutterAngle,
          shutterPhase: m.shutterPhase,
          samples: m.samplesPerFrame,
          adaptiveSampleLimit: m.adaptiveSampleLimit,
        });
      },
      command: () => {
        const m = motionBlurOf();
        return { type: 'setMotionBlur', patch: { ...m } };
      },
      subscribeStore: (l) => useMotionBlurStore.subscribe(l),
    },
    {
      label: 'Color Management',
      mirrorKey: 'colorManagement',
      storeKey: () => JSON.stringify(colorManagementOf()),
      applyMirror: () => {
        const c = o.mirror.colorManagement;
        useColorManagementStore.getState().restore({
          workingSpace: c.workingSpace === 'acesCg' ? 'aces-cg' : 'srgb-linear',
          displayTransform: c.displayTransform,
          bitDepth: c.bitDepth === 32 ? 32 : 16,
        });
      },
      command: () => ({ type: 'setColorManagement', patch: { ...colorManagementOf() } }),
      subscribeStore: (l) => useColorManagementStore.subscribe(l),
    },
  ];

  const disposers: Array<() => void> = [];
  for (const b of bindings) {
    /** The store value the engine is known to hold (after a mirror apply or an answered send). */
    let baseline = '';
    let applying = false;
    let inFlight = false;
    /** The mirror value last applied (a store is only set when the ENGINE's value moved). */
    let lastMirror: string | null = null;
    const mirrorKey = (): string => JSON.stringify(o.mirror[b.mirrorKey]);

    const fromMirror = (): void => {
      applying = true;
      try {
        b.applyMirror();
      } finally {
        applying = false;
      }
      baseline = b.storeKey();
    };

    const flush = (): void => {
      if (inFlight) return;
      const now = b.storeKey();
      if (now === baseline) return;
      inFlight = true;
      baseline = now;
      void o.send(b.label, b.command()).then(
        (r) => {
          inFlight = false;
          // Refused (a colour that is not hex…): the engine's value stands.
          if (!r.ok) {
            fromMirror();
            return;
          }
          // The echo was held back while this was in flight: take the engine's
          // canonical value (re-minted ids, normalized axes) if it differs.
          // An edit made while this one was in flight is sent first; its own
          // answer then brings the engine's value back.
          if (b.storeKey() !== baseline) {
            flush();
            return;
          }
          const k = mirrorKey();
          if (k !== lastMirror) {
            lastMirror = k;
            fromMirror();
          }
        },
        () => {
          inFlight = false;
          fromMirror();
        },
      );
    };

    // A (re)load notifies every key, so the key alone also covers open / new / restart.
    disposers.push(o.mirror.subscribe([b.mirrorKey], () => {
      if (inFlight) return;  // our own edit's echo lands with the answer
      const k = mirrorKey();
      if (k === lastMirror) return;
      lastMirror = k;
      fromMirror();
    }));
    disposers.push(b.subscribeStore(() => {
      if (applying) return;
      flush();
    }));
    lastMirror = mirrorKey();
    fromMirror();
  }
  return () => {
    for (const d of disposers.splice(0)) d();
  };
}
