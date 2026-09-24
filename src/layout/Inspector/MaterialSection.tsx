/**
 * MaterialSection — everything about what a 3D layer is MADE OF, in one place.
 *
 * It was in three places. The Material Options rows (shadow tri-states, light
 * transmission, ambient/diffuse/specular, the reflectance model and its
 * parameters) were buried two levels inside ThreeDControl's 3D-switch
 * sub-panel, under a Geometry group they have nothing to do with. The per-face
 * colour overrides were a fourth level down. And the material PRESETS were two
 * panels away in Style, because they also write a fill and a panel that does
 * not own fill must not replace it.
 *
 * So the answer to "make this look like brushed steel" was: find the Transform
 * panel, turn on 3D, scroll past extrusion and bevel, turn on Accepts Lights,
 * then go to a different panel for the preset — and the preset would overwrite
 * the colour you had picked. This section is the other half of that fix: the
 * MATERIAL half of a preset (and any surface you save yourself) is a first-class
 * reusable object here, applied to any number of selected layers in one undo
 * step, and it never touches a layer's colour, geometry or transform.
 *
 * The preview is a CSS-shaded sphere, NOT an engine render. It is an
 * approximation and says so: it exists to tell Rough apart from Polished and
 * Toon apart from Phong at a glance, which no numeric row can do. Rendering it
 * through the real pipeline would mean a WebGL context per thumbnail in a panel
 * that repaints on every scrub.
 */

import { useState, useCallback } from 'react';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { mirrorCanBe3D, mirrorMaterial } from '@core/mirror/layerFacts';
import { colorValueHex } from '@core/mirror/paintFields';
import {
  materialParamsOf,
  type MaterialParams,
} from '@core/scene/material';
import { useAssetStore } from '@stores/assetStore';
import {
  useMaterialStore,
  builtinMaterials,
  type NamedMaterial,
} from '@stores/materialStore';
import type { PresetValue, PresetValues } from '@stores/sectionPresetStore';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { fieldCommands, hasPath, materialCommands, shadowModeValue } from './materialEdits';
import { FaceMaterialsSection } from './FaceMaterialsSection';
import { getTime } from '@stores/playbackClockStore';
import { scalarValueCommands } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';
import { SectionPresetMenu } from './SectionPresetMenu';
import s from './MaterialSection.module.css';

/** Whether this layer has a material at all — the registry's `appliesTo`. */
export function hasMaterialSection(nodeId: string): boolean {
  if (!nodeId || nodeId === 'comp_root') return false;
  const m = documentMirror();
  const layer = m.layer(nodeId);
  return !!layer && layer.switches.threeD && mirrorCanBe3D(layer, m.tree(nodeId));
}

/* ── The CSS sphere ───────────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return [120, 130, 145];
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

function shade(rgb: readonly [number, number, number], k: number, a = 1): string {
  return a >= 1
    ? `rgb(${clamp255(rgb[0] * k)}, ${clamp255(rgb[1] * k)}, ${clamp255(rgb[2] * k)})`
    : `rgba(${clamp255(rgb[0] * k)}, ${clamp255(rgb[1] * k)}, ${clamp255(rgb[2] * k)}, ${a.toFixed(3)})`;
}

/**
 * A CSS `background` that approximates the material on a sphere.
 *
 * Pure and exported so the mapping is testable without a DOM: the interesting
 * claim is not that it renders, it is that changing roughness changes the
 * highlight and that Toon produces hard steps rather than a smooth ramp.
 *
 *  • body ramp   ← ambient (the terminator's floor) and diffuse (its range)
 *  • highlight   ← specular (opacity), and TIGHTNESS from shininess on the
 *                  Phong/Toon path or from roughness on the PBR one
 *  • metal       ← blends the highlight from white toward the surface colour,
 *                  which is exactly what the shader's F0 does
 *  • toon        ← the same ramp quantized into `toonBands` hard steps
 */
