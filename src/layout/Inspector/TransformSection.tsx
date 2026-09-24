/**
 * TransformSection — position, scale, size, rotation, opacity, anchor and a
 * collapsed "More" (skew, fill opacity, 3D), as a compact property list.
 *
 * Every numeric row reads the property across the WHOLE selection, shows `—`
 * where the layers disagree, writes every layer on a typed value, offsets every
 * layer on a drag, and records one undo entry per gesture (2026-09-04).
 *
 * LAYOUT (2026-09-15). Two-axis properties are ONE row — `Position [X][Y]` —
 * through `MultiPropertyPairRow`, whose group stopwatch replaced the uppercase
 * subheads and their per-group stopwatch buttons. The old section spent five
 * controls per property on seven groups plus an always-visible 3×3 anchor
 * matrix, truncated "X"/"Y" at the default panel width and scrolled before it
 * reached Rotation; users called it "too many buttons". Order follows use:
 * the properties people touch constantly first, anchor after them, and the
 * rarely-touched ones behind "More".
 *
 * Units: the px / % switch for Position and Anchor sits in the row's hover
 * tray (label cell), not as a button beside the label. At rest the field's own
 * unit suffix already says which unit is live, so a permanent switch would be
 * one more control on every glance for a choice made once; the right-click
 * menu was the other candidate, but a unit is a view setting of the ROW, not
 * of one of its properties, and the menu is per property.
 *
 * Reads come from the document MIRROR (B4) and the section subscribes to its
 * layer's header and the few properties it reads itself (anchor, size, the
 * "More" triggers) — the rows subscribe to their own — so a scrub on an
 * unselected layer does not touch this section, and the section is memoised by its host so a keystroke
 * in the panel's search box does not re-run it.
 */

