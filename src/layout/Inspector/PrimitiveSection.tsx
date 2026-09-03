/**
 * PrimitiveSection — the shape parameters of a parametric 3D primitive.
 *
 * A sphere/cylinder/cone/torus/capsule/box layer stores NUMBERS, not geometry
 * (see core/scene/primitiveLayer.ts), so this panel is where those numbers
 * live: the type itself, its radii/height/tube, and how finely it is
 * tessellated. Editing any of them mints a new mesh (and a new GPU buffer key)
 * on the next frame — which is what "re-generate when params change" means
 * here; nothing is baked at insert time.
 *
 * Rows are the whole switch for a type: PRIMITIVE_FIELDS in primitiveLayer.ts
 * says which parameters a shape actually consumes, so a cone never shows a
 * "tube" it would ignore, and adding a shape there adds its rows here.
 *
 * NOT KEYFRAMEABLE, deliberately. These are not transform channels: animating
 * `radialSegments` would rebuild and re-upload the mesh every frame, and
 * animating a radius is what the layer's SCALE is for (it costs one matrix,
 * keeps the buffers, and already keyframes). The panel therefore writes static
 * props through the ordinary undoable scene-graph path instead of pretending
 * to offer a stopwatch that would be a performance trap.
 */

import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  readNodePrimitive,
  setPrimitiveParam,
  setPrimitiveType,
  PRIMITIVE_FIELDS,
  PRIMITIVE_LABELS,
  PRIMITIVE_MESH_TYPES,
  type PrimitiveMeshType,
  type PrimitiveSpec,
} from '@core/scene/primitiveLayer';
import s from './PrimitiveSection.module.css';

/** Does this layer have shape parameters at all? Drives whether the inspector
 *  mounts the section (a mesh primitive; not an extruded cube or a plane). */
export function hasPrimitiveSection(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readNodePrimitive(node) !== null;
}

type SizeField = 'radius' | 'radiusTop' | 'height' | 'width' | 'depth' | 'tube';
type SegField = 'radialSegments' | 'heightSegments';

/** Row label + range per parameter, per type where the meaning shifts. */
const SIZE_ROWS: Record<SizeField, { label: string; max: number }> = {
  radius: { label: 'Radius', max: 4000 },
  radiusTop: { label: 'Top Radius', max: 4000 },
  height: { label: 'Height', max: 8000 },
  width: { label: 'Width', max: 8000 },
  depth: { label: 'Depth', max: 8000 },
  tube: { label: 'Tube', max: 2000 },
};

/** The segment rows mean different things per shape — say which. */
const SEG_LABELS: Record<PrimitiveMeshType, { radialSegments: string; heightSegments: string }> = {
  sphere: { radialSegments: 'Segments (around)', heightSegments: 'Segments (rows)' },
  cylinder: { radialSegments: 'Sides', heightSegments: '' },
  cone: { radialSegments: 'Sides', heightSegments: '' },
  torus: { radialSegments: 'Ring Segments', heightSegments: 'Tube Segments' },
  capsule: { radialSegments: 'Segments (around)', heightSegments: 'Cap Rows' },
  box: { radialSegments: '', heightSegments: '' },
};

const HINTS: Record<PrimitiveMeshType, string> = {
  sphere: 'A real UV sphere — smooth per-vertex normals, not an extruded circle.',
  cylinder: 'Set a different Top Radius for a truncated cone; uncap it for an open tube.',
  cone: 'A cylinder whose top radius is zero. Its wall normals tilt with the slope.',
  torus: 'Ring Segments rounds the donut; Tube Segments rounds its cross-section.',
  capsule: 'Height is the TOTAL extent, caps included — set it to 2 × Radius for a sphere.',
  box: 'Flat shaded, so the edges stay crisp. For bevels and per-face colours use a 3D Cube (extruded).',
};

export function PrimitiveSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((r) => r.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const spec = node ? readNodePrimitive(node) : null;
  if (!spec) return null;

  const fields = PRIMITIVE_FIELDS[spec.type];
  const uses = (f: keyof PrimitiveSpec): boolean => fields.includes(f);

  return (
    <div className={s.stack}>
      <div className={s.row}>
        <span className={s.label}>Shape</span>
        <select
          className={s.select}
          value={spec.type}
          onChange={(e) => setPrimitiveType(nodeId, e.currentTarget.value as PrimitiveMeshType)}
          aria-label="Primitive shape"
        >
          {PRIMITIVE_MESH_TYPES.map((t) => (
            <option key={t} value={t}>{PRIMITIVE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      {(Object.keys(SIZE_ROWS) as SizeField[]).filter(uses).map((f) => (
        <div className={s.row} key={f}>
          <span className={s.label}>{SIZE_ROWS[f].label}</span>
          <ValueField
            value={Math.round(spec[f] * 100) / 100}
            min={1}
            max={SIZE_ROWS[f].max}
            step={1}
            unit="px"
            onChange={(v) => setPrimitiveParam(nodeId, f, v)}
            aria-label={SIZE_ROWS[f].label}
          />
        </div>
      ))}

      {(['radialSegments', 'heightSegments'] as SegField[]).filter(uses).map((f) => (
        <div className={s.row} key={f}>
          <span className={s.label}>{SEG_LABELS[spec.type][f]}</span>
          <ValueField
            value={spec[f]}
            min={3}
            max={256}
            step={1}
            onChange={(v) => setPrimitiveParam(nodeId, f, Math.round(v))}
            aria-label={SEG_LABELS[spec.type][f]}
          />
        </div>
      ))}

      {uses('capped') && (
        <div className={s.row}>
          <span className={s.label}>End Caps</span>
          <Switch
            checked={spec.capped}
            onChange={(e) => setPrimitiveParam(nodeId, 'capped', e.currentTarget.checked)}
            aria-label="End caps"
          />
        </div>
      )}

      <p className={s.hint}>{HINTS[spec.type]}</p>
    </div>
  );
}

export default PrimitiveSection;
