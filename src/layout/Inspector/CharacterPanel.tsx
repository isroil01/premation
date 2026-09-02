import { useState, useMemo } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { getRemappedTime } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getFontWeights, WEIGHT_LABELS } from '@core/text/fontCatalog';
import { useTextEditStore, hasRange } from '@stores/textEditStore';
import { readRuns, writeRuns, applyStyleToRange, type RunStyleKey } from '@core/text/richText';
import type { TextStyle } from '@core/text/textLayout';
import { readTextPathConfig, updateTextPath, setTextPath, defaultTextPath } from '@core/text/textPath';
import type { MaskPath } from '@core/effects/mask';
import { FontPicker } from './FontPicker';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { Icon } from '@components/Icon';
import styles from './CharacterPanel.module.css';

const PRESETS = [
  { label: 'Display', fontSize: 96, fontWeight: '800', fontStyle: 'normal' },
  { label: 'Title (L)', fontSize: 72, fontWeight: '700', fontStyle: 'normal' },
  { label: 'Headline', fontSize: 56, fontWeight: '700', fontStyle: 'normal' },
  { label: 'Subtitle', fontSize: 48, fontWeight: '600', fontStyle: 'normal' },
  { label: 'Body', fontSize: 36, fontWeight: '400', fontStyle: 'normal' },
  { label: 'Lower 3rd', fontSize: 28, fontWeight: '600', fontStyle: 'normal' },
  { label: 'Caption', fontSize: 24, fontWeight: '400', fontStyle: 'normal' },
  { label: 'Label', fontSize: 20, fontWeight: '500', fontStyle: 'normal' },
  { label: 'Overline', fontSize: 14, fontWeight: '500', fontStyle: 'normal' },
  { label: 'Quote', fontSize: 32, fontWeight: '300', fontStyle: 'italic' },
  { label: 'Mono', fontSize: 36, fontWeight: '500', fontStyle: 'normal', fontFamily: 'Fira Code' },
  { label: 'Button', fontSize: 16, fontWeight: '600', fontStyle: 'normal' },
];