import { memo, useCallback, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { AngleDial } from '@components/AngleDial';
import { Popover } from '@components/Popover';
import { PropertyRowLayoutContext } from '@components/PropertyRow';
import { TRANSFORM_PRESET_PROPS } from '@core/inspector/sectionPresets';
import type { PresetValues } from '@stores/sectionPresetStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTrackWatch } from '@hooks/useMirror';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { uiKindOf } from '@core/mirror/layerKinds';
import { useThrottledTime } from '@stores/playbackClockStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { MultiPropertyRow } from './MultiPropertyRow';
import { MultiPropertyPairRow, type PairFieldSpec } from './MultiPropertyPairRow';
import { SectionPresetMenu } from './SectionPresetMenu';
import { ThreeDControl } from './ThreeDControl';
import { useInspectorSelection } from './inspectorSelection';
import { canBe3DLayer, inspectorKindOf, useActiveCompSize } from './inspectorMirror';
import { edit } from '@core/engine/uiEdits';
import { applyPresetValues, trackWrites } from './inspectorEdits';
import {
  anchorPercentDisplay,
  loadTransformUnits,
  positionPercentDisplay,
  saveTransformUnits,
  type TransformUnits,
  type UnitDisplay,
} from '@core/scene/transformUnits';

import styles from './TransformSection.module.css';

/** Rotation-flavored props get a purpose-built dial next to their number —
 *  the dial writes through the SAME path as the ValueField, so keyframing,
 *  auto-key and multi-selection behaviour are identical. */
const ROTATION_PROPS = new Set([
  'rotation',
  'rotationX',
  'rotationY',
]);

const ANCHOR_PRESETS: Array<{ id: string; label: string; getOffset: (w: number, h: number) => { x: number; y: number } }> = [
  { id: 'tl', label: 'Top Left', getOffset: (w: number, h: number) => ({ x: -w / 2, y: -h / 2 }) },
  { id: 'tc', label: 'Top Center', getOffset: (_w: number, h: number) => ({ x: 0, y: -h / 2 }) },
  { id: 'tr', label: 'Top Right', getOffset: (w: number, h: number) => ({ x: w / 2, y: -h / 2 }) },
  { id: 'ml', label: 'Middle Left', getOffset: (w: number, _h: number) => ({ x: -w / 2, y: 0 }) },
  { id: 'mc', label: 'Center', getOffset: (_w: number, _h: number) => ({ x: 0, y: 0 }) },
  { id: 'mr', label: 'Middle Right', getOffset: (w: number, _h: number) => ({ x: w / 2, y: 0 }) },
  { id: 'bl', label: 'Bottom Left', getOffset: (w: number, h: number) => ({ x: -w / 2, y: h / 2 }) },
  { id: 'bc', label: 'Bottom Center', getOffset: (_w: number, h: number) => ({ x: 0, y: h / 2 }) },
  { id: 'br', label: 'Bottom Right', getOffset: (w: number, h: number) => ({ x: w / 2, y: h / 2 }) },
];

/**
 * The "More" disclosure's remembered state. Kept in the accordion's own
 * open/closed map rather than component state: this section remounts on every
 * selection change, so component state would snap shut each time a layer is
 * clicked.
 */
const MORE_KEY = 'transform.more';

/**
 * The properties this section reads itself (the rows read their own): the
 * anchor for the 3×3 preset highlight, the size for the preset targets, and
 * what opens "More". Every value comes from the document MIRROR — the API's
 * tree carries a layer's registry defaults (a Transform that never stored
 * `scaleX` still reads 100 %), and a property the layer does not have is not
 * in its tree, so its row is not drawn.
 *
 * Writes go through the engine API (B3): an Anchor Point edit is
 * `setProperty(transform/anchorPoint)` — AE's numeric anchor edit, which
 * moves the pivot and leaves Position alone (what `setAnchor` did).
 */
const SECTION_TRACKS: readonly string[] = ['anchorX', 'anchorY', 'width', 'height', 'opacity', 'fillOpacity', 'skew', 'skewAxis'];

/** One field of a pair row, with an optional display unit. */
function field(prop: string, prefix: string, display?: UnitDisplay | null): PairFieldSpec {
  return { prop, prefix, displayContext: display ?? null };
}

/** The layer's stored Size (width/height) when it has one — text and nulls have none. */
function sizeOf(nodeId: string, time: number): { width: number; height: number } | null {
  const m = documentMirror();
  const tree = m.tree(nodeId);
  if (!trackRefIn(tree, 'width') || !trackRefIn(tree, 'height')) return null;
  const width = readTrack(m, nodeId, 'width', time) ?? 0;
  const height = readTrack(m, nodeId, 'height', time) ?? 0;
  const animated = isTrackAnimated(m, nodeId, 'width') || isTrackAnimated(m, nodeId, 'height');
  // A text layer's tree lists a 0 × 0 box size it never stored.
  return width > 0 || height > 0 || animated ? { width, height } : null;
}

/**
 * The box an anchor preset snaps against when the layer has no live Size (the
 * twin of `anchor.estimateNodeBounds`): its stored width × height, else the
 * kind's heuristic (text 300 × 50, anything else 100 × 100).
 */
function estimatedBounds(nodeId: string): { width: number; height: number } {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer) return { width: 100, height: 100 };
  const tree = m.tree(nodeId);
  const w = trackRefIn(tree, 'width');
  const h = trackRefIn(tree, 'height');
  // A text layer's tree lists a 0 × 0 box it never stored — its heuristic wins.
  if (w && h && uiKindOf(layer) !== 'text') {
    const width = storedNumber(w, w.info.value);
    const height = storedNumber(h, h.info.value);
    if (width !== undefined && height !== undefined) return { width, height };
  }
  return uiKindOf(layer) === 'text' ? { width: 300, height: 50 } : { width: 100, height: 100 };
}

/** Every transform preset property the layer has, at `time` (stored units). */
function captureTransformValues(nodeId: string, time: number): PresetValues {
  const m = documentMirror();
  const out: Record<string, number> = {};
  for (const prop of TRANSFORM_PRESET_PROPS) {
    const v = readTrack(m, nodeId, prop, time);
    if (v !== undefined) out[prop] = v;
  }
  return out;
}

