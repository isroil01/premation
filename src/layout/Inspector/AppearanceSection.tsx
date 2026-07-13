import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeFill, setNodeFill, convertFill, type FillType } from '@core/paint/fill';
import { getNodeStroke, updateNodeStroke, type StrokeCap, type StrokeJoin } from '@core/paint/stroke';
import styles from './TransformSection.module.css';

export function AppearanceSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const sComp = useMemo(() => node.components.find((c) => c.type === 'Style'), [node]);
  const [cornerRadius, setCornerRadius] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'cornerRadius');

  const fill = getNodeFill(nodeId);
  const stroke = getNodeStroke(nodeId);

  const handleFillTypeChange = (type: FillType | 'none') => {
    if (type === 'none') {
      setNodeFill(nodeId, undefined);
    } else {
      setNodeFill(nodeId, convertFill(fill, type));
    }
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

  const hasStyle = !!sComp;

  if (!hasStyle) return null;

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Appearance</h4>
      
      <InspectorRow label="Fill Type" align="center">
        <select
          value={fill?.type ?? 'none'}
          onChange={(e) => handleFillTypeChange(e.target.value as FillType | 'none')}
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
        >
          <option value="none">None</option>
          <option value="solid">Solid</option>
          <option value="linear">Linear Gradient</option>
          <option value="radial">Radial Gradient</option>
        </select>
      </InspectorRow>

      {fill && (
        <InspectorRow label="Fill Color" align="center">
          <input
            type="color"
            value={fill.type === 'solid' ? fill.color : fill.stops[0]?.color ?? '#ffffff'}
            onChange={(e) => handleFillColorChange(e.target.value)}
            style={{ width: '100%', height: 20, border: 'none', padding: 0, background: 'none', cursor: 'pointer' }}
          />
        </InspectorRow>
      )}

      <InspectorRow label="Stroke Width" align="center">
        <ValueField value={stroke?.width ?? 0} unit="px" onChange={handleStrokeWidthChange} />
      </InspectorRow>

      {(stroke?.width ?? 0) > 0 && (
        <>
          <InspectorRow label="Stroke Color" align="center">
            <input
              type="color"
              value={stroke?.color ?? '#ffffff'}
              onChange={(e) => handleStrokeColorChange(e.target.value)}
              style={{ width: '100%', height: 20, border: 'none', padding: 0, background: 'none', cursor: 'pointer' }}
            />
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
        </>
      )}

      <InspectorRow label="Corner Radius" align="center">
        <ValueField value={Number(cornerRadius ?? 0)} unit="px" onChange={(v) => setCornerRadius(v)} />
      </InspectorRow>
    </div>
  );
}

export default AppearanceSection;
