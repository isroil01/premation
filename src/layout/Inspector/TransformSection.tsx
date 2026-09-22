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
 * Reads are per NODE revision, so a scrub on an unselected layer does not
 * touch this section, and the section is memoised by its host so a keystroke
 * in the panel's search box does not re-run it.
 */

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { AngleDial } from '@components/AngleDial';
import { Popover } from '@components/Popover';
import { PropertyRowLayoutContext } from '@components/PropertyRow';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, canBe3D } from '@core/scene/threeD';
import { setAnchor, estimateNodeBounds } from '@core/scene/anchor';
import { readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { useNodeRevision } from '@core/inspector/nodeRevision';
import { staticOrDefaultValue } from '@core/inspector/propertyValue';
import { type PropertyAccess } from '@core/inspector/multiSelection';
import { applyTransformPreset, captureTransformPreset } from '@core/inspector/sectionPresets';
import { useThrottledTime } from '@stores/playbackClockStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { batchHistory } from '@stores/historyStore';
import { MultiPropertyRow } from './MultiPropertyRow';
import { MultiPropertyPairRow, type PairFieldSpec } from './MultiPropertyPairRow';
import { SectionPresetMenu } from './SectionPresetMenu';
import { ThreeDControl } from './ThreeDControl';
import { useInspectorSelection } from './inspectorSelection';
import { useCompositionStore } from '@stores/compositionStore';
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

/** Props that live on the Style/Text component rather than the Transform. */
const STYLE_PROPS = new Set(['opacity', 'fillOpacity']);

/**
 * The "More" disclosure's remembered state. Kept in the accordion's own
 * open/closed map rather than component state: this section remounts on every
 * selection change, so component state would snap shut each time a layer is
 * clicked.
 */
const MORE_KEY = 'transform.more';

function hasTransform(nodeId: string): boolean {
  return defaultSceneGraph.getNode(nodeId)?.components.some((c) => c.type === 'Transform') === true;
}

function hasStyle(nodeId: string): boolean {
  return defaultSceneGraph.getNode(nodeId)?.components.some((c) => c.type === 'Style' || c.type === 'Text') === true;
}

/**
 * Per-prop readers, cached by prop so their identity is stable across renders
 * (a `MultiPropertyRow` memoises on `access`).
 *
 * A layer whose Transform never stored `scaleX` still HAS a scale of 1 — the
 * registry default — so the reader answers the default rather than "absent",
 * exactly as the old `typeof raw === 'number' ? raw : 1` fallbacks did. A
 * layer with no Transform component at all (audio) is absent.
 */
const ACCESS = new Map<string, PropertyAccess>();
function accessFor(prop: string): PropertyAccess {
  let a = ACCESS.get(prop);
  if (a) return a;
  const present = STYLE_PROPS.has(prop) ? hasStyle : hasTransform;
  a = { read: (id) => (present(id) ? staticOrDefaultValue(id, prop) : undefined) };
  if (prop === 'anchorX' || prop === 'anchorY') {
    // Anchor writes go through `setAnchor` so the position is compensated
    // and the layer does not jump — the same path the canvas gizmo uses.
    a = {
      ...a,
      writeStatic: (id, v) => {
        if (!hasTransform(id)) return false;
        const ax = prop === 'anchorX' ? v : staticOrDefaultValue(id, 'anchorX');
        const ay = prop === 'anchorY' ? v : staticOrDefaultValue(id, 'anchorY');
        setAnchor(id, ax, ay);
        return true;
      },
    };
  }
  ACCESS.set(prop, a);
  return a;
}

/** One field of a pair row, with the section's reader and an optional unit. */
function field(prop: string, prefix: string, display?: UnitDisplay | null): PairFieldSpec {
  return { prop, prefix, access: accessFor(prop), displayContext: display ?? null };
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

  const capturePreset = useCallback(() => captureTransformPreset(nodeId, time), [nodeId, time]);
  const applyPreset = useCallback(
    (values: Readonly<Record<string, number | string | boolean>>) =>
      applyTransformPreset(effectiveNodeIds, values, { compTime: time, autoKeyframe }),
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
  useNodeRevision(nodeId);
  const nodeIds = useInspectorSelection(nodeId);
  const node = defaultSceneGraph.getNode(nodeId);
  const [linkedScale, setLinkedScale] = useState(true);
  const [anchorMenuOpen, setAnchorMenuOpen] = useState(false);
  // Position / Anchor units (px | %), remembered across mounts.
  const [units, setUnits] = useState<TransformUnits>(loadTransformUnits);
  const compW = useCompositionStore((s) => s.width);
  const compH = useCompositionStore((s) => s.height);
  const moreRemembered = usePreferenceStore((s) => s.inspectorSections[MORE_KEY]);
  const setPref = usePreferenceStore((s) => s.set);

  // NO early return before the hooks below — the hook count must not depend
  // on whether the node exists (deleting a selected layer with this panel open
  // used to throw "Rendered fewer hooks than expected").
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Transform'), [node]);
  const sComp = useMemo(() => node?.components.find((c) => c.type === 'Style' || c.type === 'Text'), [node]);

  const rotationDial = useCallback(
    (label: string) => ({ value, setValue }: { value: number; setValue: (v: number) => void }): ReactNode => (
      <AngleDial value={value} onChange={setValue} aria-label={`${label} dial`} />
    ),
    [],
  );

  // Single render guard, AFTER every hook.
  if (!node || !tComp) return null;

  const read = (prop: string): number => staticOrDefaultValue(nodeId, prop);
  const widthVal = tComp.props.width;
  const heightVal = tComp.props.height;
  const hasSize = typeof widthVal === 'number' && typeof heightVal === 'number';

  const row = (prop: string): JSX.Element => (
    <MultiPropertyRow
      key={prop}
      nodeId={nodeId}
      prop={prop}
      access={accessFor(prop)}
      renderBefore={ROTATION_PROPS.has(prop) ? rotationDial(prop) : undefined}
    />
  );

  const kind = readNodeKind(node);
  const is3D = is3DEnabled(node);
  const isCamera = kind === 'camera';
  const isLight = kind === 'light';
  const hasDepth = isCamera || isLight || is3D;
  // A camera or a light is a point in space, not artwork: the renderer reads
  // its position (and a light's rotation, which aims it) and nothing else here.
  // Scale, Size, Opacity, Anchor, Skew and Fill Opacity were all offered for
  // them, all editable and keyframeable, and all did nothing — six dead rows
  // above the Camera / Light settings that do the real work.
  const isDevice = isCamera || isLight;
  const threeDEligible = kind !== 'group' && kind !== 'null' && canBe3D(node);

  const anyAnimated = (props: string[]): boolean => props.some((p) => defaultAnimation.isAnimated(nodeId, p));

  // Interactive 3x3 anchor snapping, applied to every selected layer against
  // its OWN bounds — one undo entry for the lot.
  const bounds = hasSize ? { width: widthVal, height: heightVal } : estimateNodeBounds(nodeId);
  const anchorX = read('anchorX');
  const anchorY = read('anchorY');

  const applyAnchorPreset = (preset: typeof ANCHOR_PRESETS[number]): void => {
    batchHistory(`anchorPreset:${preset.id}:${nodeIds.join(',')}`, () => {
      for (const id of nodeIds) {
        const n = defaultSceneGraph.getNode(id);
        const t = n?.components.find((c) => c.type === 'Transform');
        if (!n || !t) continue;
        const w = t.props.width;
        const h = t.props.height;
        const b = typeof w === 'number' && typeof h === 'number' ? { width: w, height: h } : estimateNodeBounds(id);
        const target = preset.getOffset(b.width, b.height);
        setAnchor(id, target.x, target.y);
      }
    });
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

          {sComp && !isDevice && row('opacity')}

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
              {sComp && row('fillOpacity')}
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