export function materialSphereCss(p: MaterialParams, baseColor: string): string {
  const rgb = hexToRgb(baseColor);
  const ambientK = 0.16 + (p.ambient / 100) * 0.3;
  const litK = ambientK + (p.diffuse / 100) * 0.95;

  // 0 (mirror) → 1 (fully matte), from whichever knob this model exposes.
  const rough = p.shading === 'pbr'
    ? p.roughness / 100
    : 1 - Math.min(1, Math.log(Math.max(1, p.shininess)) / Math.log(256));
  const hotspot = 6 + rough * 42;
  const specA = (p.specular / 100) * (p.acceptsLights ? 1 : 0.35);
  const metalMix = p.metal / 100;
  const hi: [number, number, number] = [
    255 * (1 - metalMix) + rgb[0] * 1.25 * metalMix,
    255 * (1 - metalMix) + rgb[1] * 1.25 * metalMix,
    255 * (1 - metalMix) + rgb[2] * 1.25 * metalMix,
  ];
  const highlight = `radial-gradient(circle at 34% 27%, rgba(${clamp255(hi[0])}, ${clamp255(hi[1])}, ${clamp255(hi[2])}, ${specA.toFixed(2)}) 0%, rgba(${clamp255(hi[0])}, ${clamp255(hi[1])}, ${clamp255(hi[2])}, 0) ${hotspot.toFixed(0)}%)`;

  // Advanced-3D axes, previewed coarsely (the renderer is the truth):
  //  • an environment "sheen" streak — Reflection Intensity is its opacity,
  //    Sharpness tightens it, Rolloff slides it toward the rim. Toon never
  //    reflects (the shader excludes it), so the streak is absent there.
  //  • Transparency fades the body ramp; its Rolloff eases the fade, standing
  //    in for the facing-transmits-more Fresnel the shader applies for real.
  const reflI = p.reflectionIntensity / 100;
  const reflSharp = p.reflectionSharpness / 100;
  const reflRoll = p.reflectionRolloff / 100;
  const sheenA = p.shading === 'toon' ? 0 : 0.16 * reflI * (1 - rough * (1 - reflSharp));
  const sheenAt = 62 + reflRoll * 22;
  const sheenSpan = 9 + (1 - reflSharp) * 15;
  const sheen = sheenA > 0.001
    ? `radial-gradient(circle at ${sheenAt.toFixed(0)}% 38%, rgba(255, 255, 255, ${sheenA.toFixed(3)}) 0%, rgba(255, 255, 255, 0) ${sheenSpan.toFixed(0)}%), `
    : '';
  const bodyA = 1 - 0.65 * (p.transparency / 100) * (1 - 0.35 * (p.transparencyRolloff / 100));

  let body: string;
  if (p.shading === 'toon') {
    const bands = Math.max(2, Math.min(8, Math.round(p.toonBands)));
    const stops: string[] = [];
    for (let i = 0; i < bands; i += 1) {
      const k = litK - (litK - ambientK) * (i / (bands - 1));
      const from = (i / bands) * 100;
      const to = ((i + 1) / bands) * 100;
      stops.push(`${shade(rgb, k, bodyA)} ${from.toFixed(1)}% ${to.toFixed(1)}%`);
    }
    body = `radial-gradient(circle at 36% 30%, ${stops.join(', ')})`;
  } else {
    body = `radial-gradient(circle at 36% 30%, ${shade(rgb, litK, bodyA)} 0%, ${shade(rgb, (litK + ambientK) / 2, bodyA)} 55%, ${shade(rgb, ambientK, bodyA)} 100%)`;
  }
  return `${sheen}${highlight}, ${body}`;
}

/** The layer's own fill — the colour the preview and the shader both start from. */
function layerFill(nodeId: string): string {
  // `layer/fill`: a shape's fill colour, a text layer's Character colour.
  const f = colorValueHex(documentMirror().property(nodeId, 'layer/fill')?.value);
  return f ? f.slice(0, 7) : '#8a99a8';
}

/* ── Rows ─────────────────────────────────────────────────────────────────── */

/**
 * One material response row: label, slider, and a scrubbable/typable number.
 *
 * Moved verbatim from ThreeDControl, including its write path: both controls
 * call the SAME handler, which writes the static component prop. Material
 * properties are keyframeable — their stopwatches live on the timeline's
 * property rows (`propertyTree.ts` → `materialRows`), which this move does not
 * touch — so the behaviour here is exactly what it was before the move.
 */
