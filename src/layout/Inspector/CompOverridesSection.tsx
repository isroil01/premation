/**
 * Essential Properties — the instance-side control for a placed composition.
 *
 * AE splits this in two: you promote a property in the source comp, then set it
 * per placement. There is no promotion step here yet, so every source layer
 * offers the whole overridable set (`OVERRIDABLE_PROPS`). That is more surface
 * than AE shows, but it is honest: each field either overrides or it does not,
 * and nothing is offered that the renderer will not read.
 *
 * The value shown when a property is NOT overridden is the INHERITED one — the
 * source layer's own value at the current time, sampled if it is keyframed. So
 * the field always displays what you are actually seeing, and typing into it is
 * what creates the override. A dot marks an overridden property; clicking it
 * clears the override and the field falls back to inherited.
 *
 * An override REPLACES a keyframed value rather than fighting it (AE's rule) —
 * see `compInstanceOverrides.ts` for why that needs two halves and what breaks
 * with only one.
 */

import { ValueField } from '@components/ValueField';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { readCompRef } from '@core/scene/compInstance';
import {
  OVERRIDABLE_PROPS,
  readCompOverrides,
  overrideKey,
  setCompOverride,
  clearCompOverridesFor,
  type OverridableProp,
} from '@core/scene/compInstanceOverrides';
import type { SceneNode } from '@core/types';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';

const LABEL: Record<OverridableProp, string> = {
  x: 'X', y: 'Y', rotation: 'Rotation', scaleX: 'Scale X', scaleY: 'Scale Y', opacity: 'Opacity',
};

/** Sensible identity for a property no component declares. */
const FALLBACK: Record<OverridableProp, number> = {
  x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100,
};

const UNIT: Partial<Record<OverridableProp, string>> = { rotation: '°', opacity: '%' };

/**
 * What this property would be WITHOUT an override: the animated value when the
 * source layer is keyframed, else its stored value.
 *
 * The component scan is last-write-wins, matching `readBase` in buildSnapshot —
 * the same rule `applyOverridesToComponents` targets when it decides which
 * component to patch. Three places agreeing on one rule is the point; if this
 * one drifts the field displays a value the renderer never uses.
 */
function inheritedValue(source: SceneNode, prop: OverridableProp, t: number): number {
  if (defaultAnimation.isAnimated(source.id, prop)) {
    const v = defaultAnimation.sample(source.id, prop, t);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  let found: number | undefined;
  for (const c of source.components) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (typeof v === 'number' && Number.isFinite(v)) found = v;
  }
  return found ?? FALLBACK[prop];
}

export function CompOverridesSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const ref = readCompRef(node);
  if (ref === null) return null;

  // Direct children of the referenced composition.
  //
  // A LISTING limit, not an engine one — a distinction worth stating because it
  // was read the other way round, and "Essential Properties: direct children
  // only" sat on a backlog as though depth needed building. It does not:
  // `cloneSubtree` consults the override map at every node inside an instance
  // and the key is any node id, so a grandchild override already resolves,
  // statically and through the animated half. `compInstanceOverrides.test.ts`
  // ("override depth") asserts that now, rather than leaving it to this comment
  // — a capability nothing exercises is how the opposite claim survived.
  //
  // Kept flat anyway: a list of a whole nested tree is unreadable, and AE's
  // promotion step exists precisely so an instance shows a chosen few rather
  // than everything. Depth belongs here once there is something to choose WITH.
  const sources = defaultSceneGraph.getChildren(ref);
  if (sources.length === 0) return null;

  const overrides = readCompOverrides(node);

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Essential Properties</span>
        <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
          {overrides.size > 0 ? `${overrides.size} overridden` : 'inheriting'}
        </span>
      </div>

      {sources.map((source) => {
        const layerOverrides = OVERRIDABLE_PROPS.filter((p) =>
          overrides.has(overrideKey(source.id, p)));
        return (
          <div key={source.id} style={{ marginBottom: 6 }}>
            <div className={styles.row}>
              <span
                className={styles.label}
                style={{ color: 'var(--color-text-secondary)' }}
                title={source.name ?? source.id}
              >
                {source.name ?? source.id}
              </span>
              {layerOverrides.length > 0 && (
                <button
                  type="button"
                  className={styles.select}
                  style={{ width: 'auto', padding: '0 8px', fontSize: 'var(--font-size-micro)' }}
                  onClick={() => { clearCompOverridesFor(nodeId, source.id); bumpScene(); }}
                  aria-label={`Reset all overrides on ${source.name ?? source.id}`}
                >
                  Reset
                </button>
              )}
            </div>
            {OVERRIDABLE_PROPS.map((prop) => {
              const key = overrideKey(source.id, prop);
              const overridden = overrides.has(key);
              const value = overridden
                ? (overrides.get(key) as number)
                : inheritedValue(source, prop, time);
              return (
                <div className={ta.paramRow} key={prop}>
                  <button
                    type="button"
                    onClick={() => setCompOverride(nodeId, source.id, prop, overridden ? undefined : value)}
                    title={overridden ? 'Clear override (inherit from the source comp)' : 'Override for this instance only'}
                    aria-label={`${overridden ? 'Clear' : 'Set'} ${LABEL[prop]} override on ${source.name ?? source.id}`}
                    style={{
                      width: 14, height: 14, padding: 0, borderRadius: '50%', cursor: 'pointer',
                      border: '1px solid var(--color-border)',
                      background: overridden ? 'var(--color-accent)' : 'transparent',
                    }}
                  />
                  <span className={ta.paramLabel}>{LABEL[prop]}</span>
                  <ValueField
                    value={value}
                    onChange={(v) => setCompOverride(nodeId, source.id, prop, v)}
                    unit={UNIT[prop]}
                    precision={2}
                    aria-label={`${LABEL[prop]} on ${source.name ?? source.id}`}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export default CompOverridesSection;
