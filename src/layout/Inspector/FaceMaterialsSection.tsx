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
import { Button } from '@components/Button';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNode3D } from '@core/scene/threeD';
import { readNodeMaterial } from '@core/scene/material';
import { readNodeFill, sortedStops } from '@core/paint/fill';
import { readNodeLayerStyles, styledSurfaceFill } from '@core/effects/layerStyles';
import { EXTRUSION_WALL_FALLBACK_FILL } from '@core/scene/extrusion';
import type { SceneNode } from '@core/types';
import type { Command } from '@motion/engine-api';
import {
  getNodeFaceMaterials,
  nextFaceMaterials,
  DEFAULT_FACE_GAIN,
  type FaceKind,
  type FaceMaterial,
} from '@core/scene/faceMaterials';
import { useFaceSelectionStore } from '@stores/faceSelectionStore';
import { values } from '@core/engine/propRefs';
import { fieldCommands, hasPath } from './materialEdits';
import { useEngineEdit } from './useEngineEdit';
import styles from './ParentControl.module.css';

type EditableKind = Exclude<FaceKind, 'front'>;

const KINDS: ReadonlyArray<{ kind: EditableKind; label: string; hint: string }> = [
  { kind: 'side', label: 'Side', hint: 'The extruded walls' },
  { kind: 'bevel', label: 'Bevel', hint: 'The chamfer rings — only visible with a bevel depth' },
  { kind: 'back', label: 'Back', hint: 'The rear cap' },
];

/**
 * The colour a face without a fill of its own is shaded FROM — what the
 * renderer hands `resolveFaceMaterial` as `layerFill` (buildSnapshot's
 * `wallFill`), reduced to one `#rrggbb` for the swatch.
 *
 * A gradient has no single colour; the renderer samples it per face, so any
 * one swatch is an approximation. The FIRST stop is the one the user set the
 * gradient from and the one a solid conversion keeps, which makes it the
 * honest stand-in. It used to fall through to a hard-coded blue, so the
 * Side/Bevel/Back rows previewed a colour that appeared nowhere on canvas.
 *
 * With no fill at all this is the renderer's own wall fallback, so the rows
 * still show what would actually draw — never a colour invented here. Layer
 * styles are applied the way the renderer applies them: a Colour or Gradient
 * Overlay repaints the front face and every derived face with it.
 */
function derivedLayerFill(node: SceneNode): string {
  const paint = readNodeFill(node);
  const base = paint?.type === 'solid' ? paint.color : paint ? sortedStops(paint.stops)[0]?.color : undefined;
  const hex = typeof base === 'string' && base.startsWith('#') ? base : EXTRUSION_WALL_FALLBACK_FILL;
  // `#rrggbb` only: the picker's swatch carries no alpha, and the front face's
  // opacity is the layer's, not a face's.
  return styledSurfaceFill(readNodeLayerStyles(node), hex).slice(0, 7);
}

/** The layer's overrides after one patch, as the `material/faceMaterials` json write. */
function faceCommands(nodeId: string, kind: EditableKind, patch: FaceMaterial | null): Command[] {
  return fieldCommands([nodeId], 'material/faceMaterials', values.json(nextFaceMaterials(getNodeFaceMaterials(nodeId), kind, patch)));
}

export function FaceMaterialsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  // B3z: every write is `material/faceMaterials` (a json layer field, the whole
  // overrides object); a colour drag or a brightness scrub is ONE gesture.
  const e = useEngineEdit();
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
  const layerFill = derivedLayerFill(node);
  const anyOverride = Object.keys(mats).length > 0;
  // With Accepts Lights on, real per-fragment shading replaces the flat gain, so
  // say so rather than showing a knob that does nothing.
  const lit = readNodeMaterial(node).acceptsLights;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--font-size-micro)', fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Face Materials
        </span>
        <Button
          size="xs"
          variant={pickMode ? 'primary' : 'ghost'}
          onClick={() => faceSel.setEnabled(!pickMode)}
          title={pickMode
            ? 'Stop picking faces on canvas — clicks select layers again'
            : 'Click a side of the object on canvas to select it'}
          aria-pressed={pickMode}
          leftIcon={<Icon name="mouse-pointer" size="sm" />}
          style={{ marginRight: 'auto', marginLeft: 8 }}
        >
          Pick
        </Button>
        {anyOverride && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => e.send('Reset Face Materials', fieldCommands([nodeId], 'material/faceMaterials', values.json(null)))}
            title="Back to one colour for the whole object"
          >
            Reset
          </Button>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.label} style={{ fontSize: 'var(--font-size-xs)', opacity: 0.7 }}>Front</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
          <Icon name="arrow-up" size="sm" /> layer fill
        </span>
      </div>

      {KINDS.map(({ kind, label, hint }) => {
        const m = mats[kind];
        const custom = typeof m?.fill === 'string';
        const picked = pickedKind === kind;
        const on = (): boolean => hasPath(nodeId, 'material/faceMaterials');
        return (
          <div
            key={kind}
            className={styles.row}
            title={hint}
            style={picked
              ? { background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)', borderRadius: 4, boxShadow: 'inset 2px 0 0 var(--color-accent)' }
              : undefined}
          >
            <span className={styles.label} style={{ fontSize: 'var(--font-size-xs)', fontWeight: picked ? 600 : undefined }}>{label}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }} {...e.press(`Set ${label} face colour`, on)}>
              <ColorPicker
                compact
                value={custom ? m!.fill! : layerFill}
                onChange={(hex) => e.send(`Set ${label} face colour`, faceCommands(nodeId, kind, { fill: hex }))}
                aria-label={`${label} face color`}
              />
              {custom ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => e.send(`Reset ${label} face colour`, faceCommands(nodeId, kind, null))}
                  title={`Track the layer fill again instead of a fixed ${label.toLowerCase()} colour`}
                  aria-label={`Reset ${label.toLowerCase()} face colour`}
                >
                  <Icon name="close" size="sm" />
                </Button>
              ) : (
                // Derived from the layer fill: the gain is what shades it.
                <ValueField
                  value={Math.round((typeof m?.gain === 'number' ? m.gain : DEFAULT_FACE_GAIN[kind]) * 100)}
                  unit="%"
                  min={0}
                  max={200}
                  onChange={(v) => e.send(`Set ${label} face brightness`, faceCommands(nodeId, kind, { gain: Number(v) / 100 }))}
                  {...e.scrub(`Set ${label} face brightness`, on)}
                  aria-label={`${label} face brightness`}
                />
              )}
            </span>
          </div>
        );
      })}

      {pickMode && (
        <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-accent)', lineHeight: 1.5 }}>
          {pickedKind
            ? `${pickedKind[0]!.toUpperCase()}${pickedKind.slice(1)} face selected — click another side, or Pick again to leave.`
            : 'Click a side of the object on canvas.'}
        </p>
      )}
      <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
        {lit
          ? 'Accepts Lights is on, so scene lights shade these faces — the colours still apply, the brightness percentages do not.'
          : 'Pick a colour to fix a face, or set a brightness to keep it tracking the layer fill.'}
      </p>
    </div>
  );
}