export function CharacterPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? undefined;
  useSceneRevision((s) => s.rev);

  const time = useActiveWorkspace()?.time ?? 0;
  const layerT = primary ? getRemappedTime(primary, time) : 0;

  const node = primary ? defaultSceneGraph.getNode(primary) : null;
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Text'), [node]);

  // Bound layer hooks
  const [content, setContent] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'content');
  const [fontSize, setFontSize] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontSize');
  const [fontFamily, setFontFamily] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontFamily');
  const [fontWeight, setFontWeight] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontWeight');
  const [fontStyle, setFontStyle] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontStyle');
  const [fill, setFill] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fill');
  const [stroke, setStroke] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'stroke');
  const [strokeWidth, setStrokeWidth] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'strokeWidth');
  const [letterSpacing, setLetterSpacing] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'letterSpacing');
  const [lineHeight, setLineHeight] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'lineHeight');
  const [strokeOverFill, setStrokeOverFill] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'strokeOverFill');
  const [boxWidth, setBoxWidth] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'boxWidth');
  const [verticalScale, setVerticalScale] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'verticalScale');
  const [horizontalScale, setHorizontalScale] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'horizontalScale');
  const [baselineShift, setBaselineShift] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'baselineShift');
  const [textTransform, setTextTransform] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'textTransform');
  const [fontVariant, setFontVariant] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'fontVariant');
  const [verticalAlign, setVerticalAlign] = useNodeComponentProp(defaultSceneGraph, primary, tComp?.id, 'verticalAlign');

  // Local fallback states when no text layer is active
  const [fallbackFamily, setFallbackFamily] = useState('Inter');
  const [fallbackWeight, setFallbackWeight] = useState('400');
  const [fallbackStyle, setFallbackStyle] = useState('normal');
  const [fallbackSize, setFallbackSize] = useState(72);
  const [fallbackLeading, setFallbackLeading] = useState(1.2);
  const [fallbackTracking, setFallbackTracking] = useState(0);
  const [fallbackFill, setFallbackFill] = useState('#ffffff');
  const [fallbackStroke, setFallbackStroke] = useState('#000000');
  const [fallbackStrokeWidth, setFallbackStrokeWidth] = useState(0);
  const [fallbackStrokeOverFill, setFallbackStrokeOverFill] = useState(false);
  const [fallbackVertScale, setFallbackVertScale] = useState(100);
  const [fallbackHorizScale, setFallbackHorizScale] = useState(100);
  const [fallbackBaselineShift, setFallbackBaselineShift] = useState(0);
  const [fallbackTextTransform, setFallbackTextTransform] = useState('none');
  const [fallbackFontVariant, setFallbackFontVariant] = useState('normal');
  const [fallbackVerticalAlign, setFallbackVerticalAlign] = useState('baseline');

  const hasTarget = Boolean(primary && tComp && node);

  // Range styling state
  const editingNodeId = useTextEditStore((s) => s.nodeId);
  const rawSelection = useTextEditStore((s) => s.selection);
  const selection = hasTarget && editingNodeId === primary ? rawSelection : null;
  const ranged = hasRange(selection);

  const contentStrRaw = String(content ?? '');
  const textLen = [...contentStrRaw].length;

  const setCharProp = <K extends RunStyleKey>(
    key: K,
    val: TextStyle[K],
    setLayerWide: (v: TextStyle[K]) => void,
  ): void => {
    if (!ranged || !node || !primary) {
      setLayerWide(val);
      return;
    }
    writeRuns(
      primary,
      applyStyleToRange(readRuns(node), selection.start, selection.end, { [key]: val }, textLen),
    );
  };

  const clearRunStyling = (): void => {
    if (!ranged || !node || !primary) return;
    writeRuns(
      primary,
      applyStyleToRange(
        readRuns(node),
        selection.start,
        selection.end,
        { fontSize: undefined, fontFamily: undefined, fontWeight: undefined, fontStyle: undefined, letterSpacing: undefined, fill: undefined },
        textLen,
      ),
    );
  };

  const activeFamily = hasTarget ? String(fontFamily ?? 'Inter') : fallbackFamily;
  const activeWeight = hasTarget ? String(fontWeight ?? '400') : fallbackWeight;
  const activeStyle = hasTarget ? String(fontStyle ?? 'normal') : fallbackStyle;
  const activeSize = hasTarget ? Math.round(Number(fontSize ?? 72)) : fallbackSize;
  const activeLeading = hasTarget ? Number(lineHeight ?? 1.2) : fallbackLeading;
  const activeTracking = hasTarget ? Math.round(Number(letterSpacing ?? 0)) : fallbackTracking;
  const activeFill = hasTarget ? String(fill ?? '#ffffff') : fallbackFill;
  const activeStroke = hasTarget ? String(stroke ?? '#000000') : fallbackStroke;
  const activeStrokeWidth = hasTarget ? Number(strokeWidth ?? 0) : fallbackStrokeWidth;
  const activeStrokeOverFill = hasTarget ? strokeOverFill === true : fallbackStrokeOverFill;
  const activeVertScale = hasTarget ? Number(verticalScale ?? 100) : fallbackVertScale;
  const activeHorizScale = hasTarget ? Number(horizontalScale ?? 100) : fallbackHorizScale;
  const activeBaselineShift = hasTarget ? Number(baselineShift ?? 0) : fallbackBaselineShift;
  const activeTextTransform = hasTarget ? String(textTransform ?? 'none') : fallbackTextTransform;
  const activeFontVariant = hasTarget ? String(fontVariant ?? 'normal') : fallbackFontVariant;
  const activeVerticalAlign = hasTarget ? String(verticalAlign ?? 'baseline') : fallbackVerticalAlign;

  const availableWeights = getFontWeights(activeFamily);

  // Source text keyframe support
  const sourceAnimated = Boolean(primary && defaultAnimation.isDataAnimated(primary, 'text.source'));
  const sampledSource = sourceAnimated && primary
    ? defaultAnimation.sampleData(primary, 'text.source', layerT)
    : undefined;
  const contentStr = typeof sampledSource === 'string' ? sampledSource : contentStrRaw;

  const onContentEdit = (next: string): void => {
    if (!hasTarget) return;
    if (sourceAnimated && primary) {
      runAnimEdit('Edit Source Text keyframe', () => {
        defaultAnimation.setDataKeyframe(primary, 'text.source', 'text', layerT, next);
      }, `srcText:${primary}`);
    } else {
      setContent(next);
    }
  };

  const toggleSourceStopwatch = (): void => {
    if (!primary) return;
    if (sourceAnimated) {
      runAnimEdit('Remove Source Text keyframes', () => {
        defaultAnimation.setDataTrack(primary, 'text.source', null);
      });
    } else {
      runAnimEdit('Animate Source Text', () => {
        defaultAnimation.setDataKeyframe(primary, 'text.source', 'text', layerT, contentStr);
      });
    }
  };

  // Mask path riding
  const fxProps = node?.components.find((c) => c.type === 'fx')?.props as
    | { mask?: { paths?: MaskPath[] } }
    | undefined;
  const maskPaths: MaskPath[] = fxProps?.mask?.paths ?? [];
  const textPathCfg = node ? readTextPathConfig(node) : null;
  const activePathId = textPathCfg
    ? textPathCfg.pathId || (maskPaths[0]?.id ?? '')
    : '';

  const handleFamilyChange = (fam: string) => {
    setCharProp('fontFamily', fam, (v) => {
      if (hasTarget) setFontFamily(v as string);
      else setFallbackFamily(v as string);
    });
  };

  const handleWeightChange = (w: string) => {
    setCharProp('fontWeight', w, (v) => {
      if (hasTarget) setFontWeight(v as string);
      else setFallbackWeight(v as string);
    });
  };

  const handleStyleChange = (st: string) => {
    setCharProp('fontStyle', st, (v) => {
      if (hasTarget) setFontStyle(v as string);
      else setFallbackStyle(v as string);
    });
  };

  const handleSizeChange = (s: number) => {
    setCharProp('fontSize', s, (v) => {
      if (hasTarget) setFontSize(v as number);
      else setFallbackSize(v as number);
    });
  };

  const handleLeadingChange = (l: number) => {
    if (hasTarget) setLineHeight(l);
    else setFallbackLeading(l);
  };

  const handleTrackingChange = (tr: number) => {
    setCharProp('letterSpacing', tr, (v) => {
      if (hasTarget) setLetterSpacing(v as number);
      else setFallbackTracking(v as number);
    });
  };

  const handleFillChange = (c: string) => {
    setCharProp('fill', c, (v) => {
      if (hasTarget) setFill(v as string);
      else setFallbackFill(v as string);
    });
  };

  const handleStrokeChange = (c: string) => {
    if (hasTarget) setStroke(c);
    else setFallbackStroke(c);
  };

  const handleStrokeWidthChange = (w: number) => {
    if (hasTarget) setStrokeWidth(w);
    else setFallbackStrokeWidth(w);
  };

  const handleSwapFillStroke = () => {
    const prevFill = activeFill;
    const prevStroke = activeStroke;
    handleFillChange(prevStroke || '#000000');
    handleStrokeChange(prevFill);
    if (activeStrokeWidth === 0) {
      handleStrokeWidthChange(2);
    }
  };

  const applyPreset = (preset: typeof PRESETS[number]) => {
    if (ranged && node && primary) {
      writeRuns(
        primary,
        applyStyleToRange(
          readRuns(node),
          selection.start,
          selection.end,
          {
            fontSize: preset.fontSize,
            fontWeight: preset.fontWeight,
            fontStyle: preset.fontStyle,
            ...(preset.fontFamily ? { fontFamily: preset.fontFamily } : {}),
          },
          textLen,
        ),
      );
      return;
    }
    handleSizeChange(preset.fontSize);
    handleWeightChange(preset.fontWeight);
    handleStyleChange(preset.fontStyle);
    if (preset.fontFamily) handleFamilyChange(preset.fontFamily);
  };

  const isBold = Number(activeWeight) >= 700;
  const isItalic = activeStyle === 'italic';
  const isAllCaps = activeTextTransform === 'uppercase';
  const isSmallCaps = activeFontVariant === 'small-caps';
  const isSuperscript = activeVerticalAlign === 'super';
  const isSubscript = activeVerticalAlign === 'sub';

  return (
    <div className={styles.root}>
      {/* Target Status Banner */}
      <div className={styles.panelHead}>
        <span className={styles.panelHeadTitle}>Character</span>
        <span className={hasTarget ? styles.panelHeadStatusOn : styles.panelHeadStatus}>
          {hasTarget ? node?.name || 'Selected Text' : 'Default Preset'}
        </span>
      </div>

      {/* Ranged Selection Banner */}
      {ranged && (
        <div className={styles.rangeNotice}>
          <span>{`Styling ${selection.end - selection.start} character${selection.end - selection.start === 1 ? '' : 's'}`}</span>
          <button
            type="button"
            className={styles.resetBtn}
            onClick={clearRunStyling}
            title="Reset per-character styling for selected range"
          >
            Reset
          </button>
        </div>
      )}

      {/* Text Content & Source Text Keyframing */}
      {hasTarget && (
        <div className={styles.contentBox}>
          <div className={styles.contentHead}>
            <span className={styles.sectionTitle}>Content</span>
            <button
              type="button"
              className={`${styles.sourceStopwatch}${sourceAnimated ? ` ${styles.sourceStopwatchActive}` : ''}`}
              title={sourceAnimated ? 'Remove Source Text keyframes' : 'Keyframe Source Text across timeline'}
              onClick={toggleSourceStopwatch}
            >
              <Icon name="keyframe" size="sm" />
              <span>{sourceAnimated ? 'Animated' : 'Keyframe'}</span>
            </button>
          </div>
          <textarea
            className={styles.contentTextarea}
            value={contentStr}
            onChange={(e) => onContentEdit(e.target.value)}
            placeholder="Type text content here..."
            rows={2}
          />
        </div>
      )}

      {/* Font Family & Weight */}
      <div className={styles.row}>
        <div className={styles.col}>
          <FontPicker
            value={activeFamily}
            onChange={handleFamilyChange}
          />
        </div>
        <div className={styles.fontSizeCell}>
          <select
            value={activeWeight}
            onChange={(e) => handleWeightChange(e.target.value)}
            className={`${styles.fontSelect} ${styles.fullWidth}`}
          >
            {availableWeights.map((w) => (
              <option key={w} value={String(w)}>{WEIGHT_LABELS[w] ?? String(w)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Swatches & Swatch Swap */}
      <div className={styles.row}>
        <div className={styles.swatchBox}>
          <div className={styles.fillSwatchWrap} title="Character Fill Color">
            <ColorPicker
              value={activeFill}
              onChange={handleFillChange}
              compact
              aria-label="Character Fill Color"
              className={styles.fillSwatchPicker}
            />
          </div>

          <div className={styles.strokeSwatchWrap} title="Character Stroke Color">
            <ColorPicker
              value={activeStroke}
              onChange={handleStrokeChange}
              compact
              aria-label="Character Stroke Color"
              className={styles.strokeSwatchPicker}
            />
          </div>

          <button
            type="button"
            className={styles.swapBtn}
            title="Swap Fill and Stroke (Shift+X)"
            onClick={handleSwapFillStroke}
          >
            ⇄
          </button>
        </div>

        <div className={`${styles.col} ${styles.colCentered}`}>
          <span className={styles.swatchTitle}>
            {activeFamily}
          </span>
          <span className={styles.swatchHint}>
            {WEIGHT_LABELS[Number(activeWeight)] ?? 'Regular'} · {activeStyle === 'italic' ? 'Italic' : 'Normal'}
          </span>
        </div>
      </div>

      {/* AE Two-Column Metrics Grid */}
      <div className={styles.metricGrid}>
        {/* Font Size (TT) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Set the font size (TT)">TT</span>
          <input
            type="number"
            className={styles.metricInput}
            value={activeSize}
            onChange={(e) => handleSizeChange(Math.max(1, Number(e.target.value)))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* Leading (A/A) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Set the leading (line height) (A/A)">A/A</span>
          <input
            type="number"
            step="0.1"
            className={styles.metricInput}
            value={activeLeading}
            onChange={(e) => handleLeadingChange(Math.max(0.5, Number(e.target.value)))}
          />
          <span className={styles.metricUnit}>em</span>
        </div>

        {/* Kerning (V/A) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Set the kerning between two characters (V/A)">V/A</span>
          <input
            type="text"
            className={styles.metricInput}
            defaultValue="Metrics"
            readOnly
          />
        </div>

        {/* Tracking (VA) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Set the tracking (letter spacing) for selected characters (VA)">VA</span>
          <input
            type="number"
            className={styles.metricInput}
            value={activeTracking}
            onChange={(e) => handleTrackingChange(Number(e.target.value))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* Stroke Width (—) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Set the stroke width">—</span>
          <input
            type="number"
            min="0"
            className={styles.metricInput}
            value={activeStrokeWidth}
            onChange={(e) => handleStrokeWidthChange(Math.max(0, Number(e.target.value)))}
          />
          <span className={styles.metricUnit}>px</span>
        </div>

        {/* Vertical Scale (IT) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Vertically scale (IT)">IT</span>
          <input
            type="number"
            className={styles.metricInput}
            value={activeVertScale}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (hasTarget) setVerticalScale(val);
              else setFallbackVertScale(val);
            }}
          />
          <span className={styles.metricUnit}>%</span>
        </div>

        {/* Horizontal Scale (T-) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Horizontally scale (T-)">T-</span>
          <input
            type="number"
            className={styles.metricInput}
            value={activeHorizScale}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (hasTarget) setHorizontalScale(val);
              else setFallbackHorizScale(val);
            }}
          />
          <span className={styles.metricUnit}>%</span>
        </div>

        {/* Baseline Shift (A_) */}
        <div className={styles.metricCell}>
          <span className={styles.metricLabel} title="Set the baseline shift (A_)">A_</span>
          <input
            type="number"
            className={styles.metricInput}
            value={activeBaselineShift}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (hasTarget) setBaselineShift(val);
              else setFallbackBaselineShift(val);
            }}
          />
          <span className={styles.metricUnit}>px</span>
        </div>
      </div>

      {/* Faux Typography Buttons */}
      <div className={styles.fauxRow}>
        <button
          type="button"
          className={`${styles.fauxBtn}${isBold ? ` ${styles.fauxBtnActive}` : ''}`}
          title="Faux Bold"
          onClick={() => handleWeightChange(isBold ? '400' : '700')}
        >
          <b>B</b>
        </button>
        <button
          type="button"
          className={`${styles.fauxBtn}${isItalic ? ` ${styles.fauxBtnActive}` : ''}`}
          title="Faux Italic"
          onClick={() => handleStyleChange(isItalic ? 'normal' : 'italic')}
        >
          <i>I</i>
        </button>
        <button
          type="button"
          className={`${styles.fauxBtn}${isAllCaps ? ` ${styles.fauxBtnActive}` : ''}`}
          title="All Caps"
          onClick={() => {
            const next = isAllCaps ? 'none' : 'uppercase';
            if (hasTarget) setTextTransform(next);
            else setFallbackTextTransform(next);
          }}
        >
          TT
        </button>
        <button
          type="button"
          className={`${styles.fauxBtn}${isSmallCaps ? ` ${styles.fauxBtnActive}` : ''}`}
          title="Small Caps"
          onClick={() => {
            const next = isSmallCaps ? 'normal' : 'small-caps';
            if (hasTarget) setFontVariant(next);
            else setFallbackFontVariant(next);
          }}
        >
          Tt
        </button>
        <button
          type="button"
          className={`${styles.fauxBtn}${isSuperscript ? ` ${styles.fauxBtnActive}` : ''}`}
          title="Superscript"
          onClick={() => {
            const next = isSuperscript ? 'baseline' : 'super';
            if (hasTarget) setVerticalAlign(next);
            else setFallbackVerticalAlign(next);
          }}
        >
          T¹
        </button>
        <button
          type="button"
          className={`${styles.fauxBtn}${isSubscript ? ` ${styles.fauxBtnActive}` : ''}`}
          title="Subscript"
          onClick={() => {
            const next = isSubscript ? 'baseline' : 'sub';
            if (hasTarget) setVerticalAlign(next);
            else setFallbackVerticalAlign(next);
          }}
        >
          T₁
        </button>
        <button
          type="button"
          className={`${styles.fauxBtn}${activeStrokeOverFill ? ` ${styles.fauxBtnActive}` : ''}`}
          title="Stroke over Fill"
          onClick={() => {
            if (hasTarget) setStrokeOverFill(!activeStrokeOverFill);
            else setFallbackStrokeOverFill(!activeStrokeOverFill);
          }}
        >
          ⇄
        </button>
      </div>

      {/* Box Text Option */}
      {hasTarget && (
        <div className={styles.controlRow}>
          <label className={styles.inlineCheck}>
            <Checkbox
              checked={typeof boxWidth === 'number' && boxWidth > 0}
              onChange={() => {
                if (typeof boxWidth === 'number' && boxWidth > 0) setBoxWidth(0);
                else setBoxWidth(400);
              }}
              className={styles.inlineCheckBox}
            />
            <span className={styles.inlineCheckLabel}>Box Text Wrap</span>
          </label>
          {typeof boxWidth === 'number' && boxWidth > 0 && (
            <div className={styles.inlineField}>
              <input
                type="number"
                value={boxWidth}
                onChange={(e) => setBoxWidth(Math.max(50, Number(e.target.value)))}
                className={`${styles.metricInput} ${styles.inlineNumber}`}
              />
              <span className={styles.unit}>px</span>
            </div>
          )}
        </div>
      )}

      {/* Path Options (Mask text path riding) */}
      {hasTarget && maskPaths.length > 0 && (
        <div className={styles.controlRow}>
          <span className={styles.inlineLabel}>Path</span>
          <select
            value={activePathId}
            onChange={(e) => {
              if (!primary) return;
              const id = e.target.value;
              if (!id) setTextPath(primary, null);
              else updateTextPath(primary, { ...(textPathCfg ?? defaultTextPath()), pathId: id });
            }}
            className={`${styles.fontSelect} ${styles.pathSelect}`}
          >
            <option value="">None</option>
            {maskPaths.map((p, i) => (
              <option key={p.id} value={p.id}>{`Mask ${i + 1}`}</option>
            ))}
          </select>
        </div>
      )}

      {/* Quick Typography Presets */}
      <div>
        <div className={styles.subhead}>Typography Presets</div>
        <div className={styles.presetGrid}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={styles.presetChip}
              title={`${p.label} — ${p.fontSize}px / ${p.fontWeight}`}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
