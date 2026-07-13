import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import styles from './TransformSection.module.css';

const GOOGLE_FONTS = [
  'Inter', 'Roboto', 'Outfit', 'Playfair Display', 'Fira Code', 'Montserrat',
  'Lora', 'Merriweather', 'PT Sans', 'Open Sans'
];

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
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
        />
      </InspectorRow>

      <InspectorRow label="Font Family" align="center">
        <select
          value={String(fontFamily ?? 'Inter')}
          onChange={(e) => setFontFamily(e.target.value)}
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
        >
          {GOOGLE_FONTS.map((font) => (
            <option key={font} value={font}>{font}</option>
          ))}
        </select>
      </InspectorRow>

      <InspectorRow label="Font Size" align="center">
        <ValueField value={Number(fontSize ?? 32)} unit="px" onChange={(v) => setFontSize(v)} />
      </InspectorRow>

      <InspectorRow label="Weight" align="center">
        <select
          value={String(fontWeight ?? '400')}
          onChange={(e) => setFontWeight(e.target.value)}
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
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
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
        >
          <option value="normal">Normal</option>
          <option value="italic">Italic</option>
        </select>
      </InspectorRow>

      <InspectorRow label="Text Color" align="center">
        <input
          type="color"
          value={String(fill ?? '#ffffff')}
          onChange={(e) => setFill(e.target.value)}
          style={{ width: '100%', height: 20, border: 'none', padding: 0, background: 'none', cursor: 'pointer' }}
        />
      </InspectorRow>

      <InspectorRow label="Letter Spacing" align="center">
        <ValueField value={Number(letterSpacing ?? 0)} unit="px" onChange={(v) => setLetterSpacing(v)} />
      </InspectorRow>

      <InspectorRow label="Line Height" align="center">
        <ValueField value={Number(lineHeight ?? 1.2)} unit="em" onChange={(v) => setLineHeight(v)} />
      </InspectorRow>

      <h4 className={styles.title} style={{ marginTop: 12 }}>Paragraph</h4>

      <InspectorRow label="Alignment" align="center">
        <select
          value={String(align ?? 'left')}
          onChange={(e) => setAlign(e.target.value)}
          style={{ width: '100%', background: '#1c1c1f', border: '1px solid #333', color: '#fff', fontSize: 11, padding: '2px 4px', borderRadius: 2 }}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
          <option value="justify">Justify</option>
        </select>
      </InspectorRow>

      <h4 className={styles.title} style={{ marginTop: 12 }}>Text Presets</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, marginTop: 4 }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => applyPreset(preset)}
            style={{
              background: '#202024',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#bbb',
              fontSize: 10,
              padding: '4px 6px',
              borderRadius: 3,
              cursor: 'pointer',
              textAlign: 'left'
            }}
            onMouseEnter={(e) => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'}
            onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default TextSection;
