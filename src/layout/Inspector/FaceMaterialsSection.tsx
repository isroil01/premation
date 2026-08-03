/**
 * FaceMaterialsSection — Front / Side / Bevel / Back colours for an extruded 3D
 * layer (AE's Cinema 4D renderer exposes the same three overrides).
 *
 * Shown only when the layer is actually extruded, because with `extrusionDepth`
 * 0 there are no side or back faces to colour and the controls would be inert.
 *
 * FRONT is deliberately not editable here: the front face IS the layer, so its
 * colour is the layer's own fill in the Appearance section. Duplicating it would
 * put one property in two places — the exact problem the inspector already had
 * too much of.
 */

import { ColorPicker } from '@components/ColorPicker';
import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNode3D } from '@core/scene/threeD';
import { readNodeMaterial } from '@core/scene/material';
import {
  getNodeFaceMaterials,
  setNodeFaceMaterial,
  clearNodeFaceMaterials,
  DEFAULT_FACE_GAIN,
  type FaceKind,
} from '@core/scene/faceMaterials';
import { useFaceSelectionStore } from '@stores/faceSelectionStore';
import styles from './ParentControl.module.css';

type EditableKind = Exclude<FaceKind, 'front'>;

const KINDS: ReadonlyArray<{ kind: EditableKind; label: string; hint: string }> = [
  { kind: 'side', label: 'Side', hint: 'The extruded walls' },
  { kind: 'bevel', label: 'Bevel', hint: 'The chamfer rings — only visible with a bevel depth' },
  { kind: 'back', label: 'Back', hint: 'The rear cap' },
];

export function FaceMaterialsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const faceSel = useFaceSelectionStore();
  const pickMode = faceSel.enabled;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const d3 = readNode3D(node);
  // No extrusion → no faces to address.
  if (!(d3.extrusionDepth > 0)) return null;

  const mats = getNodeFaceMaterials(nodeId);
  // The canvas picker and these rows are two views of one selection: picking a
  // side on canvas highlights its row, and hovering a row previews nothing else.
  const pickedKind = faceSel.nodeId === nodeId ? faceSel.kind : null;
  const layerFill = (() => {
    const c = node.components.find((x) => x.type === 'Style' || x.type === 'Text');
    const f = c?.props.fill;
    return typeof f === 'string' && f.startsWith('#') ? f.slice(0, 7) : '#2b7eff';
  })();
  const anyOverride = Object.keys(mats).length > 0;
  // With Accepts Lights on, real per-fragment shading replaces the flat gain, so
  // say so rather than showing a knob that does nothing.
  const lit = readNodeMaterial(node).acceptsLights;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Face Materials
        </span>
        <button
          type="button"
          onClick={() => faceSel.setEnabled(!pickMode)}
          title={pickMode
            ? 'Stop picking faces on canvas — clicks select layers again'
            : 'Click a side of the object on canvas to select it'}
          aria-pressed={pickMode}
          style={{
            height: 18, padding: '0 6px', marginRight: 'auto', marginLeft: 8,
            display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10,
            background: pickMode ? 'var(--color-accent)' : 'var(--color-surface-0)',
            color: pickMode ? '#fff' : 'var(--color-text-tertiary)',
            border: '1px solid var(--color-border-subtle)', borderRadius: 4, cursor: 'pointer',
          }}
        >
          <Icon name="mouse-pointer" size={9} /> Pick
        </button>
        {anyOverride && (
          <button
            type="button"
            onClick={() => clearNodeFaceMaterials(nodeId)}
            title="Back to one colour for the whole object"
            style={{ height: 18, padding: '0 6px', fontSize: 10, background: 'var(--color-surface-0)', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-subtle)', borderRadius: 4, cursor: 'pointer' }}
          >
            Reset
          </button>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.label} style={{ fontSize: 11, opacity: 0.7 }}>Front</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          <Icon name="arrow-up" size={10} /> layer fill
        </span>
      </div>

      {KINDS.map(({ kind, label, hint }) => {
        const m = mats[kind];
        const custom = typeof m?.fill === 'string';
        const picked = pickedKind === kind;
        return (
          <div
            key={kind}
            className={styles.row}
            title={hint}
            style={picked
              ? { background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)', borderRadius: 4, boxShadow: 'inset 2px 0 0 var(--color-accent)' }
              : undefined}
          >
            <span className={styles.label} style={{ fontSize: 11, fontWeight: picked ? 600 : undefined }}>{label}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ColorPicker
                compact
                value={custom ? m!.fill! : layerFill}
                onChange={(hex) => setNodeFaceMaterial(nodeId, kind, { fill: hex })}
                aria-label={`${label} face color`}
              />
              {custom ? (
                <button
                  type="button"
                  onClick={() => setNodeFaceMaterial(nodeId, kind, null)}
                  title={`Track the layer fill again instead of a fixed ${label.toLowerCase()} colour`}
                  style={{ height: 18, width: 18, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--color-text-tertiary)', border: 'none', cursor: 'pointer' }}
                >
                  <Icon name="close" size={10} />
                </button>
              ) : (
                // Derived from the layer fill: the gain is what shades it.
                <ValueField
                  value={Math.round((typeof m?.gain === 'number' ? m.gain : DEFAULT_FACE_GAIN[kind]) * 100)}
                  unit="%"
                  min={0}
                  max={200}
                  onChange={(v) => setNodeFaceMaterial(nodeId, kind, { gain: Number(v) / 100 })}
                  aria-label={`${label} face brightness`}
                />
              )}
            </span>
          </div>
        );
      })}

      {pickMode && (
        <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--color-accent)', lineHeight: 1.5 }}>
          {pickedKind
            ? `${pickedKind[0]!.toUpperCase()}${pickedKind.slice(1)} face selected — click another side, or Pick again to leave.`
            : 'Click a side of the object on canvas.'}
        </p>
      )}
      <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
        {lit
          ? 'Accepts Lights is on, so scene lights shade these faces — the colours still apply, the brightness percentages do not.'
          : 'Pick a colour to fix a face, or set a brightness to keep it tracking the layer fill.'}
      </p>
    </div>
  );
}
