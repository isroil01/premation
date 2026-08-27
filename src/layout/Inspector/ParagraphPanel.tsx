import { useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { Icon } from '@components/Icon';
import styles from './CharacterPanel.module.css';

export function ParagraphPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? undefined;
  useSceneRevision((s) => s.rev);

  const node = primary ? defaultSceneGraph.getNode(primary) : null;
  const tComp = node?.components.find((c) => c.type === 'Text');

  const [align, setAlign] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'align');
  const [paragraphSpacing, setParagraphSpacing] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'paragraphSpacing');
  const [leftIndent, setLeftIndent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'leftIndent');
  const [rightIndent, setRightIndent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'rightIndent');
  const [firstLineIndent, setFirstLineIndent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'firstLineIndent');
  const [spaceBefore, setSpaceBefore] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'spaceBefore');

  const [fallbackAlign, setFallbackAlign] = useState('left');
  const [fallbackSpacing, setFallbackSpacing] = useState(0);
  const [fallbackFirstLineIndent, setFallbackFirstLineIndent] = useState(0);
  const [fallbackLeftIndent, setFallbackLeftIndent] = useState(0);
  const [fallbackRightIndent, setFallbackRightIndent] = useState(0);
  const [fallbackSpaceBefore, setFallbackSpaceBefore] = useState(0);

  const hasTarget = Boolean(primary && tComp);
  const currentAlign = hasTarget ? String(align ?? 'left') : fallbackAlign;
  const currentSpacing = hasTarget ? Number(paragraphSpacing ?? 0) : fallbackSpacing;
  const currentLeftIndent = hasTarget ? Number(leftIndent ?? 0) : fallbackLeftIndent;
  const currentRightIndent = hasTarget ? Number(rightIndent ?? 0) : fallbackRightIndent;
  const currentFirstLineIndent = hasTarget ? Number(firstLineIndent ?? 0) : fallbackFirstLineIndent;
  const currentSpaceBefore = hasTarget ? Number(spaceBefore ?? 0) : fallbackSpaceBefore;

  const handleAlignChange = (a: string) => {
    if (hasTarget) setAlign(a);
    else setFallbackAlign(a);
  };

  const handleSpacingChange = (sp: number) => {
    if (hasTarget) setParagraphSpacing(sp);
    else setFallbackSpacing(sp);
  };

  const handleLeftIndentChange = (v: number) => {
    if (hasTarget) setLeftIndent(v);
    else setFallbackLeftIndent(v);
  };

  const handleRightIndentChange = (v: number) => {
    if (hasTarget) setRightIndent(v);
    else setFallbackRightIndent(v);
  };

  const handleFirstLineIndentChange = (v: number) => {
    if (hasTarget) setFirstLineIndent(v);
    else setFallbackFirstLineIndent(v);
  };

  const handleSpaceBeforeChange = (v: number) => {
    if (hasTarget) setSpaceBefore(v);
    else setFallbackSpaceBefore(v);
  };

  return (
    <div className={styles.root}>
      {/* Target Status Banner */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-secondary)', paddingBottom: 2, borderBottom: '1px solid var(--color-border)' }}>
        <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Paragraph</span>
        <span style={{ color: hasTarget ? 'var(--color-selection, #2988ff)' : 'var(--color-text-muted)' }}>
          {hasTarget ? node?.name || 'Selected Text' : 'Default Preset'}
        </span>
      </div>

      <div className={styles.sectionTitle}>Alignment</div>
      
      {/* 7 Alignment buttons in After Effects layout */}
      <div className={styles.alignBar}>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'left' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Left Align Text"
          onClick={() => handleAlignChange('left')}
        >
          <Icon name="text-left" size="sm" />
        </button>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'center' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Center Text"
          onClick={() => handleAlignChange('center')}
        >
          <Icon name="text-center" size="sm" />
        </button>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'right' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Right Align Text"
          onClick={() => handleAlignChange('right')}
        >
          <Icon name="text-right" size="sm" />
        </button>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'justify' || currentAlign === 'justify-left' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Justify Last Left"
          onClick={() => handleAlignChange('justify-left')}
        >
          <Icon name="align-left" size="sm" />
        </button>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'justify-center' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Justify Last Center"
          onClick={() => handleAlignChange('justify-center')}
        >
          <Icon name="align-center" size="sm" />
        </button>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'justify-right' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Justify Last Right"
          onClick={() => handleAlignChange('justify-right')}
        >
          <Icon name="align-right" size="sm" />
        </button>
        <button
          type="button"
          className={`${styles.alignBtn}${currentAlign === 'justify-all' ? ` ${styles.alignBtnActive}` : ''}`}
          title="Justify All Lines"
          onClick={() => handleAlignChange('justify-all')}
        >
          <Icon name="distribute-horizontal" size="sm" />
        </button>
      </div>

      <div className={styles.sectionTitle} style={{ marginTop: 6 }}>Indents &amp; Spacing</div>

      {/* AE Paragraph Indents Grid */}
      <div className={styles.metricGrid}>
        {/* Left Indent */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Indent left margin">⇤L</span>
          <input
            type="number"
            className={styles.metricInput}
            value={currentLeftIndent}
            onChange={(e) => handleLeftIndentChange(Number(e.target.value))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* Right Indent */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Indent right margin">R⇥</span>
          <input
            type="number"
            className={styles.metricInput}
            value={currentRightIndent}
            onChange={(e) => handleRightIndentChange(Number(e.target.value))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* First Line Indent */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Indent first line">1st</span>
          <input
            type="number"
            className={styles.metricInput}
            value={currentFirstLineIndent}
            onChange={(e) => handleFirstLineIndentChange(Number(e.target.value))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* Space Before */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Space before paragraph">↑¶</span>
          <input
            type="number"
            className={styles.metricInput}
            value={currentSpaceBefore}
            onChange={(e) => handleSpaceBeforeChange(Number(e.target.value))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* Space After */}
        <div className={styles.metricCell} style={{ gridColumn: 'span 2' }}>
          <span className={styles.metricLabel} title="Space after paragraph">↓¶</span>
          <input
            type="number"
            className={styles.metricInput}
            value={currentSpacing}
            onChange={(e) => handleSpacingChange(Number(e.target.value))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>
      </div>
    </div>
  );
}
