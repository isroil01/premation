/**
 * FaceMaterialsSection — the "Sides" group of Material Options: Front / Bevel /
 * Side / Back colours for an extruded 3D layer (AE's Cinema 4D renderer exposes
 * the same three overrides).
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
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTree, type MirrorTree } from '@hooks/useMirror';
import { mirrorFaceMaterials, mirrorMaterial, mirrorOverlayStyles } from '@core/mirror/layerFacts';
import { mirrorFill } from '@core/mirror/paintFields';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { sortedStops } from '@core/paint/fill';
import { styledSurfaceFill } from '@core/effects/layerStyles';
import { EXTRUSION_WALL_FALLBACK_FILL } from '@core/scene/extrusion';
import type { Command } from '@motion/engine-api';
import {
  nextFaceMaterials,
  DEFAULT_FACE_GAIN,
  type FaceKind,
  type FaceMaterial,
} from '@core/scene/faceMaterials';
import { useFaceSelectionStore } from '@stores/faceSelectionStore';
import { values } from '@core/engine/propRefs';
import { fieldCommands, hasPath } from './materialEdits';
import { useEngineEdit } from './useEngineEdit';
import { TwirlGroup } from './appearance/TwirlGroup';
import styles from './ParentControl.module.css';
import sides from './FaceMaterialsSection.module.css';

type EditableKind = Exclude<FaceKind, 'front'>;

const KINDS: ReadonlyArray<{ kind: EditableKind; label: string; hint: string }> = [
  { kind: 'bevel', label: 'Bevel', hint: 'The chamfer rings — only visible with a bevel depth' },
  { kind: 'side', label: 'Side', hint: 'The extruded walls' },
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
function derivedLayerFill(nodeId: string, tree: MirrorTree | undefined): string {
  const paint = mirrorFill(documentMirror(), nodeId);
  const base = paint?.type === 'solid' ? paint.color : paint ? sortedStops(paint.stops)[0]?.color : undefined;
  const hex = typeof base === 'string' && base.startsWith('#') ? base : EXTRUSION_WALL_FALLBACK_FILL;
  // `#rrggbb` only: the picker's swatch carries no alpha, and the front face's
  // opacity is the layer's, not a face's.
  return styledSurfaceFill(mirrorOverlayStyles(tree), hex).slice(0, 7);
}

/** The layer's overrides after one patch, as the `material/faceMaterials` json write. */
function faceCommands(nodeId: string, kind: EditableKind, patch: FaceMaterial | null): Command[] {
  return fieldCommands([nodeId], 'material/faceMaterials', values.json(nextFaceMaterials(mirrorFaceMaterials(documentMirror(), nodeId), kind, patch)));
}

export function FaceMaterialsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // The header and the property tree (`transform/…` extrusion, `material/*`, fill, styles).
  const layer = useMirrorLayer(nodeId);
  const tree = useMirrorTree(nodeId);
  // B3z: every write is `material/faceMaterials` (a json layer field, the whole
  // overrides object); a colour drag or a brightness scrub is ONE gesture.
  const e = useEngineEdit();
  const faceSel = useFaceSelectionStore();
  const pickMode = faceSel.enabled;
  if (!layer) return null;

  // The STATIC Extrusion Depth (as `readNode3D` reads it). No extrusion → no faces to address.
  const depthRef = trackRefIn(tree, 'extrusionDepth');
  const extrusionDepth = depthRef ? Math.max(0, storedNumber(depthRef, depthRef.info.value) ?? 0) : 0;
  if (!(extrusionDepth > 0)) return null;

  const mats = mirrorFaceMaterials(documentMirror(), nodeId);
  // The canvas picker and these rows are two views of one selection: picking a
  // side on canvas highlights its row, and hovering a row previews nothing else.
  const pickedKind = faceSel.nodeId === nodeId ? faceSel.kind : null;
  const layerFill = derivedLayerFill(nodeId, tree);
  const anyOverride = Object.keys(mats).length > 0;
  // With Accepts Lights on, real per-fragment shading replaces the flat gain, so
  // say so rather than showing a knob that does nothing.
  const lit = mirrorMaterial(tree).acceptsLights;

  return (
    // AE-style "Sides" group (2026-10-07): one twirl row, then Front, Bevel,
    // Side and Back in the order the eye meets them. Each side follows the
    // layer fill (with its brightness) until it is given a colour of its own.
    <TwirlGroup
      prefKey="material.sides"
      label="Sides"
      defaultOpen
      summary={anyOverride ? 'custom colours' : 'follow the fill'}
      trailing={(
        <>
          <Button
            size="xs"
            variant={pickMode ? 'primary' : 'ghost'}
            onClick={() => faceSel.setEnabled(!pickMode)}
            title={pickMode
              ? 'Stop picking faces on canvas — clicks select layers again'
              : 'Click a side of the object on canvas to select it'}
            aria-pressed={pickMode}
            leftIcon={<Icon name="mouse-pointer" size="sm" />}
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
        </>
      )}
    >
      <div className={styles.row}>
        <span className={styles.label}>Front</span>
        <span className={sides.note}>Layer fill</span>
      </div>

      {KINDS.map(({ kind, label, hint }) => {
        const m = mats[kind];
        const custom = typeof m?.fill === 'string';
        const picked = pickedKind === kind;
        const on = (): boolean => hasPath(nodeId, 'material/faceMaterials');
        return (
          <div
            key={kind}
            className={picked ? `${styles.row} ${sides.picked}` : styles.row}
            title={hint}
          >
            <span className={styles.label}>{label}</span>
            <span className={sides.controls} {...e.press(`Set ${label} face colour`, on)}>
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
                  Same as fill
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
        <p className={sides.hint}>
          {pickedKind
            ? `${pickedKind[0]!.toUpperCase()}${pickedKind.slice(1)} face selected — click another side, or Pick again to leave.`
            : 'Click a side of the object on canvas.'}
        </p>
      )}
      {lit && (
        <p className={sides.hint}>
          Scene lights shade these sides: the colours apply, the brightness percentages do not.
        </p>
      )}
    </TwirlGroup>
  );
}