export function TransformPresetAction({
  nodeId,
  nodeIds,
}: {
  nodeId: string;
  nodeIds?: ReadonlyArray<string>;
}): JSX.Element {
  const time = useThrottledTime();
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const targetIds = useInspectorSelection(nodeId);
  const effectiveNodeIds = nodeIds && nodeIds.length > 0 ? nodeIds : targetIds;

  const capturePreset = useCallback(() => captureTransformValues(nodeId, time), [nodeId, time]);
  const applyPreset = useCallback(
    (values: Readonly<Record<string, number | string | boolean>>) =>
      applyPresetValues(effectiveNodeIds, values, { seconds: time, autoKeyframe }, 'Apply Transform preset'),
    [effectiveNodeIds, time, autoKeyframe],
  );

  return (
    <SectionPresetMenu
      sectionId="transform"
      label="Transform presets"
      capture={capturePreset}
      apply={applyPreset}
    />
  );
}

function TransformSectionInner({ nodeId }: { nodeId: string }): JSX.Element | null {
  const layer = useMirrorLayer(nodeId);
  useMirrorTrackWatch([nodeId], SECTION_TRACKS);
  const nodeIds = useInspectorSelection(nodeId);
  const [linkedScale, setLinkedScale] = useState(true);
  const [anchorMenuOpen, setAnchorMenuOpen] = useState(false);
  // Position / Anchor units (px | %), remembered across mounts.
  const [units, setUnits] = useState<TransformUnits>(loadTransformUnits);
  const { width: compW, height: compH } = useActiveCompSize();
  const moreRemembered = usePreferenceStore((s) => s.inspectorSections[MORE_KEY]);
  const setPref = usePreferenceStore((s) => s.set);
  const time = useThrottledTime();

  // NO early return before the hooks below — the hook count must not depend
  // on whether the node exists (deleting a selected layer with this panel open
  // used to throw "Rendered fewer hooks than expected").

  const rotationDial = useCallback(
    (label: string) => ({ value, setValue }: { value: number; setValue: (v: number) => void }): ReactNode => (
      <AngleDial value={value} onChange={setValue} aria-label={`${label} dial`} />
    ),
    [],
  );

  // Single render guard, AFTER every hook.
  const m = documentMirror();
  const tree = layer ? m.tree(nodeId) : undefined;
  if (!layer || !trackRefIn(tree, 'x')) return null;

  const read = (prop: string): number => readTrack(m, nodeId, prop, time) ?? 0;
  const size = sizeOf(nodeId, time);
  const hasSize = size !== null;
  // Opacity / Fill Opacity live on the Style or Text component: present only there.
  const hasOpacity = trackRefIn(tree, 'opacity') !== null;
  const hasFillOpacity = trackRefIn(tree, 'fillOpacity') !== null;

  const row = (prop: string): JSX.Element => (
    <MultiPropertyRow
      key={prop}
      nodeId={nodeId}
      prop={prop}
      renderBefore={ROTATION_PROPS.has(prop) ? rotationDial(prop) : undefined}
    />
  );

  const kind = inspectorKindOf(nodeId);
  const is3D = layer.switches.threeD;
  const isCamera = kind === 'camera';
  const isLight = kind === 'light';
  const hasDepth = isCamera || isLight || is3D;
  // A camera or a light is a point in space, not artwork: the renderer reads
  // its position (and a light's rotation, which aims it) and nothing else here.
  // Scale, Size, Opacity, Anchor, Skew and Fill Opacity were all offered for
  // them, all editable and keyframeable, and all did nothing — six dead rows
  // above the Camera / Light settings that do the real work.
  const isDevice = isCamera || isLight;
  const threeDEligible = kind !== 'group' && kind !== 'null' && canBe3DLayer(nodeId);

  const anyAnimated = (props: string[]): boolean => props.some((p) => isTrackAnimated(m, nodeId, p));

  // Interactive 3x3 anchor snapping, applied to every selected layer against
  // its OWN bounds — one undo entry for the lot.
  // A layer with no live Size snaps against the estimate `anchor.estimateNodeBounds` has always used.
  const bounds = size ?? estimatedBounds(nodeId);
  const anchorX = read('anchorX');
  const anchorY = read('anchorY');

  const applyAnchorPreset = (preset: typeof ANCHOR_PRESETS[number]): void => {
    // One entry for the lot; each layer snaps against its OWN bounds.
    const mm = documentMirror();
    const writes = nodeIds.flatMap((id) => {
      if (!mm.layer(id) || !trackRefIn(mm.tree(id), 'anchorX')) return [];
      const b = sizeOf(id, time) ?? estimatedBounds(id);
      const target = preset.getOffset(b.width, b.height);
      return trackWrites(id, { anchorX: target.x, anchorY: target.y }, time);
    });
    if (writes.length > 0) void edit('Set Anchor Point', { type: 'setProperties', writes });
  };

  const isPresetActive = (preset: typeof ANCHOR_PRESETS[number]): boolean => {
    const target = preset.getOffset(bounds.width, bounds.height);
    return Math.abs(anchorX - target.x) < 1.5 && Math.abs(anchorY - target.y) < 1.5;
  };

  // Units switch on Position (px | % of composition) and Anchor Point (px | %
  // of layer). Scale has none — it is already a percentage.
  const unitToggle = (key: keyof TransformUnits, label: string, ofWhat: string): JSX.Element => {
    const pct = units[key] === '%';
    return (
      <button
        type="button"
        className={`${styles.lockToggle} ${pct ? styles.lockToggleActive : ''}`}
        title={pct ? `${label} shown as % of ${ofWhat} — switch to pixels` : `${label} shown in pixels — switch to % of ${ofWhat}`}
        aria-label={`${label} units: ${pct ? `percent of ${ofWhat}` : 'pixels'}`}
        aria-pressed={pct}
        onClick={(e) => {
          e.stopPropagation();
          const next: TransformUnits = { ...units, [key]: pct ? 'px' : '%' };
          setUnits(next);
          saveTransformUnits(next);
        }}
      >
        {pct ? '%' : 'px'}
      </button>
    );
  };
  const posX = units.position === '%' ? positionPercentDisplay(compW) : null;
  const posY = units.position === '%' ? positionPercentDisplay(compH) : null;
  const ancX = units.anchor === '%' ? anchorPercentDisplay(bounds.width) : null;
  const ancY = units.anchor === '%' ? anchorPercentDisplay(bounds.height) : null;

  // The 3×3 snap matrix, one click away instead of always on screen: it is a
  // set-once control, and at rest it was the tallest thing in the section.
  const anchorPresets = (
    <Popover
      open={anchorMenuOpen}
      onOpenChange={setAnchorMenuOpen}
      placement="bottom-end"
      className={styles.anchorPopover}
      // A plain button, not `IconButton`: IconButton wraps itself in a Radix
      // Tooltip that throws without a `TooltipProvider`, and this section is
      // mounted provider-less by its own suites and the playback render-budget
      // test. A section must not start requiring an app-root provider just to
      // draw one trigger.
      trigger={(
        <button
          type="button"
          className={styles.anchorButton}
          data-open={anchorMenuOpen || undefined}
          aria-label="Anchor presets"
          aria-haspopup="true"
          aria-expanded={anchorMenuOpen}
          title="Snap anchor to a corner, edge or the centre"
        >
          <Icon name="grid" size="sm" />
        </button>
      )}
    >
      <div
        className={styles.anchorOriginBox}
        title="Quick Snap Anchor Origin (3x3 Matrix)"
        role="group"
        aria-label="Anchor Origin Matrix"
      >
        {ANCHOR_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`${styles.anchorDot} ${isPresetActive(p) ? styles.anchorDotActive : ''}`}
            title={p.label}
            aria-label={`Snap anchor to ${p.label}`}
            aria-pressed={isPresetActive(p)}
            onClick={() => {
              applyAnchorPreset(p);
              setAnchorMenuOpen(false);
            }}
          />
        ))}
      </div>
    </Popover>
  );

  // Closed by default — unless something in it is live, so an animated skew
  // or a 3D layer's controls are never hidden on first sight.
  const moreOpen = moreRemembered ?? (is3D || anyAnimated(['skew', 'skewAxis', 'fillOpacity']));
  const toggleMore = (): void => {
    setPref('inspectorSections', { ...usePreferenceStore.getState().inspectorSections, [MORE_KEY]: !moreOpen });
  };

  return (
    // Every row in this section draws the compact inspector layout, wherever
    // the section is mounted — a pair row and a single row must share a grid.
    <PropertyRowLayoutContext.Provider value="inspector">
      <div className={styles.section}>
        <div className={styles.rows}>
          <MultiPropertyPairRow
            nodeId={nodeId}
            label="Position"
            props={[field('x', 'X', posX), field('y', 'Y', posY), ...(hasDepth ? [field('z', 'Z')] : [])]}
            trailing={unitToggle('position', 'Position', 'composition')}
          />

          {!isDevice && (
            <MultiPropertyPairRow
              nodeId={nodeId}
              label="Scale"
              props={[field('scaleX', 'W'), field('scaleY', 'H')]}
              linked={{ value: linkedScale, onToggle: () => setLinkedScale((v) => !v), label: 'Scale dimensions' }}
            />
          )}

          {hasSize && !isDevice && (
            <MultiPropertyPairRow
              nodeId={nodeId}
              label="Size"
              props={[field('width', 'W'), field('height', 'H')]}
            />
          )}

          {row('rotation')}

          {hasOpacity && !isDevice && row('opacity')}

          {!isDevice && (
            <MultiPropertyPairRow
              nodeId={nodeId}
              label="Anchor"
              srLabel="Anchor Point"
              props={[field('anchorX', 'X', ancX), field('anchorY', 'Y', ancY), ...(is3D ? [field('anchorZ', 'Z')] : [])]}
              trailing={unitToggle('anchor', 'Anchor Point', 'layer')}
              after={anchorPresets}
            />
          )}

          {!isDevice && (<button
            type="button"
            className={styles.moreToggle}
            aria-expanded={moreOpen}
            onClick={toggleMore}
          >
            <Icon name={moreOpen ? 'chevron-down' : 'chevron-right'} size="sm" />
            More
          </button>)}
          {moreOpen && !isDevice && (
            <div className={styles.moreBody}>
              {row('skew')}
              {row('skewAxis')}
              {hasFillOpacity && row('fillOpacity')}
              {threeDEligible && (
                <ThreeDControl nodeId={nodeId}>
                  {is3D && (
                    <>
                      {row('rotationX')}
                      {row('rotationY')}
                      <MultiPropertyPairRow
                        nodeId={nodeId}
                        label="Orientation"
                        props={[field('orientationX', 'X'), field('orientationY', 'Y'), field('orientationZ', 'Z')]}
                      />
                    </>
                  )}
                </ThreeDControl>
              )}
            </div>
          )}
        </div>
      </div>
    </PropertyRowLayoutContext.Provider>
  );
}


/*
 * Memoized: the Properties panel re-renders for its own reasons (a selection
 * change, a sub-tab switch, the sticky header) and hands every section the
 * same `nodeId` it had before. Without this boundary the section would rebuild
 * its whole subtree on each of those, undoing the per-node subscriptions the
 * rows inside it use to stay asleep. Pinned by `inspectorRenderScope.test.tsx`.
 */
export const TransformSection = memo(TransformSectionInner);

export default TransformSection;
