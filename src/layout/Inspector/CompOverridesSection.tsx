/**
 * Essential Properties — the instance-side control for a placed composition.
 *
 * AE splits this in two: you promote a property in the source comp, then set it
 * per placement. Promotion lives on the source root (`__essentialProps`); right-
 * click a property in the source inspector → "Add to Essential Properties".
 *
 * When the source has published at least one property, this panel lists only
 * those (any depth — the engine already resolves grandchild overrides). When
 * none are published yet, it keeps the pre-promotion fallback: every overridable
 * prop on each direct child, so existing projects keep working.
 *
 * The set is no longer numeric-only, so a row's editor depends on the property's
 * KIND (`OVERRIDE_PROP_KINDS`): a number field, a colour picker, or a text
 * input. Reading the inherited value differs by kind too — see `inheritedValue`,
 * where colour is the awkward case because it is stored as a hex string but
 * animated as three separate channels.
 */

import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Input } from '@components/Input';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { readCompRef } from '@core/scene/compInstance';
import {
  OVERRIDABLE_PROPS,
  readCompOverrides,
  readEssentialProps,
  overrideKey,
  parseOverrideKey,
  setCompOverride,
  clearCompOverridesFor,
  isOverridableProp,
  OVERRIDE_PROP_KINDS,
  type OverridableProp,
  type OverrideValue,
} from '@core/scene/compInstanceOverrides';
import type { SceneNode } from '@core/types';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';

const LABEL: Record<OverridableProp, string> = {
  x: 'X', y: 'Y', rotation: 'Rotation', scaleX: 'Scale X', scaleY: 'Scale Y', opacity: 'Opacity',
  text: 'Source Text', fill: 'Fill', color: 'Color',
};

/** Sensible identity for a property no component declares. */
const FALLBACK: Record<OverridableProp, OverrideValue> = {
  x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100,
  text: '', fill: '#ffffff', color: '#ffffff',
};

const UNIT: Partial<Record<OverridableProp, string>> = { rotation: '°', opacity: '%' };

/** 0..1 channel → two hex digits. Colour tracks are normalised, not 0..255. */
function hex2(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
}

/**
 * What this property would be WITHOUT an override: the animated value when the
 * source layer is keyframed, else its stored value.
 *
 * The component scan is last-write-wins, matching `readBase` in buildSnapshot —
 * the same rule `applyOverridesToComponents` targets when it decides which
 * component to patch. Three places agreeing on one rule is the point; if this
 * one drifts the field displays a value the renderer never uses.
 *
 * Colour is the awkward one, and it is awkward in the same way everywhere: it
 * is STORED as a hex string but ANIMATED as three 0..1 channels, so reading the
 * inherited value of a keyframed colour means rebuilding the hex from
 * `<prop>_r/_g/_b`. Reading the component alone would show the un-animated
 * colour and the field would disagree with the canvas.
 */
function inheritedValue(source: SceneNode, prop: OverridableProp, t: number): OverrideValue {
  const kind = OVERRIDE_PROP_KINDS[prop];

  if (kind === 'color') {
    const ch = (c: 'r' | 'g' | 'b'): number | undefined => {
      const path = `${prop}_${c}`;
      if (!defaultAnimation.isAnimated(source.id, path)) return undefined;
      const v = defaultAnimation.sample(source.id, path, t);
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    const r = ch('r'); const g = ch('g'); const b = ch('b');
    if (r !== undefined && g !== undefined && b !== undefined) {
      return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    }
  }

  if (kind === 'number' && defaultAnimation.isAnimated(source.id, prop)) {
    const v = defaultAnimation.sample(source.id, prop, t);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }

  let found: OverrideValue | undefined;
  for (const c of source.components) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (kind === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) found = v;
    } else if (typeof v === 'string') {
      found = v;
    }
  }
  return found ?? FALLBACK[prop];
}

type LayerRow = { source: SceneNode; props: OverridableProp[] };

function rowsForInstance(ref: string, promoted: ReadonlySet<string>): LayerRow[] {
  if (promoted.size > 0) {
    // Curated list — group promoted keys by source node, keep document order
    // by walking the referenced tree so nested layers appear under their
    // natural parents rather than in bag-iteration order.
    const byId = new Map<string, OverridableProp[]>();
    for (const key of promoted) {
      const parsed = parseOverrideKey(key);
      if (!parsed || !isOverridableProp(parsed.prop)) continue;
      const list = byId.get(parsed.origNodeId) ?? [];
      list.push(parsed.prop);
      byId.set(parsed.origNodeId, list);
    }
    const rows: LayerRow[] = [];
    const visit = (id: string): void => {
      const source = defaultSceneGraph.getNode(id);
      if (!source) return;
      const props = byId.get(id);
      if (props && props.length > 0) rows.push({ source, props });
      for (const child of defaultSceneGraph.getChildren(id)) visit(child.id);
    };
    visit(ref);
    return rows;
  }

  // Pre-promotion fallback: every overridable prop on each direct child.
  return defaultSceneGraph.getChildren(ref).map((source) => ({
    source,
    props: [...OVERRIDABLE_PROPS],
  }));
}

export function CompOverridesSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const ref = readCompRef(node);
  if (ref === null) return null;

  const promoted = readEssentialProps(ref);
  const rows = rowsForInstance(ref, promoted);
  if (rows.length === 0) return null;

  const overrides = readCompOverrides(node);

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Essential Properties</span>
        <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
          {overrides.size > 0
            ? `${overrides.size} overridden`
            : promoted.size > 0
              ? `${promoted.size} published`
              : 'inheriting'}
        </span>
      </div>
      {promoted.size === 0 && (
        <p style={{ margin: '0 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.45 }}>
          Right-click a property in the source composition to publish it here.
        </p>
      )}

      {rows.map(({ source, props }) => {
        const layerOverrides = props.filter((p) =>
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
            {props.map((prop) => {
              const key = overrideKey(source.id, prop);
              const overridden = overrides.has(key);
              const value = overridden
                ? overrides.get(key)!
                : inheritedValue(source, prop, time);
              const kind = OVERRIDE_PROP_KINDS[prop];
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
                  {kind === 'number' ? (
                    <ValueField
                      value={value as number}
                      onChange={(v) => setCompOverride(nodeId, source.id, prop, v)}
                      unit={UNIT[prop]}
                      precision={2}
                      aria-label={`${LABEL[prop]} on ${source.name ?? source.id}`}
                    />
                  ) : kind === 'color' ? (
                    <ColorPicker
                      value={String(value)}
                      onChange={(hex) => setCompOverride(nodeId, source.id, prop, hex)}
                      compact
                      // No alpha: the override is written back as the layer's
                      // colour string, and the renderer's colour channels carry
                      // no alpha of their own — an 8-digit hex would set an
                      // opacity that nothing reads.
                      alpha={false}
                      aria-label={`${LABEL[prop]} on ${source.name ?? source.id}`}
                    />
                  ) : (
                    <Input
                      size="sm"
                      value={String(value)}
                      onChange={(e) => setCompOverride(nodeId, source.id, prop, e.target.value)}
                      fullWidth
                      aria-label={`${LABEL[prop]} on ${source.name ?? source.id}`}
                    />
                  )}
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
