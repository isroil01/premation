import { getTimelineController } from '@core/timeline/TimelineController';
import { useMemo, useState } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeFill, setNodeFill, convertFill, makeStop, sortedStops, type FillType, type FillPaint, type ColorStop } from '@core/paint/fill';
import { getNodeStroke, updateNodeStroke, type StrokeAlign, type StrokeCap, type StrokeJoin } from '@core/paint/stroke';
import { Icon } from '@components/Icon';
import { ColorPicker } from '@components/ColorPicker';
import { ColorKfRow } from './ColorKfRow';
import styles from './TransformSection.module.css';
import effStyles from '../Effects/EffectsPanel.module.css';
import { useActiveWorkspace } from '@stores/projectStore';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';

/** Editor for a gradient's stop list (shared by linear + radial fills). */
function StopList({ nodeId, paint }: { nodeId: string; paint: FillPaint }): JSX.Element | null {
  if (paint.type === 'solid') return null;
  const stops = sortedStops(paint.stops);
  const write = (next: ColorStop[]): void => setNodeFill(nodeId, { ...paint, stops: next });

  return (
    <div className={effStyles.list}>
      {stops.map((s, i) => (
        <div key={s.id} className={effStyles.stopRow}>
          <ColorPicker
            value={s.color}
            onChange={(color) => write(stops.map((x) => (x.id === s.id ? { ...x, color } : x)))}
            aria-label={`Stop ${i + 1} color`}
          />
          <ValueField
            value={Math.round(s.offset * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(stops.map((x) => (x.id === s.id ? { ...x, offset: v / 100 } : x)))}
            aria-label={`Stop ${i + 1} position`}
          />
          <button
            type="button"
            className={effStyles.remove}
            aria-label={`Remove stop ${i + 1}`}
            disabled={stops.length <= 2}
            onClick={() => write(stops.filter((x) => x.id !== s.id))}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...stops, makeStop(0.5, '#888888')])}
      >
        <Icon name="plus" size={11} /> Add stop
      </button>
    </div>
  );
}

export function AppearanceSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s: any) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const time = useActiveWorkspace()?.time ?? 0;
  // Shape/media layers carry a Style component; text layers carry a Text
  // component. Fill & stroke live on the paint (`fx`) module either way, so the
  // section renders for both — only Corner Radius is Style-specific.
  const styleComp = useMemo(() => node.components.find((c) => c.type === 'Style'), [node]);
  const textComp = useMemo(() => node.components.find((c) => c.type === 'Text'), [node]);
  const sComp = styleComp ?? textComp;

  const renderKeyframeableProp = (
    prop: string,
    label: string,
    baseVal: number,
    setBaseVal: (v: number) => void,
    unit = '',
  ) => {
    const animated = defaultAnimation.isAnimated(nodeId, prop);
    const displayVal = animated ? defaultAnimation.sample(nodeId, prop, time) ?? baseVal : baseVal;

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit(`Remove ${label} animation`, () => {
          defaultAnimation.removeTrack(nodeId, prop);
        });
      } else {
        runAnimEdit(`Animate ${label}`, () => {
          defaultAnimation.setKeyframe(nodeId, prop, getTimelineController().toLayerTime(nodeId, time), baseVal);
        });
      }
    };

    const handleChange = (v: number) => {
      if (animated) {
        runAnimEdit(`Change ${label}`, () => {
          defaultAnimation.setKeyframe(nodeId, prop, getTimelineController().toLayerTime(nodeId, time), v);
        });
      } else {
        setBaseVal(v);
      }
    };

    return (
      <InspectorRow label={label} align="center" key={prop}>
        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
            onClick={toggleAnim}
            title={animated ? 'Disable keyframe animation' : 'Enable keyframe animation'}
          >
            <Icon name="keyframe" size={11} />
          </button>
          <div className={styles.field}>
            <ValueField value={displayVal} unit={unit} onChange={handleChange} />
          </div>
        </div>
      </InspectorRow>
    );
  };
  const [cornerRadius, setCornerRadius] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornerRadius');

  const fill = getNodeFill(nodeId);
  const stroke = getNodeStroke(nodeId);

  const [savedFill, setSavedFill] = useState<FillPaint | null>(null);

  const handleFillTypeChange = (type: FillType | 'none') => {
    if (type === 'none') {
      if (fill) setSavedFill(fill);
      setNodeFill(nodeId, undefined);
    } else {
      setNodeFill(nodeId, convertFill(fill, type));
      setSavedFill(null);
    }
  };

  const toggleFill = () => {
    if (fill) {
      setSavedFill(fill);
      setNodeFill(nodeId, undefined);
    } else {
      setNodeFill(nodeId, savedFill ?? { type: 'solid', color: '#ffffff' });
      setSavedFill(null);
    }
  };

  const toggleStroke = () => {
    updateNodeStroke(nodeId, { enabled: !(stroke?.enabled ?? false) });
  };

  const handleFillColorChange = (color: string) => {
    if (fill && fill.type === 'solid') {
      setNodeFill(nodeId, { ...fill, color });
    } else if (fill) {
      // For gradients, update the first stop's color
      const newStops = [...fill.stops];
      if (newStops[0]) {
        newStops[0] = { ...newStops[0], color };
      }
      setNodeFill(nodeId, { ...fill, stops: newStops });
    } else {
      setNodeFill(nodeId, { type: 'solid', color });
    }
  };

  const handleStrokeWidthChange = (width: number) => {
    updateNodeStroke(nodeId, { width, enabled: width > 0 });
  };

  const handleStrokeColorChange = (color: string) => {
    updateNodeStroke(nodeId, { color });
  };

  const handleStrokeCapChange = (cap: StrokeCap) => {
    updateNodeStroke(nodeId, { cap });
  };

  const handleStrokeJoinChange = (join: StrokeJoin) => {
    updateNodeStroke(nodeId, { join });
  };

  const handleStrokeAlignChange = (align: StrokeAlign) => {
    updateNodeStroke(nodeId, { align });
  };

  const handleStrokeOpacityChange = (v: number) => {
    updateNodeStroke(nodeId, { opacity: v / 100 });
  };

  const handleStrokeDashChange = (raw: string) => {
    updateNodeStroke(nodeId, {
      dash: raw.split(',').map((n) => Number.parseFloat(n.trim())).filter((n) => Number.isFinite(n) && n >= 0),
    });
  };

  const handleAngleChange = (angle: number) => {
    if (fill && fill.type === 'linear') {
      setNodeFill(nodeId, { ...fill, angle });
    }
  };

  const handleCxChange = (cx: number) => {
    if (fill && fill.type === 'radial') {
      setNodeFill(nodeId, { ...fill, cx });
    }
  };

  const handleCyChange = (cy: number) => {
    if (fill && fill.type === 'radial') {
      setNodeFill(nodeId, { ...fill, cy });
    }
  };

  const handleRadiusChange = (radius: number) => {
    if (fill && fill.type === 'radial') {
      setNodeFill(nodeId, { ...fill, radius });
    }
  };

  if (!sComp) return null;

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Appearance</h4>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '8px' }}>
        <div style={{ flex: 1, borderBottom: 'none' }}>
          <InspectorRow label="Fill Type" align="center">
            <select
              value={fill?.type ?? 'none'}
              onChange={(e) => handleFillTypeChange(e.target.value as FillType | 'none')}
              className={styles.select}
            >
              <option value="none">None</option>
              <option value="solid">Solid</option>
              <option value="linear">Linear Gradient</option>
              <option value="radial">Radial Gradient</option>
            </select>
          </InspectorRow>
        </div>
        <button
          type="button"
          onClick={toggleFill}
          className={styles.stopwatch}
          style={{ opacity: fill ? 1 : 0.4 }}
          title={fill ? 'Disable Fill' : 'Enable Fill'}
        >
          <Icon name={fill ? 'eye' : 'eye-off'} size={14} />
        </button>
      </div>

      {fill && fill.type === 'solid' && (
        <ColorKfRow
          nodeId={nodeId}
          propPrefix="fill"
          label="Fill Color"
          value={fill.color}
          setValue={handleFillColorChange}
        />
      )}

      {fill && (fill.type === 'linear' || fill.type === 'radial') && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ marginBottom: '8px', fontSize: '11px', color: 'var(--color-text-secondary)' }}>Gradient Stops</div>
          <StopList nodeId={nodeId} paint={fill} />
          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {fill.type === 'linear' && renderKeyframeableProp('fillAngle', 'Angle', fill.angle, handleAngleChange, '°')}
            {fill.type === 'radial' && (
              <>
                {renderKeyframeableProp('fillCenterX', 'Center X', fill.cx, handleCxChange)}
                {renderKeyframeableProp('fillCenterY', 'Center Y', fill.cy, handleCyChange)}
                {renderKeyframeableProp('fillRadius', 'Radius', fill.radius, handleRadiusChange)}
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: '8px' }}>
        <div style={{ flex: 1, borderBottom: 'none' }}>
          <InspectorRow label="Stroke Width" align="center">
            <ValueField value={stroke?.width ?? 0} unit="px" onChange={handleStrokeWidthChange} />
          </InspectorRow>
        </div>
        <button
          type="button"
          onClick={toggleStroke}
          className={styles.stopwatch}
          style={{ opacity: stroke?.enabled ? 1 : 0.4 }}
          title={stroke?.enabled ? 'Disable Stroke' : 'Enable Stroke'}
        >
          <Icon name={stroke?.enabled ? 'eye' : 'eye-off'} size={14} />
        </button>
      </div>

      {(stroke?.enabled ?? false) && (stroke?.width ?? 0) > 0 && (
        <>
          <ColorKfRow
            nodeId={nodeId}
            propPrefix="stroke"
            label="Stroke Color"
            value={stroke?.color ?? '#ffffff'}
            setValue={handleStrokeColorChange}
          />

          <InspectorRow label="Stroke Opacity" align="center">
            <ValueField
              value={Math.round((stroke?.opacity ?? 1) * 100)}
              min={0}
              max={100}
              precision={0}
              unit="%"
              onChange={handleStrokeOpacityChange}
              aria-label="Stroke opacity"
            />
          </InspectorRow>

          <InspectorRow label="Stroke Align" align="center">
            <select
              value={stroke?.align ?? 'center'}
              onChange={(e) => handleStrokeAlignChange(e.target.value as StrokeAlign)}
              style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
            >
              <option value="center">Center</option>
              <option value="inside">Inside</option>
              <option value="outside">Outside</option>
            </select>
          </InspectorRow>

          <InspectorRow label="Stroke Cap" align="center">
            <select
              value={stroke?.cap ?? 'round'}
              onChange={(e) => handleStrokeCapChange(e.target.value as StrokeCap)}
              style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
            >
              <option value="butt">Butt</option>
              <option value="round">Round</option>
              <option value="square">Square</option>
            </select>
          </InspectorRow>

          <InspectorRow label="Stroke Join" align="center">
            <select
              value={stroke?.join ?? 'round'}
              onChange={(e) => handleStrokeJoinChange(e.target.value as StrokeJoin)}
              style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
            >
              <option value="miter">Miter</option>
              <option value="round">Round</option>
              <option value="bevel">Bevel</option>
            </select>
          </InspectorRow>

          <InspectorRow label="Stroke Dashes" align="center">
            <input
              type="text"
              value={(stroke?.dash ?? []).join(', ')}
              placeholder="e.g. 8, 4"
              onChange={(e) => handleStrokeDashChange(e.currentTarget.value)}
              style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
              aria-label="Stroke dashes"
            />
          </InspectorRow>
        </>
      )}

      {styleComp && (
        <InspectorRow label="Corner Radius" align="center">
          <ValueField value={Number(cornerRadius ?? 0)} unit="px" onChange={(v) => setCornerRadius(v)} />
        </InspectorRow>
      )}
    </div>
  );
}

export default AppearanceSection;
