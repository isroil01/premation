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

import { useState } from 'react';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { canBe3D, is3DEnabled } from '@core/scene/threeD';
import {
  readNodeMaterial,
  materialParamsOf,
  setNodeAcceptsLights,
  setNodeMaterialPct,
  setNodeShadowMode,
  setNodeShininess,
  setNodeSpecular,
  setNodeShadingModel,
  setNodeToonBands,
  MATERIAL_PCT_DEFAULTS,
  type MaterialParams,
} from '@core/scene/material';
import {
  useMaterialStore,
  applyMaterialToNodes,
  builtinMaterials,
  type NamedMaterial,
} from '@stores/materialStore';
import { FaceMaterialsSection } from './FaceMaterialsSection';
import s from './MaterialSection.module.css';

/** Whether this layer has a material at all — the registry's `appliesTo`. */
export function hasMaterialSection(nodeId: string): boolean {
  if (!nodeId || nodeId === 'comp_root') return false;
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && canBe3D(node) && is3DEnabled(node);
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

function shade(rgb: readonly [number, number, number], k: number): string {
  return `rgb(${clamp255(rgb[0] * k)}, ${clamp255(rgb[1] * k)}, ${clamp255(rgb[2] * k)})`;
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

  let body: string;
  if (p.shading === 'toon') {
    const bands = Math.max(2, Math.min(8, Math.round(p.toonBands)));
    const stops: string[] = [];
    for (let i = 0; i < bands; i += 1) {
      const k = litK - (litK - ambientK) * (i / (bands - 1));
      const from = (i / bands) * 100;
      const to = ((i + 1) / bands) * 100;
      stops.push(`${shade(rgb, k)} ${from.toFixed(1)}% ${to.toFixed(1)}%`);
    }
    body = `radial-gradient(circle at 36% 30%, ${stops.join(', ')})`;
  } else {
    body = `radial-gradient(circle at 36% 30%, ${shade(rgb, litK)} 0%, ${shade(rgb, (litK + ambientK) / 2)} 55%, ${shade(rgb, ambientK)} 100%)`;
  }
  return `${highlight}, ${body}`;
}

/** The layer's own fill — the colour the preview and the shader both start from. */
function layerFill(nodeId: string): string {
  const node = defaultSceneGraph.getNode(nodeId);
  const c = node?.components.find((x) => x.type === 'Style' || x.type === 'Text');
  const f = c?.props.fill;
  return typeof f === 'string' && f.startsWith('#') ? f.slice(0, 7) : '#8a99a8';
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
  unit = '%',
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className={s.row}>
      <span className={s.label}>{label}</span>
      <input
        type="range"
        className={s.slider}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label={`${label} slider`}
      />
      <span className={s.value}>
        <ValueField
          value={value}
          min={min}
          max={max}
          step={1}
          unit={unit}
          onChange={onChange}
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

export function MaterialSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((x) => x.rev);
  const selectedIds = useSelectionStore((x) => x.ids);
  const materials = useMaterialStore((x) => x.materials);
  const addMaterial = useMaterialStore((x) => x.addMaterial);
  const renameMaterial = useMaterialStore((x) => x.renameMaterial);
  const removeMaterial = useMaterialStore((x) => x.removeMaterial);
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState('');

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasMaterialSection(nodeId)) return null;

  const material = readNodeMaterial(node);
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
            onApply={() => applyMaterialToNodes(targets, m.id)}
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
              onChange={(e) => setNodeShadingModel(
                nodeId,
                e.currentTarget.value === 'pbr' ? 'pbr' : e.currentTarget.value === 'toon' ? 'toon' : 'phong',
              )}
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
              onChange={(e) => setNodeAcceptsLights(nodeId, e.currentTarget.checked)}
              aria-label="Accepts lights"
            />
          </span>
        </span>
      </div>
      {!material.acceptsLights && (
        <p className={s.hint}>
          Accepts Lights is off, so scene lights wash over this layer instead of
          shading it — these responses are stored and animate, but nothing below
          changes the picture until it is on.
        </p>
      )}

      <MaterialRow
        label="Ambient"
        value={material.ambient}
        onChange={(v) => setNodeMaterialPct(nodeId, 'ambient', v, MATERIAL_PCT_DEFAULTS.ambient)}
      />
      <MaterialRow
        label="Diffuse"
        value={material.diffuse}
        onChange={(v) => setNodeMaterialPct(nodeId, 'diffuse', v, MATERIAL_PCT_DEFAULTS.diffuse)}
      />
      <MaterialRow
        label="Specular"
        value={material.specular}
        onChange={(v) => setNodeSpecular(nodeId, v)}
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
          onChange={(v) => setNodeShininess(nodeId, v)}
        />
      )}
      {material.shading === 'pbr' && (
        <MaterialRow
          label="Roughness"
          value={material.roughness}
          onChange={(v) => setNodeMaterialPct(nodeId, 'roughness', v, MATERIAL_PCT_DEFAULTS.roughness)}
        />
      )}
      {/* Phong reads metal too — it tints the highlight — so the row stays. */}
      {(
        <MaterialRow
          label="Metal"
          value={material.metal}
          onChange={(v) => setNodeMaterialPct(nodeId, 'metal', v, MATERIAL_PCT_DEFAULTS.metal)}
        />
      )}
      {material.shading === 'toon' && (
        <MaterialRow
          label="Bands"
          value={material.toonBands}
          min={2}
          max={8}
          unit=""
          onChange={(v) => setNodeToonBands(nodeId, v)}
        />
      )}
      {material.shading === 'toon' && material.specular === 0 && (
        <p className={s.hint}>
          Metal tints the specular highlight — raise Specular to see it.
        </p>
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
          onChange={(e) => setNodeShadowMode(nodeId, 'castsShadows', e.currentTarget.value as 'off' | 'on' | 'only')}
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
          onChange={(e) => setNodeShadowMode(nodeId, 'acceptsShadows', e.currentTarget.value as 'off' | 'on' | 'only')}
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
        onChange={(v) => setNodeMaterialPct(nodeId, 'lightTransmission', v, MATERIAL_PCT_DEFAULTS.lightTransmission)}
      />

      {/* ── Per-face overrides ──────────────────────────────────── */}
      {/* Renders nothing at all until the layer is extruded, which is when the
          side / bevel / back faces start to exist. */}
      <FaceMaterialsSection nodeId={nodeId} />
    </div>
  );
}

export default MaterialSection;
