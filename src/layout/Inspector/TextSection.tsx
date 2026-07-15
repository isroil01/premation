import { getTimelineController } from '@core/timeline/TimelineController';
import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { ColorKfRow } from './ColorKfRow';
import { FontPicker } from './FontPicker';
import styles from './TransformSection.module.css';

/**
 * A keyframeable numeric character property (font size / letter spacing / line
 * height). Stopwatch arms an animation track; buildSnapshot samples the prop by
 * name so it animates live. Non-animated edits write the static Text prop.
 */
function TextKfRow({ nodeId, prop, label, value, setValue, unit, defaultVal }: {
  nodeId: string; prop: string; label: string; value: unknown;
  setValue: (v: number) => void; unit: string; defaultVal: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  const staticVal = Number(value ?? defaultVal);
  const display = animated ? (defaultAnimation.sample(nodeId, prop, time) ?? staticVal) : staticVal;

  const onChange = (v: number): void => {
    if (animated) runAnimEdit(`Set ${label}`, () => defaultAnimation.setKeyframe(nodeId, prop, getTimelineController().toLayerTime(nodeId, time), v), `text:${nodeId}:${prop}:${time}`);
    else setValue(v);
  };
  const toggle = (): void => {
    if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
    else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, prop, getTimelineController().toLayerTime(nodeId, time), staticVal));
  };

  return (
    <InspectorRow label={label} align="center">
      <div className={styles.control}>
        <button
          type="button"
          className={cn(styles.stopwatch, animated && styles.stopwatchOn)}
          onClick={toggle}
          aria-pressed={animated}
          title={animated ? 'Remove animation' : 'Animate (stopwatch)'}
        >
          <Icon name="keyframe" size={11} />
        </button>
        <div className={styles.field}>
          <ValueField value={display} unit={unit} onChange={onChange} aria-label={label} />
        </div>
      </div>
    </InspectorRow>
  );
}

const PRESETS = [
  { label: 'Title (Large)', fontSize: 72, fontWeight: '700', fontStyle: 'normal' },
  { label: 'Subtitle', fontSize: 48, fontWeight: '600', fontStyle: 'normal' },
  { label: 'Body Text', fontSize: 36, fontWeight: '400', fontStyle: 'normal' },
  { label: 'Caption', fontSize: 24, fontWeight: '400', fontStyle: 'normal' },
  { label: 'Label', fontSize: 20, fontWeight: '500', fontStyle: 'normal' },
  { label: 'Overline', fontSize: 14, fontWeight: '500', fontStyle: 'normal' },
  { label: 'Quote', fontSize: 32, fontWeight: '300', fontStyle: 'italic' },
  { label: 'Monospace', fontSize: 36, fontWeight: '500', fontStyle: 'normal', fontFamily: 'Fira Code' },
  { label: 'Button', fontSize: 16, fontWeight: '600', fontStyle: 'normal' },
  { label: 'Link', fontSize: 18, fontWeight: '400', fontStyle: 'normal' }
];

export function TextSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const tComp = useMemo(() => node.components.find((c) => c.type === 'Text'), [node]);

  const [content, setContent] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'content');
  const [fontSize, setFontSize] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fontSize');
  const [fontFamily, setFontFamily] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fontFamily');
  const [fontWeight, setFontWeight] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fontWeight');
  const [fontStyle, setFontStyle] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fontStyle');
  const [fill, setFill] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fill');
  const [align, setAlign] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'align');
  const [letterSpacing, setLetterSpacing] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'letterSpacing');
  const [lineHeight, setLineHeight] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lineHeight');

  if (!tComp) return null;

  const applyPreset = (preset: typeof PRESETS[number]) => {
    setFontSize(preset.fontSize);
    setFontWeight(preset.fontWeight);
    setFontStyle(preset.fontStyle);
    if (preset.fontFamily) setFontFamily(preset.fontFamily);
  };

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Character</h4>
      
      <InspectorRow label="Text Content" align="center">
        <input
          type="text"
          value={String(content ?? '')}
          onChange={(e) => setContent(e.target.value)}
          className={styles.textInput}
        />
      </InspectorRow>

      <InspectorRow label="Font Family" align="center">
        <FontPicker
          value={String(fontFamily ?? 'Inter')}
          onChange={(family) => setFontFamily(family)}
        />
      </InspectorRow>

      <TextKfRow nodeId={nodeId} prop="fontSize" label="Font Size" value={fontSize} setValue={setFontSize} unit="px" defaultVal={32} />

      <InspectorRow label="Weight" align="center">
        <select
          value={String(fontWeight ?? '400')}
          onChange={(e) => setFontWeight(e.target.value)}
          className={styles.select}
        >
          <option value="300">Light (300)</option>
          <option value="400">Regular (400)</option>
          <option value="500">Medium (500)</option>
          <option value="600">Semi-Bold (600)</option>
          <option value="700">Bold (700)</option>
        </select>
      </InspectorRow>

      <InspectorRow label="Style" align="center">
        <select
          value={String(fontStyle ?? 'normal')}
          onChange={(e) => setFontStyle(e.target.value)}
          className={styles.select}
        >
          <option value="normal">Normal</option>
          <option value="italic">Italic</option>
        </select>
      </InspectorRow>

      <ColorKfRow
        nodeId={nodeId}
        propPrefix="color"
        label="Text Color"
        value={String(fill ?? '#ffffff')}
        setValue={(val) => setFill(val)}
      />

      <TextKfRow nodeId={nodeId} prop="letterSpacing" label="Letter Spacing" value={letterSpacing} setValue={setLetterSpacing} unit="px" defaultVal={0} />

      <TextKfRow nodeId={nodeId} prop="lineHeight" label="Line Height" value={lineHeight} setValue={setLineHeight} unit="em" defaultVal={1.2} />

      <h4 className={styles.title} style={{ marginTop: 12 }}>Paragraph</h4>

      <InspectorRow label="Alignment" align="center">
        <select
          value={String(align ?? 'left')}
          onChange={(e) => setAlign(e.target.value)}
          className={styles.select}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
          <option value="justify">Justify</option>
        </select>
      </InspectorRow>

      <h4 className={styles.title} style={{ marginTop: 'var(--space-4)' }}>Text Presets</h4>
      <div className={styles.presetGrid}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => applyPreset(preset)}
            className={styles.presetChip}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default TextSection;