function MaterialRow({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '%',
  onChange,
  engineProp,
  field,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** The legacy writer — for a material field the engine does not address. */
  onChange?: (v: number) => void;
  /**
   * B3: a `material/<prop>` property of this layer's catalog (a 3D layer lists
   * every keyframeable Material Option). Written through the engine API as ONE
   * command — keyed at the playhead when animated (the old static write was
   * invisible under a live track) — and a slider or field drag is ONE gesture.
   */
  engineProp?: { nodeId: string; prop: string };
  /**
   * B3z: a static (not keyframeable) Material Option — a LAYER FIELD
   * (`material/toonBands`, `material/displacementSubdivisions`): an integer
   * `setProperty`, a drag is ONE gesture.
   */
  field?: { nodeId: string; path: string };
}): JSX.Element {
  const e = useEngineEdit();
  const write = (v: number): void => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(min, Math.min(max, v));
    if (engineProp) {
      e.send(`Set ${label}`, scalarValueCommands(engineProp.prop, [{ nodeId: engineProp.nodeId, value: clamped }], { seconds: getTime() }));
      return;
    }
    if (field) {
      e.send(`Set ${label}`, fieldCommands([field.nodeId], field.path, values.scalar(Math.round(clamped))));
      return;
    }
    onChange?.(v);
  };
  const on = (): boolean => engineProp !== undefined || (field !== undefined && hasPath(field.nodeId, field.path));
  return (
    <div className={s.row} {...e.press(`Set ${label}`, on)}>
      <span className={s.label}>{label}</span>
      <input
        type="range"
        className={s.slider}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(ev) => write(Number(ev.currentTarget.value))}
        aria-label={`${label} slider`}
      />
      <span className={s.value}>
        <ValueField
          value={value}
          min={min}
          max={max}
          step={step}
          unit={unit}
          onChange={write}
          {...e.scrub(`Set ${label}`, on)}
          aria-label={label}
        />
      </span>
    </div>
  );
}

/** One library thumbnail. Built-ins have no rename/delete — they are shipped. */
function MaterialChip({
  material,
  onApply,
  onRename,
  onDelete,
}: {
  material: NamedMaterial;
  onApply: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(material.name);

  return (
    <div className={s.chipRow}>
      <button
        type="button"
        className={s.chip}
        onClick={onApply}
        title={`Apply ${material.name} to the selected layers`}
        aria-label={`Apply material ${material.name}`}
      >
        <span
          className={s.chipBall}
          style={{ background: materialSphereCss(material.params, material.swatch ?? '#8a99a8') }}
        />
        {!renaming && <span className={s.chipName}>{material.name}</span>}
      </button>
      {renaming && (
        <input
          className={s.nameInput}
          style={{ width: 52 }}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => { onRename(draft); setRenaming(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onRename(draft); setRenaming(false); }
            if (e.key === 'Escape') { setDraft(material.name); setRenaming(false); }
          }}
          aria-label={`Rename material ${material.name}`}
        />
      )}
      {!material.builtin && !renaming && (
        <span className={s.chipTools}>
          <button
            type="button"
            className={s.iconBtn}
            onClick={() => { setDraft(material.name); setRenaming(true); }}
            title={`Rename ${material.name}`}
            aria-label={`Rename material ${material.name}`}
          >
            <Icon name="pencil" size="sm" />
          </button>
          <button
            type="button"
            className={s.iconBtn}
            onClick={onDelete}
            title={`Delete ${material.name}`}
            aria-label={`Delete material ${material.name}`}
          >
            <Icon name="trash" size="sm" />
          </button>
        </span>
      )}
    </div>
  );
}

/* ── The section ──────────────────────────────────────────────────────────── */

export function MaterialPresetAction({
  nodeId,
  nodeIds,
}: {
  nodeId: string;
  nodeIds?: ReadonlyArray<string>;
}): JSX.Element {
  const selectedIds = useSelectionStore((x) => x.ids);
  const effectiveTargets = nodeIds && nodeIds.length > 0
    ? nodeIds
    : (selectedIds.includes(nodeId) ? selectedIds : [nodeId]);

  // The layer's material as a preset (the twin of `captureMaterialPreset`), read from the mirror at call time.
  const capturePreset = useCallback((): PresetValues => {
    const m = documentMirror();
    if (!m.layer(nodeId)) return {};
    const out: Record<string, PresetValue> = {};
    for (const [k, v] of Object.entries(materialParamsOf(mirrorMaterial(m.tree(nodeId))))) {
      if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' || typeof v === 'boolean') out[k] = v as PresetValue;
    }
    return out;
  }, [nodeId]);
  // One batch over every target (materialEdits.ts): one undo entry.
  const applyPreset = useCallback(
    (bag: Readonly<Record<string, number | string | boolean>>) => {
      const cmds = materialCommands(effectiveTargets, bag, getTime());
      if (cmds.length > 0) void edit('Apply Material preset', cmds);
    },
    [effectiveTargets],
  );

  return (
    <SectionPresetMenu
      sectionId="material"
      label="Material presets"
      capture={capturePreset}
      apply={applyPreset}
    />
  );
}

