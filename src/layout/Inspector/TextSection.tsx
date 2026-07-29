import { getRemappedTime } from '@core/timeline/TimelineController';
import { useEffect, useMemo, useReducer } from 'react';
import { loadFontCatalog, onFontCatalogReady, getFontWeights, WEIGHT_LABELS } from '@core/text/fontCatalog';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { ColorKfRow } from './ColorKfRow';
import { FontPicker } from './FontPicker';
import { Checkbox } from '@components/Checkbox';
import { Icon } from '@components/Icon';
import { useTextEditStore, hasRange } from '@stores/textEditStore';
import { readTextPathConfig, updateTextPath, setTextPath, defaultTextPath } from '@core/text/textPath';
import type { MaskPath } from '@core/effects/mask';
import { readRuns, writeRuns, applyStyleToRange, styleOverRange, type RunStyleKey } from '@core/text/richText';
import type { TextStyle } from '@core/text/textLayout';
import styles from './TransformSection.module.css';

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
  // Size/tracking/leading can all show sampled keyframe values, and keyframes
  // live outside React — without this the fields keep the value they last
  // rendered with after an edit.
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  // The layer's own time axis — the one the renderer samples on. Reading on
  // one axis and writing on another is what made a value set at 5s appear to
  // overwrite the keyframe at 1s.
  const layerT = getRemappedTime(nodeId, time);
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
  const [paragraphSpacing, setParagraphSpacing] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'paragraphSpacing');
  const [strokeOverFill, setStrokeOverFill] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'strokeOverFill');

  // Real per-family weights from the installed-font catalog (async, cached).
  const [, fontsReady] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    void loadFontCatalog();
    return onFontCatalogReady(fontsReady);
  }, []);
  const availableWeights = getFontWeights(String(fontFamily ?? 'Inter'));

  // A live selection in the on-canvas editor turns the character controls from
  // "this layer" into "these characters". Only this node's selection counts —
  // the inspector can be showing a layer other than the one being edited.
  const editingNodeId = useTextEditStore((s) => s.nodeId);
  const rawSelection = useTextEditStore((s) => s.selection);
  const selection = editingNodeId === nodeId ? rawSelection : null;
  const ranged = hasRange(selection);

  if (!tComp) return null;

  const contentStrRaw = String(content ?? '');
  const textLen = [...contentStrRaw].length;

  /** The runs style covering the selection, and which fields disagree across it. */
  const rangeStyle = ranged
    ? styleOverRange(readRuns(node), selection.start, selection.end, textLen)
    : { style: {} as Partial<TextStyle>, mixed: new Set<RunStyleKey>() };

  /**
   * Write one character property.
   *
   * With a range selected the value becomes a run over those characters; with
   * no range it stays a layer-wide prop, exactly as before. Routing both through
   * here is what keeps "select nothing, set size" behaving the way it always has.
   */
  const setCharProp = <K extends RunStyleKey>(
    key: K,
    value: TextStyle[K],
    setLayerWide: (v: TextStyle[K]) => void,
  ): void => {
    if (!ranged) {
      setLayerWide(value);
      return;
    }
    writeRuns(
      nodeId,
      applyStyleToRange(readRuns(node), selection.start, selection.end, { [key]: value }, textLen),
    );
  };

  /** What a character control should display: the run's value over the
   *  selection, else the layer's. `mixed` means the selection disagrees — the
   *  control must say so rather than show the first character and overwrite
   *  the rest on the next edit. */
  const charValue = <K extends RunStyleKey>(key: K, layerValue: TextStyle[K]): {
    value: TextStyle[K] | undefined;
    mixed: boolean;
  } => {
    if (!ranged) return { value: layerValue, mixed: false };
    if (rangeStyle.mixed.has(key)) return { value: undefined, mixed: true };
    return { value: (rangeStyle.style[key] ?? layerValue) as TextStyle[K], mixed: false };
  };

  const applyPreset = (preset: typeof PRESETS[number]) => {
    if (ranged) {
      // A preset is a bundle of character properties, so over a selection it
      // means the same thing the individual controls do: style these glyphs.
      writeRuns(
        nodeId,
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
    setFontSize(preset.fontSize);
    setFontWeight(preset.fontWeight);
    setFontStyle(preset.fontStyle);
    if (preset.fontFamily) setFontFamily(preset.fontFamily);
  };

  const clearRunStyling = (): void => {
    if (!ranged) return;
    writeRuns(
      nodeId,
      applyStyleToRange(
        readRuns(node),
        selection.start,
        selection.end,
        { fontSize: undefined, fontFamily: undefined, fontWeight: undefined, fontStyle: undefined, letterSpacing: undefined, fill: undefined },
        textLen,
      ),
    );
  };

  const sizeChar = charValue('fontSize', typeof fontSize === 'number' ? fontSize : 32);
  const trackingChar = charValue('letterSpacing', typeof letterSpacing === 'number' ? letterSpacing : 0);
  const familyChar = charValue('fontFamily', String(fontFamily ?? 'Inter'));
  const weightChar = charValue('fontWeight', String(fontWeight ?? '400'));
  const styleChar = charValue('fontStyle', String(fontStyle ?? 'normal'));
  const fillChar = charValue('fill', String(fill ?? '#ffffff'));

  const fontSizeVal = sizeChar.value ?? 32;
  const letterSpacingVal = trackingChar.value ?? 0;
  const lineHeightVal = typeof lineHeight === 'number' ? lineHeight : 1.2;
  const paragraphSpacingVal = typeof paragraphSpacing === 'number' ? paragraphSpacing : 0;

  // Path Options — text rides one of the layer's own masks, as in AE.
  const fxProps = node.components.find((c) => c.type === 'fx')?.props as
    | { mask?: { paths?: MaskPath[] } }
    | undefined;
  const maskPaths: MaskPath[] = fxProps?.mask?.paths ?? [];
  const textPathCfg = readTextPathConfig(node);
  const activePathId = textPathCfg
    ? textPathCfg.pathId || (maskPaths[0]?.id ?? '')
    : '';

  const renderTextPropInner = (
    label: string,
    propName: string,
    value: number,
    setVal: (v: number) => void,
    unit = '',
    resetVal?: number,
    /** The run field this prop maps to, when it can be set per character. */
    runKey?: RunStyleKey,
  ) => {
    // Over a selection the value becomes a run, and runs are static by design
    // (per-character *static* styling) — so the keyframe toggle is not offered
    // there rather than being offered and quietly doing something else.
    const rangedProp = ranged && runKey !== undefined;
    const animated = defaultAnimation.isAnimated(nodeId, propName);
    const displayVal = rangedProp
      ? value
      : animated
        ? defaultAnimation.sample(nodeId, propName, layerT) ?? value
        : value;

    const handleChange = (v: number) => {
      if (rangedProp) {
        setCharProp(runKey, v, setVal as (x: unknown) => void);
      } else if (animated) {
        runAnimEdit(
          `Set ${propName}`,
          () => defaultAnimation.setKeyframe(nodeId, propName, layerT, v),
          `text:${nodeId}:${propName}:${layerT}`
        );
      } else {
        setVal(v);
      }
    };

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit(`Remove ${propName} animation`, () =>
          defaultAnimation.removeTrack(nodeId, propName)
        );
      } else {
        runAnimEdit(`Animate ${propName}`, () =>
          defaultAnimation.setKeyframe(nodeId, propName, layerT, value)
        );
      }
    };

    return (
      <div className={styles.popoverRow} key={propName}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
          <Checkbox
            checked={animated && !rangedProp}
            onChange={toggleAnim}
            disabled={rangedProp}
            title={rangedProp ? 'Per-character styling is static — keyframe the layer instead' : 'Toggle Keyframes'}
            style={{ width: 13, height: 13 }}
          />
          <span className={styles.popoverLabel}>{label}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <ValueField value={Number(displayVal)} unit={unit} onChange={handleChange} />
          {resetVal !== undefined && (
            <button
              type="button"
              title={`Reset ${label}`}
              onClick={() => handleChange(resetVal)}
              className={styles.resetBtn}
            >
              <Icon name="rotate" size={10} />
            </button>
          )}
        </div>
      </div>
    );
  };

  // Per-row animated state renders inside each row's own keyframe checkbox
  // (renderTextPropInner / ColorKfRow) now that the rows are inline.
  //
  // Source Text keyframes (AE): when the `text.source` data track is live, the
  // field shows the SAMPLED string at the playhead, and typing writes a
  // keyframe at the playhead rather than the static prop — otherwise edits on
  // an animated layer would vanish (the renderer reads the track, every write
  // went to the prop).
  const sourceAnimated = defaultAnimation.isDataAnimated(nodeId, 'text.source');
  const sampledSource = sourceAnimated
    ? defaultAnimation.sampleData(nodeId, 'text.source', layerT)
    : undefined;
  const contentStr = typeof sampledSource === 'string' ? sampledSource : String(content ?? '');
  const onContentEdit = (next: string): void => {
    if (sourceAnimated) {
      runAnimEdit('Edit Source Text keyframe', () => {
        defaultAnimation.setDataKeyframe(nodeId, 'text.source', 'text', layerT, next);
      }, `srcText:${nodeId}`);
    } else {
      setContent(next);
    }
  };
  const toggleSourceStopwatch = (): void => {
    if (sourceAnimated) {
      runAnimEdit('Remove Source Text keyframes', () => {
        defaultAnimation.setDataTrack(nodeId, 'text.source', null);
      });
    } else {
      runAnimEdit('Animate Source Text', () => {
        defaultAnimation.setDataKeyframe(nodeId, 'text.source', 'text', layerT, contentStr);
      });
    }
  };

  // Flattened inline rows — every character property visible at a glance.
  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Character</h4>

      {/* Without this the panel would silently change meaning: the same click
          styles six glyphs instead of the layer, with nothing on screen saying
          so. Naming the range (and offering the way out) is the whole
          affordance for per-character styling. */}
      {ranged && (
        <div className={styles.popoverRow} style={{ gap: 6 }}>
          <span className={styles.popoverLabel} style={{ color: 'var(--color-primary, #4c8dff)' }}>
            {`Styling ${selection.end - selection.start} character${selection.end - selection.start === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            onClick={clearRunStyling}
            className={styles.presetChip}
            style={{ fontSize: 10, padding: '2px 8px' }}
            title="Remove per-character styling from the selection"
          >
            Reset
          </button>
        </div>
      )}

      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Content</span>
          <button
            type="button"
            onClick={toggleSourceStopwatch}
            className={styles.presetChip}
            style={{
              padding: '2px 5px',
              fontSize: 10,
              color: sourceAnimated ? 'var(--color-primary, #4c8dff)' : undefined,
            }}
            title={sourceAnimated
              ? 'Source Text is keyframed — click to remove all Source Text keyframes'
              : 'Keyframe Source Text at the playhead (hold keyframes, like AE)'}
            aria-pressed={sourceAnimated}
            aria-label="Toggle Source Text keyframes"
          >
            <Icon name="keyframe" size={10} />
          </button>
          <input
            type="text"
            value={contentStr}
            onChange={(e) => onContentEdit(e.target.value)}
            className={styles.textInput}
            style={{ flex: 1, minWidth: 0, height: 24, padding: '2px 8px' }}
            aria-label="Text content"
          />
        </div>

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Family</span>
          <FontPicker
            value={String(familyChar.value ?? 'Inter')}
            onChange={(family) => setCharProp('fontFamily', family, (v) => setFontFamily(v))}
          />
        </div>

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Weight</span>
          <select
            value={weightChar.mixed ? '__mixed' : String(weightChar.value ?? '400')}
            onChange={(e) => setCharProp('fontWeight', e.target.value, (v) => setFontWeight(v))}
            className={styles.select}
            style={{ width: 130 }}
          >
            {/* A selection spanning two weights has no single value to show.
                An unselectable Mixed entry is the honest answer; picking any
                real option from here is a deliberate "make them all this". */}
            {weightChar.mixed && <option value="__mixed" disabled>Mixed</option>}
            {availableWeights.map((w) => (
              <option key={w} value={String(w)}>{WEIGHT_LABELS[w] ?? String(w)}</option>
            ))}
            {/* Keep an out-of-catalog stored weight selectable rather than
                snapping the select to a wrong value. */}
            {!weightChar.mixed && !availableWeights.includes(Number(weightChar.value ?? 400)) && (
              <option value={String(weightChar.value ?? '400')}>{String(weightChar.value ?? '400')}</option>
            )}
          </select>
        </div>

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Style</span>
          <select
            value={styleChar.mixed ? '__mixed' : String(styleChar.value ?? 'normal')}
            onChange={(e) => setCharProp('fontStyle', e.target.value, (v) => setFontStyle(v))}
            className={styles.select}
            style={{ width: 110 }}
          >
            {styleChar.mixed && <option value="__mixed" disabled>Mixed</option>}
            <option value="normal">Normal</option>
            <option value="italic">Italic</option>
          </select>
        </div>

        {renderTextPropInner('Size', 'fontSize', fontSizeVal, setFontSize, 'px', 32, 'fontSize')}
        {renderTextPropInner('Tracking', 'letterSpacing', letterSpacingVal, setLetterSpacing, 'px', 0, 'letterSpacing')}
        {/* Leading is a paragraph property, not a character one — it has no
            run key, so it stays layer-wide even with a selection. */}
        {renderTextPropInner('Leading', 'lineHeight', lineHeightVal, setLineHeight, 'em', 1.2)}
        {renderTextPropInner('Paragraph', 'paragraphSpacing', paragraphSpacingVal, setParagraphSpacing, 'px', 0)}

        {/* AE's Fill & Stroke order. Only meaningful once something gives the
            glyphs a stroke — today that is a text animator's Stroke Width — so
            it sits with the other layer-wide text properties rather than in the
            animator, which is per-character. Under is the default: a stroke
            centres on the outline, so over-the-fill eats half its width out of
            the letterforms. */}
        <div className={styles.popoverRow}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
            <Checkbox
              checked={strokeOverFill === true}
              onChange={() => setStrokeOverFill(strokeOverFill !== true)}
              title="Paint the glyph stroke over the fill instead of under it"
              style={{ width: 13, height: 13 }}
            />
            <span className={styles.popoverLabel}>Stroke Over Fill</span>
          </div>
        </div>

        {/* NOT the same control as Appearance's fill, though it writes the same
            prop when nothing is selected: with a character range selected this
            writes a per-RUN colour, which Appearance cannot do. It was labelled
            "Color" in both places, so the two rows looked like a duplicate of
            each other — the label now says which one this is. */}
        <ColorKfRow
          nodeId={nodeId}
          propPrefix="fill"
          label="Character Color"
          value={String(fillChar.value ?? '#ffffff')}
          setValue={(val) => setCharProp('fill', val, (v) => setFill(v))}
        />

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Align</span>
          <select
            value={String(align ?? 'left')}
            onChange={(e) => setAlign(e.target.value)}
            className={styles.select}
            style={{ width: 100 }}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
            <option value="justify">Justify</option>
          </select>
        </div>

        <div className={styles.subhead} style={{ marginTop: 8 }}>Path Options</div>
        {maskPaths.length === 0 ? (
          // Say why the control is empty. A disabled dropdown with no reason is
          // the read-gap pattern — the user cannot tell "unsupported" from
          // "you haven't drawn one yet".
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel} style={{ opacity: 0.7 }}>
              Draw a mask on this layer to use it as a text path
            </span>
          </div>
        ) : (
          <>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Path</span>
              <select
                value={activePathId}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) setTextPath(nodeId, null);
                  else updateTextPath(nodeId, { ...(textPathCfg ?? defaultTextPath()), pathId: id });
                }}
                className={styles.select}
                style={{ width: 130 }}
              >
                <option value="">None</option>
                {maskPaths.map((p, i) => (
                  <option key={p.id} value={p.id}>{`Mask ${i + 1}`}</option>
                ))}
              </select>
            </div>
            {textPathCfg && (
              <>
                {renderTextPropInner(
                  'First Margin',
                  'textPath.firstMargin',
                  textPathCfg.firstMargin,
                  (v) => updateTextPath(nodeId, { firstMargin: v }),
                  'px',
                  0,
                )}
                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Reverse Path</span>
                  <Checkbox
                    checked={textPathCfg.reversed}
                    onChange={() => updateTextPath(nodeId, { reversed: !textPathCfg.reversed })}
                    style={{ width: 13, height: 13 }}
                  />
                </div>
                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Perpendicular</span>
                  <Checkbox
                    checked={textPathCfg.perpendicular}
                    onChange={() => updateTextPath(nodeId, { perpendicular: !textPathCfg.perpendicular })}
                    style={{ width: 13, height: 13 }}
                  />
                </div>
              </>
            )}
          </>
        )}

        <div className={styles.subhead} style={{ marginTop: 8 }}>Presets</div>
        <div className={styles.presetGrid} style={{ maxHeight: 140, overflowY: 'auto', gap: 4 }}>
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset)}
              className={styles.presetChip}
              style={{ fontSize: 10, padding: '4px 8px' }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default TextSection;
