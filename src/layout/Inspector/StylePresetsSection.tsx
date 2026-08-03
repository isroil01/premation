/**
 * StylePresetsSection — one-click composed looks for the selected layer.
 *
 * Each swatch previews the preset with the layer's OWN accent colour, so the
 * grid shows what you would actually get rather than a generic sample. Applying
 * one writes ordinary fill / stroke / layer-style props, so everything stays
 * editable in the sections below and animates through the normal keyframe path.
 */

import { useMemo } from 'react';
import { STYLE_PRESETS, applyStylePreset, type StylePresetCategory } from '@core/style/stylePresets';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { sortedStops, type FillPaint } from '@core/paint/fill';
import styles from './StylePresetsSection.module.css';

/** A paint as a CSS background, for the swatch preview only — the renderer has
 *  its own rasterizer and no CSS helper existed to reuse. */
function paintToCss(paint: FillPaint): string {
  if (paint.type === 'solid') return paint.color;
  const list = sortedStops(paint.stops)
    .map((s) => `${s.color} ${(s.offset * 100).toFixed(0)}%`)
    .join(', ');
  return paint.type === 'linear'
    // CSS 0deg points up and turns clockwise; the paint model's 0° points right.
    ? `linear-gradient(${paint.angle + 90}deg, ${list})`
    : `radial-gradient(circle at ${(paint.cx * 100).toFixed(0)}% ${(paint.cy * 100).toFixed(0)}%, ${list})`;
}

/**
 * A `Record` keyed by the category union, NOT a hand-written array: a preset
 * whose category has no entry here renders nowhere, and `STYLE_PRESETS` has no
 * other consumer. That is how all six 3D material presets (Steel, Gold,
 * Plastic, Glass, Neon, Obsidian) came to be unreachable — 'material' was
 * simply missing from the list, and nothing failed to say so.
 *
 * As a Record, adding a category to `StylePresetCategory` without giving it a
 * label is a compile error instead of six silently invisible presets.
 */
const GROUP_LABELS: Record<StylePresetCategory, string> = {
  surface: 'Surfaces',
  outline: 'Outlines',
  text: 'Text',
  depth: 'Depth',
  material: 'Materials',
};

/** Display order; anything not listed still renders, after these. */
const GROUP_ORDER: StylePresetCategory[] = ['surface', 'outline', 'text', 'depth', 'material'];

const GROUPS: Array<{ id: StylePresetCategory; label: string }> = (
  Object.keys(GROUP_LABELS) as StylePresetCategory[]
)
  .sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
  })
  .map((id) => ({ id, label: GROUP_LABELS[id] }));

export function StylePresetsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  const accent = useMemo(() => {
    const c = node?.components.find((x) => x.type === 'Style' || x.type === 'Text');
    const fill = c?.props.fill;
    return typeof fill === 'string' && fill.startsWith('#') ? fill.slice(0, 7) : '#2b7eff';
  }, [node]);

  if (!node) return null;

  const apply = (id: string, label: string): void => {
    if (applyStylePreset(nodeId, id, accent)) {
      useUIStore.getState().notify({ level: 'success', message: `Applied “${label}”`, durationMs: 2000 });
    }
  };

  return (
    <div className={styles.root}>
      {GROUPS.map((group) => {
        const items = STYLE_PRESETS.filter((p) => p.category === group.id);
        if (items.length === 0) return null;
        return (
          <div key={group.id} className={styles.group}>
            <div className={styles.groupLabel}>{group.label}</div>
            <div className={styles.grid}>
              {items.map((preset) => {
                // Preview the real fill stack — top layer wins visually, which is
                // what the swatch should show.
                const fills = preset.fills(accent);
                const top = fills[fills.length - 1];
                const strokeTop = preset.strokes?.(accent).slice(-1)[0];
                const st = preset.styles?.(accent);
                const shadow = st?.dropShadow;
                const glow = st?.outerGlow;
                const boxShadow = [
                  shadow ? `0 ${Math.min(6, Math.round(shadow.distance / 15))}px ${Math.min(8, Math.round(shadow.blur / 2))}px rgba(0,0,0,${shadow.opacity})` : '',
                  glow ? `0 0 ${Math.min(10, Math.round(glow.size / 2))}px ${glow.color}` : '',
                ].filter(Boolean).join(', ');
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={styles.swatch}
                    title={`${preset.label} — ${preset.hint}`}
                    onClick={() => apply(preset.id, preset.label)}
                  >
                    <span
                      className={styles.chip}
                      style={{
                        background: top ? paintToCss(top) : 'transparent',
                        borderRadius: Math.min(12, preset.cornerRadius ?? 6),
                        ...(strokeTop ? { border: `${Math.min(3, strokeTop.width / 3)}px solid ${strokeTop.color}` } : {}),
                        ...(boxShadow ? { boxShadow } : {}),
                      }}
                    />
                    <span className={styles.label}>{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