export function MaterialSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // The header (the 3D switch) and the property tree (`material/*`, `layer/fill`).
  useMirrorLayer(nodeId);
  const tree = useMirrorTree(nodeId);
  const selectedIds = useSelectionStore((x) => x.ids);
  const materials = useMaterialStore((x) => x.materials);
  const addMaterial = useMaterialStore((x) => x.addMaterial);
  const renameMaterial = useMaterialStore((x) => x.renameMaterial);
  const removeMaterial = useMaterialStore((x) => x.removeMaterial);
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState('');

  if (!hasMaterialSection(nodeId)) return null;

  const material = mirrorMaterial(tree);
  const params = materialParamsOf(material);
  const fill = layerFill(nodeId);
  // Built-ins first, then the project's own — subscribed through `materials`
  // so saving or deleting one repaints the strip.
  const library = [...builtinMaterials(), ...materials];

  /**
   * Which layers a library click paints.
   *
   * The selection when the inspector is showing this layer, so applying a
   * material to eight selected layers is one click and one undo — and this
   * layer alone when the selection has drifted away from what the panel shows
   * (which happens with the pinned inspector), because painting layers the
   * user cannot see the panel for would be worse than doing too little.
   */
  const targets = selectedIds.includes(nodeId) ? selectedIds : [nodeId];

  const commitSave = (): void => {
    const name = draftName.trim();
    if (!name) return;
    addMaterial(name, params, fill);
    setDraftName('');
    setSaving(false);
  };

  return (
    <div className={s.stack}>
      <span className={s.groupHeader}>
        Material Library
        <Button
          size="xs"
          variant="ghost"
          onClick={() => { setDraftName(''); setSaving((v) => !v); }}
          leftIcon={<Icon name="plus" size="sm" />}
          title="Save this layer's material options as a reusable material"
        >
          Save as material…
        </Button>
      </span>

      {saving && (
        <div className={s.saveRow}>
          <input
            className={s.nameInput}
            autoFocus
            placeholder="Material name"
            value={draftName}
            onChange={(e) => setDraftName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSave();
              if (e.key === 'Escape') setSaving(false);
            }}
            aria-label="New material name"
          />
          <Button size="xs" variant="primary" onClick={commitSave} disabled={!draftName.trim()}>
            Save
          </Button>
        </div>
      )}

      <div className={s.library}>
        {library.map((m) => (
          <MaterialChip
            key={m.id}
            material={m}
            onApply={() => {
              const cmds = materialCommands(targets, m.params, getTime());
              if (cmds.length > 0) void edit(`Apply material ${m.name}`, cmds);
            }}
            onRename={(name) => renameMaterial(m.id, name)}
            onDelete={() => removeMaterial(m.id)}
          />
        ))}
      </div>
      <p className={s.hint}>
        {targets.length > 1
          ? `Applying paints all ${targets.length} selected layers — colour, geometry and transform are left alone.`
          : 'Applying writes Material Options only — the layer keeps its colour, geometry and transform.'}
      </p>

      <div className={s.divider} />

      {/* ── Surface ─────────────────────────────────────────────── */}
      <span className={s.groupHeader}>Surface</span>
      <div className={s.previewRow}>
        <span
          className={s.preview}
          style={{ background: materialSphereCss(params, fill) }}
          title="Approximate preview — the renderer is the truth"
          aria-hidden="true"
          data-testid="material-preview"
        />
        <span className={s.previewMeta}>
          <span className={s.row}>
            <span className={s.label}>Shading</span>
            <select
              className={s.select}
              value={material.shading}
              // `material/shading` (a layer field): one edit.
              onChange={(e) => {
                const v = e.currentTarget.value === 'pbr' ? 'pbr' : e.currentTarget.value === 'toon' ? 'toon' : 'phong';
                void edit('Set Shading', fieldCommands([nodeId], 'material/shading', values.choice(v)));
              }}
              aria-label="Shading model"
            >
              <option value="phong">Phong</option>
              <option value="pbr">Physical (PBR)</option>
              <option value="toon">Toon (Cel)</option>
            </select>
          </span>
          <span className={s.row}>
            <span className={s.label}>Accepts Lights</span>
            <Switch
              checked={material.acceptsLights}
              // `material/acceptsLights` (0 / 1; keyed at the playhead when animated).
              onChange={(e) => {
                void edit('Set Accepts Lights', scalarValueCommands('acceptsLights', [{ nodeId, value: e.currentTarget.checked ? 1 : 0 }], { seconds: getTime() }));
              }}
              aria-label="Accepts lights"
            />
          </span>
        </span>
      </div>
      {!material.acceptsLights && (
        <p className={s.hint}>
          Accepts Lights is off, so scene lights wash over this layer instead of
          shading it — these responses are stored and animate, but nothing below
          changes the picture until it is on. Shadow-map shadows also land only
          on lit surfaces: with this off, Accepts Shadows cannot darken this
          layer.
        </p>
      )}

      <MaterialRow
        label="Ambient"
        value={material.ambient}
        engineProp={{ nodeId, prop: 'ambient' }}
      />
      <MaterialRow
        label="Diffuse"
        value={material.diffuse}
        engineProp={{ nodeId, prop: 'diffuse' }}
      />
      <MaterialRow
        label="Specular"
        value={material.specular}
        engineProp={{ nodeId, prop: 'specular' }}
      />
      {/* The rows that only mean something under the chosen model. Phong has no
          roughness and no metalness — they are the microfacet model's terms —
          so showing them there is offering a knob the shader never reads. */}
      {material.shading !== 'pbr' && (
        <MaterialRow
          label="Shininess"
          value={material.shininess}
          min={1}
          max={128}
          unit=""
          engineProp={{ nodeId, prop: 'shininess' }}
        />
      )}
      {material.shading === 'pbr' && (
        <MaterialRow
          label="Roughness"
          value={material.roughness}
          engineProp={{ nodeId, prop: 'roughness' }}
        />
      )}
      {/* Phong reads metal too — it tints the highlight — so the row stays. */}
      {(
        <MaterialRow
          label="Metal"
          value={material.metal}
          engineProp={{ nodeId, prop: 'metal' }}
        />
      )}
      {material.shading === 'toon' && (
        <MaterialRow
          label="Bands"
          value={material.toonBands}
          min={2}
          max={8}
          unit=""
          field={{ nodeId, path: 'material/toonBands' }}
        />
      )}
      {material.shading === 'toon' && material.specular === 0 && (
        <p className={s.hint}>
          Metal tints the specular highlight — raise Specular to see it.
        </p>
      )}

      <div className={s.divider} />

      {/* ── Reflections (AE Advanced 3D, scoped honestly) ────────── */}
      {/* These act on ENVIRONMENT reflections — the IBL specular term the
          comp's environment light provides. There is no layer-to-layer
          reflection pass, which is also why AE's fourth axis (Appears in
          Reflections) has no control here: a switch that changes no pixel
          is worse than no switch. */}
      <span className={s.groupHeader}>Reflections</span>
      {material.shading === 'toon' ? (
        <p className={s.hint}>
          Toon shading never reflects — a mirrored room in the highlight would
          undo the cel banding. Switch to Phong or Physical to use these.
        </p>
      ) : (
        <>
          <MaterialRow
            label="Reflection Intensity"
            value={material.reflectionIntensity}
            engineProp={{ nodeId, prop: 'reflectionIntensity' }}
          />
          <MaterialRow
            label="Reflection Sharpness"
            value={material.reflectionSharpness}
            engineProp={{ nodeId, prop: 'reflectionSharpness' }}
          />
          <MaterialRow
            label="Reflection Rolloff"
            value={material.reflectionRolloff}
            engineProp={{ nodeId, prop: 'reflectionRolloff' }}
          />
          <p className={s.hint}>
            Reflections mirror the comp&rsquo;s Environment light — add one to see
            them. Like Specular, they render on lit surfaces (Accepts Lights on).
          </p>
        </>
      )}

      <div className={s.divider} />

      {/* ── Transparency (AE Advanced 3D) ────────────────────────── */}
      {/* View-dependent alpha at the shading stage — distinct from Opacity
          because Rolloff makes it angle-dependent (glass). No refraction is
          rendered; IOR only shapes the Fresnel falloff. */}
      <span className={s.groupHeader}>Transparency</span>
      <MaterialRow
        label="Transparency"
        value={material.transparency}
        engineProp={{ nodeId, prop: 'transparency' }}
      />
      <MaterialRow
        label="Transparency Rolloff"
        value={material.transparencyRolloff}
        engineProp={{ nodeId, prop: 'transparencyRolloff' }}
      />
      <MaterialRow
        label="Index of Refraction"
        value={material.ior}
        min={1}
        max={4}
        step={0.01}
        unit=""
        engineProp={{ nodeId, prop: 'ior' }}
      />
      {material.transparency > 0 && !material.acceptsLights && (
        <p className={s.hint}>
          Transparency applies at the shading stage — turn Accepts Lights on
          (with at least one light in the comp) for it to render.
        </p>
      )}

      <div className={s.divider} />

      {/* ── Displacement (AE 26.2) ───────────────────────────────── */}
      {/* A height map's luma pushes the mesh along its normals: 50 % grey is
          flat, white rises, black sinks. Applies to extrusions, primitives
          and imported models alike (heightDisplacement.ts). The asset list is
          read once per render rather than subscribed — it changes on import,
          which re-renders the inspector anyway. */}
      <span className={s.groupHeader}>Displacement</span>
      <div className={s.row}>
        <span className={s.label}>Height Map</span>
        <select
          className={s.select}
          value={material.heightMapAssetId ?? ''}
          // `material/heightMap` (a layer field: the item id, '' = none).
          onChange={(e) => { void edit('Set Height Map', fieldCommands([nodeId], 'material/heightMap', values.string(e.target.value))); }}
          aria-label="Height map asset"
        >
          <option value="">None</option>
          {/* B4-gap: an item's media type (a still image vs other footage) — `ItemInfo` has none yet. */}
          {useAssetStore.getState().assets.filter((a) => a.type === 'image').map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      {(material.heightMapAssetId || material.heightMapSrc) && (
        <>
          <MaterialRow
            label="Displacement"
            value={material.displacement}
            min={-200}
            max={200}
            unit="px"
            engineProp={{ nodeId, prop: 'displacement' }}
          />
          <MaterialRow
            label="Subdivide"
            value={material.displacementSubdivisions}
            min={0}
            max={3}
            unit=""
            field={{ nodeId, path: 'material/displacementSubdivisions' }}
          />
        </>
      )}

      <div className={s.divider} />

      {/* ── Shadows ─────────────────────────────────────────────── */}
      <span className={s.groupHeader}>Shadows</span>
      {/* Tri-states, not switches: `Only` is what shadow-catcher setups are
          built from — a layer that throws or catches a shadow without
          rendering itself — and a boolean cannot express it. */}
      <div className={s.row}>
        <span className={s.label}>Casts Shadows</span>
        <select
          className={s.select}
          value={material.castsShadowsMode}
          // `material/castsShadows` (0 Off / 1 On / 2 Only; keyed at the playhead when animated).
          onChange={(e) => { void edit('Set Casts Shadows', scalarValueCommands('castsShadows', [{ nodeId, value: shadowModeValue(e.currentTarget.value as 'off' | 'on' | 'only') }], { seconds: getTime() })); }}
          aria-label="Casts shadows"
        >
          <option value="off">Off</option>
          <option value="on">On</option>
          <option value="only">Only</option>
        </select>
      </div>
      <div className={s.row}>
        <span className={s.label}>Accepts Shadows</span>
        <select
          className={s.select}
          value={material.acceptsShadowsMode}
          // `material/acceptsShadows` (0 Off / 1 On / 2 Only).
          onChange={(e) => { void edit('Set Accepts Shadows', scalarValueCommands('acceptsShadows', [{ nodeId, value: shadowModeValue(e.currentTarget.value as 'off' | 'on' | 'only') }], { seconds: getTime() })); }}
          aria-label="Accepts shadows"
        >
          <option value="off">Off</option>
          <option value="on">On</option>
          <option value="only">Only</option>
        </select>
      </div>
      {material.shadowOnly && (
        <p className={s.hint}>
          “Only” hides the layer itself — it stays in the scene purely as a
          shadow caster or catcher.
        </p>
      )}
      <MaterialRow
        label="Light Transmission"
        value={material.lightTransmission}
        engineProp={{ nodeId, prop: 'lightTransmission' }}
      />

      {/* ── Per-face overrides ──────────────────────────────────── */}
      {/* Renders nothing at all until the layer is extruded, which is when the
          side / bevel / back faces start to exist. */}
      <FaceMaterialsSection nodeId={nodeId} />
    </div>
  );
}

export default MaterialSection;
