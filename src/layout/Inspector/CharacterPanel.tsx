import { memo, useState, useMemo, useEffect, useRef, useSyncExternalStore } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useMirrorLayer, useMirrorTreeGroups } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { currentRuns, isSourceTextAnimated, maskIdsOf, mirrorParagraphBox, mirrorTextPresetCapture, SOURCE_TEXT_PATH, sourceTextAt, STYLE_RUNS_PATH, textPathOf } from '@layout/Text/textMirror';
import { componentPropCommands, useComponentProp, type ComponentPropHandle } from './useComponentProp';
import { componentOfType } from '@core/engine/propRefs';
import { useGesture } from '@hooks/useGesture';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands, fieldEdit, sourceTextCommand, sourceTextStopwatchCommand, textPresetEdit } from '@layout/Text/textEdits';
import { getFontWeights, WEIGHT_LABELS } from '@core/text/fontCatalog';
import { fontFamilyInfo, loadEngineFontList, onEngineFontListReady } from '@core/fonts/engineFontList';
import { useTextEditStore, hasRange, TEXT_EDIT_KEEP_ATTR } from '@stores/textEditStore';
import { applyStyleToRange, styleOverRange, type RunStyleKey, type RichRun } from '@core/text/richText';
import type { TextStyle } from '@core/text/textLayout';
import { graphemeCount } from '@core/text/graphemes';
import { AUTO_LEADING, STROKE_ORDERS, strokeOrderOf, type StrokeOrder, type StrokeLineJoin } from '@core/text/textExtras';
import { FontPicker } from './FontPicker';
import { SectionPresetMenu } from './SectionPresetMenu';
import { SectionMenuRegistry, SectionMenuSlot } from './sectionMenu';
import { installTextCommands, swapTextFillStroke } from './textCommands';
import { convertToParagraphText, convertToPointText, setBoxAutoSize } from './paragraphTextCommands';
import { MIN_BOX_SIZE, TATE_CHU_YOKO_DEFAULT_DIGITS, firstParagraphDirection, type BoxAutoSize, type BoxVerticalAlign } from '@core/text/textExtras';
import { useTextLayout } from '@hooks/useTextLayout';
import { Segmented } from '@components/Segmented';
import { Checkbox } from '@components/Checkbox';
import { ColorPicker } from '@components/ColorPicker';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { TooltipProvider } from '@components/Tooltip';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { useDockPanelHeader } from '@components/DockPanel';
import { TextFillRows, TextStrokeRows } from './TextFillRows';
import { TextBackgroundRows } from './TextBackgroundRows';
import { VariableAxesSection, TextPathOptions, OpenTypeControls } from './TextOptionControls';
import { TwirlGroup } from './appearance/TwirlGroup';
import { t } from '@core/i18n';
import styles from './CharacterPanel.module.css';

/* eslint-disable design-system/no-hex-color */
const DEFAULT_TEXT_FILL = '#ffffff';
const DEFAULT_TEXT_STROKE = '#000000';
/* eslint-enable design-system/no-hex-color */

/** Quick typography presets; labels are translated, so this runs at render time. */
function presets() {
  return [
    { label: t('inspector.character.presetDisplay', 'Display'), fontSize: 96, fontWeight: '800', fontStyle: 'normal' },
    { label: t('inspector.character.presetTitleL', 'Title (L)'), fontSize: 72, fontWeight: '700', fontStyle: 'normal' },
    { label: t('inspector.character.presetHeadline', 'Headline'), fontSize: 56, fontWeight: '700', fontStyle: 'normal' },
    { label: t('inspector.character.presetSubtitle', 'Subtitle'), fontSize: 48, fontWeight: '600', fontStyle: 'normal' },
    { label: t('inspector.character.presetBody', 'Body'), fontSize: 36, fontWeight: '400', fontStyle: 'normal' },
    { label: t('inspector.character.presetLower3rd', 'Lower 3rd'), fontSize: 28, fontWeight: '600', fontStyle: 'normal' },
    { label: t('inspector.character.presetCaption', 'Caption'), fontSize: 24, fontWeight: '400', fontStyle: 'normal' },
    { label: t('inspector.character.presetLabel', 'Label'), fontSize: 20, fontWeight: '500', fontStyle: 'normal' },
    { label: t('inspector.character.presetOverline', 'Overline'), fontSize: 14, fontWeight: '500', fontStyle: 'normal' },
    { label: t('inspector.character.presetQuote', 'Quote'), fontSize: 32, fontWeight: '300', fontStyle: 'italic' },
    { label: t('inspector.character.presetMono', 'Mono'), fontSize: 36, fontWeight: '500', fontStyle: 'normal', fontFamily: 'Fira Code' },
    { label: t('inspector.character.presetButton', 'Button'), fontSize: 16, fontWeight: '600', fontStyle: 'normal' },
  ];
}

/**
 * A stored alignment seen from the other edge. The Paragraph panel's buttons
 * are VISUAL; a right-to-left paragraph stores alignment from its start edge
 * (textExtras.resolveAlignForDirection), so in RTL each button reads and
 * writes its mirror.
 */
function mirrorAlign(a: string): string {
  switch (a) {
    case 'left': return 'right';
    case 'right': return 'left';
    case 'justify':
    case 'justify-left': return 'justify-right';
    case 'justify-right': return 'justify-left';
    default: return a;
  }
}

/** The Text component, resolved at write time (the mirror has no component ids — useComponentProp's ComponentRef). */
const TEXT_COMPONENT = { type: 'Text' } as const;

/** Stroke line joins; labels are translated, so this runs at render time. */
function lineJoins(): ReadonlyArray<{ value: StrokeLineJoin; label: string }> {
  return [
    { value: 'miter', label: t('inspector.character.joinMiter', 'Miter') },
    { value: 'round', label: t('inspector.character.joinRound', 'Round') },
    { value: 'bevel', label: t('inspector.character.joinBevel', 'Bevel') },
  ];
}

/**
 * AE's Character panel: the selection's text layer, or the defaults a new text
 * layer would take when nothing is selected. Its paragraph rows are the
 * Paragraph panel's (ParagraphPanel.tsx) — the same body, the other variant.
 */
export function CharacterPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  return <TextSettingsBody nodeId={selected[0]} nodeIds={selected} variant="character" />;
}

export interface TextSettingsBodyProps {
  /** The text layer to edit. Absent in the standalone panel with nothing selected. */
  nodeId?: string;
  /** Every layer a text style preset applies to, primary first. */
  nodeIds?: ReadonlyArray<string>;
  /**
   * `character` — the Character panel: AE's character rows, then the Source
   * Text, Text Box, Path Options and Presets groups.
   * `paragraph` — the Paragraph panel: alignment, indents, spacing, direction.
   * `section` — the Properties panel's Text section: AE's Character and
   * Paragraph as two twirl-downs and the rarer controls behind a collapsed
   * "More text options", sized for a ~280px column.
   * `panel` — what `character` was called while one panel held both (until
   * 2026-10); kept so an older caller still gets the Character panel.
   */
  variant?: 'character' | 'paragraph' | 'section' | 'panel';
}

/**
 * Character + Paragraph settings — ONE implementation of every text control,
 * arranged three ways (the Character panel, the Paragraph panel, the Properties
 * Text section). The Properties section and the Text panel were once two copies
 * (the old TextSection was deleted for drifting from this panel), so the
 * handlers, fallbacks and range styling below are shared and only the layout at
 * the bottom differs.
 */
/** The tree groups the Text settings read. */
const TEXT_TREE_GROUPS = ['text', 'masks'] as const;

/**
 * Memoized: in the Properties panel this sits under rows that re-render on
 * every step of a Position / Scale drag, and the whole Character + Paragraph
 * body re-rendered with them (3 ms a pointer move on a text layer). Its own
 * subscriptions (the mirror keys, groups and props below) are what it reacts
 * to — the Character panel mounts it with nothing above that re-renders.
 */
export const TextSettingsBody = memo(TextSettingsBodyInner);

function TextSettingsBodyInner({ nodeId, nodeIds, variant = 'character' }: TextSettingsBodyProps): JSX.Element {
  const primary = nodeId;
  const selected = useMemo(() => nodeIds ?? (nodeId ? [nodeId] : []), [nodeIds, nodeId]);
  /** The dock panels — not the Properties section, which lives in ANOTHER panel's dock slot. */
  const isCharacterPanel = variant === 'character' || variant === 'panel';
  const isParagraphPanel = variant === 'paragraph';
  // Swap Fill and Stroke (Shift+X) is a registered command.
  useEffect(() => installTextCommands(), []);

  const time = useActiveWorkspace()?.time ?? 0;

  // B4: the layer, its tree (style runs, masks, Path Options) and Source Text's keys / value from the mirror;
  // each field below wakes on its own property (useComponentProp).
  const layer = useMirrorLayer(primary);
  // Only the Text group (style runs, Path Options) and the masks a text path follows.
  useMirrorTreeGroups(primary, TEXT_TREE_GROUPS);
  useMirrorKeys(primary ? [`prop:${primary}|${STYLE_RUNS_PATH}`, `key:${primary}|${SOURCE_TEXT_PATH}`, `value:${primary}|${SOURCE_TEXT_PATH}`] : []);
  const m = documentMirror();
  const isText = uiKindOf(layer) === 'text';
  const tComp = isText ? TEXT_COMPONENT : undefined;
  // The Text Box card's measured facts (content height, overflow, text on a path) — the engine's.
  // The Paragraph panel draws no Text Box, so it asks for none.
  const textLayout = useTextLayout(isText && !isParagraphPanel ? primary : null);

  // Bound layer hooks — Character properties
  const [content, setContent] = useComponentProp(primary, tComp, 'content');
  const [fontSize, setFontSize, fontSizeH] = useComponentProp(primary, tComp, 'fontSize');
  const [fontFamily, setFontFamily] = useComponentProp(primary, tComp, 'fontFamily');
  const [fontWeight, setFontWeight] = useComponentProp(primary, tComp, 'fontWeight');
  const [fontStyle, setFontStyle] = useComponentProp(primary, tComp, 'fontStyle');
  const [fill, setFill] = useComponentProp(primary, tComp, 'fill');
  const [stroke, setStroke] = useComponentProp(primary, tComp, 'stroke');
  const [strokeWidth, setStrokeWidth, strokeWidthH] = useComponentProp(primary, tComp, 'strokeWidth');
  const [letterSpacing] = useComponentProp(primary, tComp, 'letterSpacing');
  // AE's tracking (1/1000 em, `text/tracking`); `letterSpacing` is the older px field a document may still carry.
  const [tracking, , trackingH] = useComponentProp(primary, tComp, 'tracking');
  const [lineHeight, setLineHeight, lineHeightH] = useComponentProp(primary, tComp, 'lineHeight');
  // Point text anchored at the box centre (every older document) or AE's alignment edge.
  const [textAnchor, setTextAnchor] = useComponentProp(primary, tComp, 'textAnchor');
  const [strokeOverFill] = useComponentProp(primary, tComp, 'strokeOverFill');
  const [strokeOrder] = useComponentProp(primary, tComp, 'strokeOrder');
  const [strokeLineJoin, setStrokeLineJoin] = useComponentProp(primary, tComp, 'strokeLineJoin');
  const [noFill, setNoFill] = useComponentProp(primary, tComp, 'noFill');
  const [noStroke, setNoStroke] = useComponentProp(primary, tComp, 'noStroke');
  const [fauxBold, setFauxBold] = useComponentProp(primary, tComp, 'fauxBold');
  const [fauxItalic, setFauxItalic] = useComponentProp(primary, tComp, 'fauxItalic');
  const [kerningMode, setKerningMode] = useComponentProp(primary, tComp, 'kerningMode');
  const [boxWidth, setBoxWidth] = useComponentProp(primary, tComp, 'boxWidth');
  const [boxHeight, setBoxHeight] = useComponentProp(primary, tComp, 'boxHeight');
  const [boxVerticalAlign, setBoxVerticalAlign] = useComponentProp(primary, tComp, 'boxVerticalAlign');
  const [verticalScale, setVerticalScale] = useComponentProp(primary, tComp, 'verticalScale');
  const [horizontalScale, setHorizontalScale] = useComponentProp(primary, tComp, 'horizontalScale');
  const [baselineShift, setBaselineShift] = useComponentProp(primary, tComp, 'baselineShift');
  const [textTransform, setTextTransform] = useComponentProp(primary, tComp, 'textTransform');
  const [fontVariant, setFontVariant] = useComponentProp(primary, tComp, 'fontVariant');
  const [verticalAlign, setVerticalAlign] = useComponentProp(primary, tComp, 'verticalAlign');

  // Bound layer hooks — Paragraph properties
  const [align, setAlign] = useComponentProp(primary, tComp, 'align');
  const [paragraphSpacing, setParagraphSpacing] = useComponentProp(primary, tComp, 'paragraphSpacing');
  const [leftIndent, setLeftIndent] = useComponentProp(primary, tComp, 'leftIndent');
  const [rightIndent, setRightIndent] = useComponentProp(primary, tComp, 'rightIndent');
  const [firstLineIndent, setFirstLineIndent] = useComponentProp(primary, tComp, 'firstLineIndent');
  const [spaceBefore, setSpaceBefore] = useComponentProp(primary, tComp, 'spaceBefore');
  const [spaceAfter, setSpaceAfter] = useComponentProp(primary, tComp, 'spaceAfter');
  const [direction, setDirection] = useComponentProp(primary, tComp, 'direction');
  const [orientation, setOrientation] = useComponentProp(primary, tComp, 'orientation');
  const [verticalRomanAlignment, setVerticalRomanAlignment] = useComponentProp(primary, tComp, 'verticalRomanAlignment');
  const [tateChuYokoAuto] = useComponentProp(primary, tComp, 'tateChuYokoAuto');
  const [tateChuYokoDigits] = useComponentProp(primary, tComp, 'tateChuYokoDigits');

  /** The Content box's typing session (one gesture per focus — see onContentEdit). */
  const sourceTyping = useGesture({ quiet: true });
  /** Per number field: is a typing session open, and on which route (see `typing`). */
  const typingState = useRef<Record<string, { open: boolean }>>({});

  // Local fallback states when no text layer is active
  const [fallbackFamily, setFallbackFamily] = useState('Inter');
  const [fallbackWeight, setFallbackWeight] = useState('400');
  const [fallbackStyle, setFallbackStyle] = useState('normal');
  const [fallbackSize, setFallbackSize] = useState(72);
  /** undefined = Auto leading. */
  const [fallbackLeading, setFallbackLeading] = useState<number | undefined>(undefined);
  const [fallbackTracking, setFallbackTracking] = useState(0);
  const [fallbackFill, setFallbackFill] = useState(DEFAULT_TEXT_FILL);
  const [fallbackStroke, setFallbackStroke] = useState(DEFAULT_TEXT_STROKE);
  const [fallbackStrokeWidth, setFallbackStrokeWidth] = useState(0);
  const [fallbackStrokeOrder, setFallbackStrokeOrder] = useState<StrokeOrder>('fill-over-stroke');
  const [fallbackLineJoin, setFallbackLineJoin] = useState<StrokeLineJoin>('round');
  const [fallbackNoFill, setFallbackNoFill] = useState(false);
  const [fallbackNoStroke, setFallbackNoStroke] = useState(false);
  const [fallbackFauxBold, setFallbackFauxBold] = useState(false);
  const [fallbackFauxItalic, setFallbackFauxItalic] = useState(false);
  const [fallbackKerningMode, setFallbackKerningMode] = useState<'metrics' | 'optical'>('metrics');
  const [fallbackVertScale, setFallbackVertScale] = useState(100);
  const [fallbackHorizScale, setFallbackHorizScale] = useState(100);
  const [fallbackBaselineShift, setFallbackBaselineShift] = useState(0);
  const [fallbackTextTransform, setFallbackTextTransform] = useState('none');
  const [fallbackFontVariant, setFallbackFontVariant] = useState('normal');
  const [fallbackVerticalAlign, setFallbackVerticalAlign] = useState('baseline');
  const [fallbackAlign, setFallbackAlign] = useState('left');
  const [fallbackSpacing, setFallbackSpacing] = useState(0);
  const [fallbackFirstLineIndent, setFallbackFirstLineIndent] = useState(0);
  const [fallbackLeftIndent, setFallbackLeftIndent] = useState(0);
  const [fallbackRightIndent, setFallbackRightIndent] = useState(0);
  const [fallbackSpaceBefore, setFallbackSpaceBefore] = useState(0);
  const [fallbackSpaceAfter, setFallbackSpaceAfter] = useState(0);
  const [fallbackDirection, setFallbackDirection] = useState<'ltr' | 'rtl' | 'auto'>('ltr');
  const [fallbackOrientation, setFallbackOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  const [fallbackTextAnchor, setFallbackTextAnchor] = useState<'center' | 'alignment'>('alignment');
  const [fallbackRoman, setFallbackRoman] = useState(false);
  const [fallbackTcyAuto, setFallbackTcyAuto] = useState(false);
  const [fallbackTcyDigits, setFallbackTcyDigits] = useState(TATE_CHU_YOKO_DEFAULT_DIGITS);
  /** The section layout's "More text options" — shut by default: they are the rarer controls. */
  const [moreOpen, setMoreOpen] = useState(false);
  /**
   * AE's swatch pair: the square clicked last is "in front", and the ⊘ under
   * the pair applies None to that one. Editor state, never the document's.
   */
  const [frontPaint, setFrontPaint] = useState<'fill' | 'stroke'>('fill');

  const hasTarget = Boolean(primary && tComp && layer);

  // Range styling state
  const editingNodeId = useTextEditStore((s) => s.nodeId);
  const rawSelection = useTextEditStore((s) => s.selection);
  const selection = hasTarget && editingNodeId === primary ? rawSelection : null;
  const ranged = hasRange(selection);

  const contentStrRaw = String(content ?? '');
  // Grapheme clusters — the index space runs and the edit selection use.
  const textLen = graphemeCount(contentStrRaw);

  // ── The Character panel's dock header ──
  // The subject goes in the tab ("Character: Title"), and the saved text
  // styles — the panel's old "Presets ▾" header button — in its ≡ menu. Only
  // the dock panels hand these over: the Properties section sits in the
  // PROPERTIES panel's dock slot, whose menu and title are not its to set.
  const dockHeader = useDockPanelHeader();
  const setCustomMenuItems = dockHeader?.setCustomMenuItems;
  const setTitleDetail = dockHeader?.setTitleDetail;
  // The text style presets are the Properties Text section's own menu
  // component (SectionPresetMenu): mounted in a slot below it draws nothing and
  // registers its rows here, so both menus offer the same "Text Style Presets ▸"
  // from one implementation. The registry hands out the SAME array until a row
  // a reader can see changes — handing the dock a fresh array per render is the
  // v0.8.1 update loop (PropertiesPanel.dockMenu.native.test.tsx).
  const [presetMenu] = useState(() => new SectionMenuRegistry());
  const presetRows = useSyncExternalStore(presetMenu.subscribe, presetMenu.rows);
  useEffect(() => {
    if (!isCharacterPanel || !setCustomMenuItems) return;
    setCustomMenuItems(presetRows);
    return () => setCustomMenuItems([]);
  }, [isCharacterPanel, setCustomMenuItems, presetRows]);
  const subject = isCharacterPanel && hasTarget ? layer?.name || null : null;
  useEffect(() => {
    if (!isCharacterPanel || !setTitleDetail) return;
    setTitleDetail(subject);
    return () => setTitleDetail(null);
  }, [isCharacterPanel, setTitleDetail, subject]);

  // The panels' group rows (Source Text, Text Box …) remember their open state
  // the way the Properties sections do; ids are prefixed, so they never collide.
  const groupsOpen = usePreferenceStore((s) => s.inspectorSections);
  const setPref = usePreferenceStore((s) => s.set);
  const toggleGroup = (id: string, open: boolean): void => {
    setPref('inspectorSections', { ...usePreferenceStore.getState().inspectorSections, [id]: open });
  };

  /**
   * Style the characters `lo..hi` — the ONE place this panel writes style runs,
   * one undo step each (writeRuns alone bypasses history).
   */
  const restyleRange = (label: string, lo: number, hi: number, patch: Partial<TextStyle>): void => {
    if (!primary || !hasTarget) return;
    // The runs are computed here (pure) and sent whole: `text/styleRuns` (G1).
    const runs: RichRun[] = applyStyleToRange(currentRuns(primary), lo, hi, patch, textLen);
    void edit(label, fieldCommands(primary, 'text/styleRuns', runs));
  };

  const setCharProp = <K extends RunStyleKey>(
    key: K,
    val: TextStyle[K],
    setLayerWide: (v: TextStyle[K]) => void,
  ): void => {
    if (!ranged || !hasTarget || !primary) {
      setLayerWide(val);
      return;
    }
    restyleRange('Style Characters', selection.start, selection.end, { [key]: val });
  };

  /**
   * A number field's typing (and its spinner) inside one focus = ONE entry on
   * the engine route (ENGINE_API.md §5.3: text field focus → commit). Ranged
   * edits write style runs, which the engine cannot address, so they never
   * open the gesture.
   */
  const typing = (
    key: string,
    h: ComponentPropHandle,
    set: (v: unknown) => void,
  ): { begin: () => void; set: (v: unknown) => void; onBlur: () => void } => {
    const s = (typingState.current[key] ??= { open: false });
    return {
      begin: () => {
        if (ranged || s.open) return;
        s.open = true;
        // Opens the gesture only when the engine addresses the prop (a text
        // LAYER's Size / Leading / Tracking / Stroke Width always is — G1 +
        // the latent bindings); otherwise every write is refused, visibly.
        h.scrub.onScrubStart();
      },
      set,
      onBlur: () => {
        s.open = false;
        h.scrub.onScrubEnd();
      },
    };
  };
  const strokeWidthTyping = typing('strokeWidth', strokeWidthH, setStrokeWidth);
  /** A ValueField's scrub is one engine gesture — never for a ranged edit (style runs). */
  const scrubOf = (h: ComponentPropHandle): { onScrubStart?: () => void; onScrubEnd?: () => void } => (ranged ? {} : h.scrub);

  const clearRunStyling = (): void => {
    if (!ranged || !hasTarget || !primary) return;
    restyleRange('Reset Character Styling', selection.start, selection.end, {
      fontSize: undefined, fontFamily: undefined, fontWeight: undefined, fontStyle: undefined,
      letterSpacing: undefined, fill: undefined, kerning: undefined, fauxBold: undefined, fauxItalic: undefined,
      strokeColor: undefined, strokeWidth: undefined, lineHeight: undefined, horizontalScale: undefined,
      verticalScale: undefined, baselineShift: undefined, tsume: undefined, allCaps: undefined,
      smallCaps: undefined, verticalAlign: undefined, tateChuYoko: undefined,
    });
  };

  const activeFamily = hasTarget ? String(fontFamily ?? 'Inter') : fallbackFamily;
  const activeWeight = hasTarget ? String(fontWeight ?? '400') : fallbackWeight;
  const activeStyle = hasTarget ? String(fontStyle ?? 'normal') : fallbackStyle;
  const activeSize = hasTarget ? Math.round(Number(fontSize ?? 72)) : fallbackSize;
  // AE leading: Auto (120% of size) or an explicit value. Auto is stored as
  // "no lineHeight", which every reader already renders at 1.2.
  const leadingIsAuto = hasTarget ? typeof lineHeight !== 'number' : fallbackLeading === undefined;
  const activeLeading = hasTarget
    ? (typeof lineHeight === 'number' ? lineHeight : AUTO_LEADING)
    : (fallbackLeading ?? AUTO_LEADING);
  // Tracking as AE shows it (1/1000 em): the `tracking` field plus whatever
  // px letter spacing an older document still carries, at this size.
  const legacyTrackingEm = hasTarget && typeof letterSpacing === 'number' && activeSize > 0 ? (letterSpacing / activeSize) * 1000 : 0;
  const activeTracking = hasTarget ? Math.round(Number(tracking ?? 0) + legacyTrackingEm) : fallbackTracking;
  const currentTextAnchor: 'center' | 'alignment' = hasTarget ? (textAnchor === 'alignment' ? 'alignment' : 'center') : fallbackTextAnchor;
  const activeFill = hasTarget ? String(fill ?? DEFAULT_TEXT_FILL) : fallbackFill;
  const activeStroke = hasTarget ? String(stroke ?? DEFAULT_TEXT_STROKE) : fallbackStroke;
  const activeStrokeWidth = hasTarget ? Number(strokeWidth ?? 0) : fallbackStrokeWidth;
  const activeStrokeOrder: StrokeOrder = hasTarget
    ? strokeOrderOf(
        STROKE_ORDERS.some((o) => o.value === strokeOrder) ? (strokeOrder as StrokeOrder) : undefined,
        strokeOverFill === true,
      )
    : fallbackStrokeOrder;
  const activeLineJoin: StrokeLineJoin = hasTarget
    ? (lineJoins().some((j) => j.value === strokeLineJoin) ? (strokeLineJoin as StrokeLineJoin) : 'round')
    : fallbackLineJoin;
  const activeNoFill = hasTarget ? noFill === true : fallbackNoFill;
  const activeNoStroke = hasTarget ? noStroke === true : fallbackNoStroke;
  const activeKerningMode = hasTarget ? (kerningMode === 'optical' ? 'optical' : 'metrics') : fallbackKerningMode;
  const activeVertScale = hasTarget ? Number(verticalScale ?? 100) : fallbackVertScale;
  const activeHorizScale = hasTarget ? Number(horizontalScale ?? 100) : fallbackHorizScale;
  const activeBaselineShift = hasTarget ? Number(baselineShift ?? 0) : fallbackBaselineShift;
  const activeTextTransform = hasTarget ? String(textTransform ?? 'none') : fallbackTextTransform;
  const activeFontVariant = hasTarget ? String(fontVariant ?? 'normal') : fallbackFontVariant;
  const activeVerticalAlign = hasTarget ? String(verticalAlign ?? 'baseline') : fallbackVerticalAlign;

  const currentDirection: 'ltr' | 'rtl' | 'auto' = hasTarget
    ? (direction === 'rtl' || direction === 'auto' ? direction : 'ltr')
    : fallbackDirection;
  /** The direction the alignment buttons mirror by: 'auto' reads the first paragraph. */
  const effectiveDirection = firstParagraphDirection(currentDirection, hasTarget ? contentStrRaw : '');
  const currentOrientation: 'horizontal' | 'vertical' = hasTarget
    ? (orientation === 'vertical' ? 'vertical' : 'horizontal')
    : fallbackOrientation;
  const currentRoman = hasTarget ? verticalRomanAlignment === true : fallbackRoman;
  const currentTcyAuto = hasTarget ? tateChuYokoAuto === true : fallbackTcyAuto;
  const currentTcyDigits = hasTarget
    ? (typeof tateChuYokoDigits === 'number' ? Math.max(1, Math.min(4, Math.round(tateChuYokoDigits))) : TATE_CHU_YOKO_DEFAULT_DIGITS)
    : fallbackTcyDigits;
  const storedAlign = hasTarget ? String(align ?? 'left') : fallbackAlign;
  /** The alignment as the buttons show it (mirrored in a right-to-left paragraph). */
  const currentAlign = effectiveDirection === 'rtl' ? mirrorAlign(storedAlign) : storedAlign;
  const currentSpacing = hasTarget ? Number(paragraphSpacing ?? 0) : fallbackSpacing;
  const currentLeftIndent = hasTarget ? Number(leftIndent ?? 0) : fallbackLeftIndent;
  const currentRightIndent = hasTarget ? Number(rightIndent ?? 0) : fallbackRightIndent;
  const currentFirstLineIndent = hasTarget ? Number(firstLineIndent ?? 0) : fallbackFirstLineIndent;
  const currentSpaceBefore = hasTarget ? Number(spaceBefore ?? 0) : fallbackSpaceBefore;
  const currentSpaceAfter = hasTarget ? Number(spaceAfter ?? 0) : fallbackSpaceAfter;

  // The weights the engine really draws for this family; the list arrives
  // once per session (the shipped families answer before it does).
  const [, setFontListReady] = useState(false);
  useEffect(() => {
    const off = onEngineFontListReady(() => setFontListReady(true));
    void loadEngineFontList();
    return off;
  }, []);
  const realWeights = getFontWeights(activeFamily);
  // A stored weight the family does not have still shows — as what it is.
  const activeWeightNum = Number(activeWeight);
  const weightMissing = Number.isFinite(activeWeightNum) && !realWeights.includes(activeWeightNum);
  const availableWeights = weightMissing ? [...realWeights, activeWeightNum].sort((a, b) => a - b) : realWeights;

  // Manual kerning (AE): a value applies BETWEEN the two characters at the
  // caret — stored on the character before it. With a range selected it
  // applies after every selected character.
  const kernRange = ((): { lo: number; hi: number } | null => {
    if (!selection || !hasTarget) return null;
    if (selection.end > selection.start) return { lo: selection.start, hi: selection.end };
    return selection.start > 0 ? { lo: selection.start - 1, hi: selection.start } : null;
  })();
  const kernInfo = kernRange && hasTarget && primary ? styleOverRange(currentRuns(primary), kernRange.lo, kernRange.hi, textLen) : null;
  const manualKerning = kernInfo?.style.kerning ?? 0;
  const kerningMixed = kernInfo?.mixed.has('kerning') ?? false;

  // Source text keyframe support
  // The keyed value at the playhead (comp time: the mirror maps it through the layer's time).
  const sourceAnimated = Boolean(primary && isSourceTextAnimated(m, primary));
  const sampledSource = sourceAnimated && primary ? sourceTextAt(m, primary, time) : undefined;
  const contentStr = typeof sampledSource === 'string' ? sampledSource : contentStrRaw;

  /**
   * The Content box: every keystroke sends the WHOLE text (absolute — latest
   * wins) into one gesture that ends when the box loses focus, so a typing
   * session is one undo entry and the canvas follows each keystroke.
   */
  const onContentEdit = (next: string): void => {
    if (!hasTarget || !primary) return;
    const cmds = sourceTextCommand(primary, next, time);
    if (cmds) {
      if (!sourceTyping.isActive()) sourceTyping.begin(sourceAnimated ? 'Edit Source Text keyframe' : 'Edit Text');
      sourceTyping.send(cmds);
      return;
    }
    // Not a layer: useComponentProp refuses it (no engine property to write).
    setContent(next);
  };

  const toggleSourceStopwatch = (): void => {
    if (!primary) return;
    const cmds = sourceTextStopwatchCommand(primary, !sourceAnimated, time);
    if (cmds) void edit(sourceAnimated ? 'Remove Source Text keyframes' : 'Animate Source Text', cmds);
  };

  // Mask path riding
  // The layer's masks (`masks/<id>`) and the one Path Options ▸ Path rides ('' = none; an unset path is the first mask).
  const maskPaths = primary && hasTarget ? maskIdsOf(m, primary).map((id) => ({ id })) : [];
  const activePathId = primary && hasTarget ? textPathOf(m, primary) : '';

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

  /** `undefined` = Auto. With a range selected, the leading is the range's own
   *  (AE uses the largest leading on each line). */
  const handleLeadingChange = (l: number | undefined) => {
    if (ranged && hasTarget && primary) {
      restyleRange('Leading', selection.start, selection.end, { lineHeight: l });
      return;
    }
    if (hasTarget) setLineHeight(l);
    else setFallbackLeading(l);
  };

  /**
   * Tracking in 1/1000 em (AE). Layer-wide it is the `tracking` field; a px
   * `letterSpacing` an older document carries is folded into it on the first
   * write (one entry), so the value keeps its look when the size changes. A
   * range stores `tracking` on its run too (the engine resolves it at the
   * run's own size), and a legacy px `letterSpacing` on the run is dropped.
   */
  const handleTrackingChange = (tr: number) => {
    if (!Number.isFinite(tr)) return;
    if (ranged && hasTarget && primary) {
      restyleRange('Tracking', selection.start, selection.end, { tracking: tr === 0 ? undefined : tr, letterSpacing: undefined });
      return;
    }
    if (!hasTarget || !primary) {
      setFallbackTracking(tr);
      return;
    }
    const cmds = fieldCommands(primary, 'text/tracking', tr);
    const textComponent = componentOfType(primary, 'Text');
    if (legacyTrackingEm !== 0 && textComponent) cmds.push(...(componentPropCommands(primary, textComponent, 'letterSpacing', 0, time) ?? []));
    void edit('Set Tracking', cmds);
  };

  const handleFillChange = (c: string) => {
    setCharProp('fill', c, (v) => {
      if (hasTarget) setFill(v as string);
      else setFallbackFill(v as string);
    });
  };

  const handleStrokeChange = (c: string) => {
    setCharProp('strokeColor', c, (v) => {
      if (hasTarget) setStroke(v as string);
      else setFallbackStroke(v as string);
    });
  };

  const handleStrokeWidthChange = (w: number) => {
    setCharProp('strokeWidth', w, (v) => {
      if (hasTarget) strokeWidthTyping.set(v as number);
      else setFallbackStrokeWidth(v as number);
    });
  };

  /** A per-range numeric style, or the layer-wide prop without a range. */
  const handleRangeNumber = (
    key: 'verticalScale' | 'horizontalScale' | 'baselineShift' | 'tsume',
    val: number,
    setLayerWide: (v: number) => void,
  ) => setCharProp(key, val, (v) => setLayerWide(v as number));

  const handleSwapFillStroke = () => {
    if (hasTarget && primary) {
      swapTextFillStroke([primary]);
      return;
    }
    setFallbackFill(activeStroke || DEFAULT_TEXT_STROKE);
    setFallbackStroke(activeFill);
    setFallbackNoFill(activeNoStroke);
    setFallbackNoStroke(activeNoFill);
    if (activeStrokeWidth === 0) setFallbackStrokeWidth(2);
  };

  const handleStrokeOrderChange = (order: StrokeOrder) => {
    if (!hasTarget || !primary || !tComp) {
      setFallbackStrokeOrder(order);
      return;
    }
    // `text/strokeOrder` (G1); the engine keeps the legacy `strokeOverFill`
    // boolean in step for older readers (extrusion trace key, Create Shapes From Text).
    void fieldEdit('Fill and Stroke Order', primary, 'text/strokeOrder', order);
  };

  const handleKerningChange = (v: number) => {
    if (!kernRange || !hasTarget || !primary) return;
    const value = Math.round(v);
    restyleRange('Kerning', kernRange.lo, kernRange.hi, { kerning: value === 0 ? undefined : value });
  };

  const handleAlignChange = (visual: string) => {
    const a = effectiveDirection === 'rtl' ? mirrorAlign(visual) : visual;
    if (hasTarget) setAlign(a);
    else setFallbackAlign(a);
  };

  const handleDirectionChange = (d: 'ltr' | 'rtl' | 'auto') => {
    if (hasTarget) setDirection(d);
    else setFallbackDirection(d);
  };

  const handleOrientationChange = (o: 'horizontal' | 'vertical') => {
    if (hasTarget) setOrientation(o);
    else setFallbackOrientation(o);
  };

  const handleRomanChange = (on: boolean) => {
    if (hasTarget) setVerticalRomanAlignment(on);
    else setFallbackRoman(on);
  };

  /** Auto tate-chu-yoko (layer-wide): digit runs up to N set horizontally. */
  const writeTcyProp = (label: string, prop: 'tateChuYokoAuto' | 'tateChuYokoDigits', value: boolean | number): void => {
    if (!hasTarget || !primary || !tComp) return;
    void fieldEdit(label, primary, `text/${prop}`, value);
  };
  const handleTcyAutoChange = (on: boolean) => {
    if (hasTarget) writeTcyProp('Auto Tate-Chu-Yoko', 'tateChuYokoAuto', on);
    else setFallbackTcyAuto(on);
  };
  const handleTcyDigitsChange = (digits: string) => {
    const d = Math.max(1, Math.min(4, Number(digits) || TATE_CHU_YOKO_DEFAULT_DIGITS));
    if (hasTarget) writeTcyProp('Tate-Chu-Yoko Digits', 'tateChuYokoDigits', d);
    else setFallbackTcyDigits(d);
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

  const handleSpaceAfterChange = (v: number) => {
    if (hasTarget) setSpaceAfter(v);
    else setFallbackSpaceAfter(v);
  };

  const applyPreset = (preset: ReturnType<typeof presets>[number]) => {
    const bag = {
      fontSize: preset.fontSize,
      fontWeight: preset.fontWeight,
      fontStyle: preset.fontStyle,
      ...(preset.fontFamily ? { fontFamily: preset.fontFamily } : {}),
    };
    if (ranged && hasTarget && primary) {
      restyleRange('Apply Text Preset', selection.start, selection.end, bag);
      return;
    }
    if (hasTarget && primary) {
      // The whole chip is ONE entry (it used to be three or four writes).
      textPresetEdit([primary], bag, 'Apply Text Preset');
      return;
    }
    setFallbackSize(preset.fontSize);
    setFallbackWeight(preset.fontWeight);
    setFallbackStyle(preset.fontStyle);
    if (preset.fontFamily) setFallbackFamily(preset.fontFamily);
  };

  // Faux Bold / Faux Italic are SYNTHETIC styles, independent of the font's
  // weight and italic: the weight menu and the font's italic stay as they are.
  const rangeStyle = ranged && hasTarget && primary ? styleOverRange(currentRuns(primary), selection.start, selection.end, textLen).style : null;
  const isFauxBold = rangeStyle?.fauxBold ?? (hasTarget ? fauxBold === true : fallbackFauxBold);
  const isFauxItalic = rangeStyle?.fauxItalic ?? (hasTarget ? fauxItalic === true : fallbackFauxItalic);
  // With a range selected these read (and write) the RANGE's own styles.
  const isAllCaps = ranged ? rangeStyle?.allCaps === true : activeTextTransform === 'uppercase';
  const isSmallCaps = ranged ? rangeStyle?.smallCaps === true : activeFontVariant === 'small-caps';
  const isSuperscript = ranged ? rangeStyle?.verticalAlign === 'super' : activeVerticalAlign === 'super';
  const isSubscript = ranged ? rangeStyle?.verticalAlign === 'sub' : activeVerticalAlign === 'sub';
  // Tate-chu-yoko is a per-range style only (AE applies it to selected text).
  const isTateChuYoko = ranged && rangeStyle?.tateChuYoko === true;
  const shownStroke = rangeStyle?.strokeColor ?? activeStroke;
  const shownStrokeWidth = rangeStyle?.strokeWidth ?? activeStrokeWidth;
  const shownLeading = rangeStyle?.lineHeight;
  const shownVertScale = rangeStyle?.verticalScale ?? activeVertScale;
  const shownHorizScale = rangeStyle?.horizontalScale ?? activeHorizScale;
  const shownBaselineShift = rangeStyle?.baselineShift ?? activeBaselineShift;
  const shownTsume = rangeStyle?.tsume ?? 0;
  /** Caps / super-sub toggles: a run style with a range, the layer prop without. */
  const toggleRangeFlag = (
    key: 'allCaps' | 'smallCaps',
    on: boolean,
    layerWide: () => void,
  ): void => (ranged ? setCharProp(key, on ? true : undefined, () => {}) : layerWide());
  const setRangeVerticalAlign = (next: 'super' | 'sub' | undefined, layerWide: () => void): void =>
    ranged ? setCharProp('verticalAlign', next, () => {}) : layerWide();

  // ── The blocks. Built once, arranged by `variant` at the bottom. ──

  // Per-character styling in progress: one status line and its one verb.
  const rangeNotice = ranged && (
        <div className={styles.rangeNotice} role="status">
          <span className={styles.rangeNoticeText}>
            {selection.end - selection.start === 1
              ? t('inspector.character.stylingOne', 'Styling {n} character', { n: selection.end - selection.start })
              : t('inspector.character.stylingOther', 'Styling {n} characters', { n: selection.end - selection.start })}
          </span>
          <Button
            size="xs"
            variant="secondary"
            onClick={clearRunStyling}
            title={t('inspector.character.resetRangeTitle', 'Reset per-character styling for selected range')}
          >
            {t('inspector.character.reset', 'Reset')}
          </Button>
        </div>
  );

  // Source Text: the content box and its keyframe switch (a bordered verb
  // while off, the accent while the text is animated).
  const sourceKeyButton = hasTarget && (
            // A square panel control, not the dashboard's pill: the accent tint
            // marks it on (animated), like every other toggle in the panel.
            <Button
              size="xs"
              variant="tertiary"
              className={sourceAnimated ? styles.keyOn : undefined}
              aria-pressed={sourceAnimated}
              icon={<Icon name="keyframe" size="sm" />}
              title={sourceAnimated ? t('inspector.character.removeSourceKeys', 'Remove Source Text keyframes') : t('inspector.character.keyframeSource', 'Keyframe Source Text across timeline')}
              onClick={toggleSourceStopwatch}
            >
              {sourceAnimated ? t('inspector.character.animated', 'Animated') : t('inspector.character.keyframe', 'Keyframe')}
            </Button>
  );
  const contentBox = hasTarget && (
          <textarea
            className={styles.contentTextarea}
            aria-label={t('inspector.character.sourceText', 'Source Text')}
            value={contentStr}
            onChange={(e) => onContentEdit(e.target.value)}
            onBlur={() => { void sourceTyping.end(); }}
            placeholder={t('inspector.character.contentPlaceholder', 'Type text content here...')}
            rows={2}
          />
  );
  // The Properties section's card (the panel draws a Source Text group instead).
  const contentCard = hasTarget && (
        <div className={styles.sectionCard}>
          <div className={styles.contentHead}>
            <span className={styles.sectionHeader}>{t('inspector.character.content', 'Content')}</span>
            {sourceKeyButton}
          </div>
          {contentBox}
        </div>
  );

  // Font family, then ONE style menu — AE's: every weight of the family,
  // upright and italic ("Extra Bold", "Extra Bold Italic"). An italic the
  // family lacks is synthesized by the engine, like Faux Italic. The option
  // value is `<weight>` or `<weight>/italic`.
  const activeItalic = activeStyle === 'italic';
  const activeFaceValue = activeItalic ? `${activeWeight}/italic` : activeWeight;
  const handleFaceChange = (value: string): void => {
    const [w, st] = value.split('/');
    const nextWeight = w ?? activeWeight;
    const nextStyle = st === 'italic' ? 'italic' : 'normal';
    if (nextWeight !== activeWeight) handleWeightChange(nextWeight);
    if (nextStyle !== (activeItalic ? 'italic' : 'normal')) handleStyleChange(nextStyle);
  };
  const fontRow = (
        <div className={`${styles.row} ${styles.rowFont}`}>
          <FontPicker
            value={activeFamily}
            onChange={handleFamilyChange}
            // A picked installed FACE carries its real weight and italic.
            onStyleChange={(f) => { handleWeightChange(f.weight); handleStyleChange(f.fontStyle); }}
          />
          <div className={styles.field}>
            <select
              value={activeFaceValue}
              onChange={(e) => handleFaceChange(e.target.value)}
              className={`${styles.fieldSelect} ${styles.fieldSelectPlain}`}
              aria-label={t('inspector.character.fontStyle', 'Font Style')}
              title={t('inspector.character.fontStyleTitle', 'The family\'s weight, upright or italic (an italic it lacks is synthesized)')}
            >
              {availableWeights.map((w) => (
                <option key={w} value={String(w)}>
                  {weightMissing && w === activeWeightNum
                    ? t('inspector.character.weightNotInFont', '{weight} — not in this font', { weight: WEIGHT_LABELS[w] ?? String(w) })
                    : WEIGHT_LABELS[w] ?? String(w)}
                </option>
              ))}
              {availableWeights.map((w) => (
                <option key={`${w}i`} value={`${w}/italic`}>
                  {t('inspector.character.weightItalic', '{weight} Italic', { weight: WEIGHT_LABELS[w] ?? String(w) })}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size="sm" className={styles.fieldChevron} />
          </div>
        </div>
  );

  // Size · Leading · Tracking are ValueFields (scrub, arrows, Shift ×10,
  // maths), as every numeric row in the app — they were plain number inputs.
  const sizeCell = (
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.sizeTitle', 'Font Size (TT)')}>{t('inspector.character.size', 'Size')}</span>
            <div className={styles.fieldValue}>
              <ValueField
                aria-label={t('inspector.character.fontSize', 'Font Size')}
                value={activeSize}
                min={1}
                step={1}
                precision={0}
                unit="px"
                onChange={(v) => handleSizeChange(Math.max(1, v))}
                {...scrubOf(fontSizeH)}
              />
            </div>
          </div>
  );

  // Leading in px, as AE's Character panel shows it (the engine stores the
  // multiple of the font size; Auto = 120 %). A range shows its own leading.
  const leadingMultiple = shownLeading !== undefined ? shownLeading : activeLeading;
  const leadingPx = Math.round(leadingMultiple * activeSize * 10) / 10;
  const leadingCell = (
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.leadingTitle', 'Leading (A/A), in px. Auto = 120% of the font size.')}>{t('inspector.character.leading', 'Leading')}</span>
            <div className={styles.fieldValue}>
              <ValueField
                aria-label={t('inspector.character.leading', 'Leading')}
                value={leadingPx}
                min={0}
                step={1}
                precision={1}
                unit="px"
                onChange={(px) => handleLeadingChange(activeSize > 0 ? Math.max(0.05, px / activeSize) : AUTO_LEADING)}
                {...scrubOf(lineHeightH)}
              />
            </div>
            <button
              type="button"
              className={styles.fieldToggle}
              data-active={leadingIsAuto && shownLeading === undefined}
              aria-pressed={leadingIsAuto && shownLeading === undefined}
              aria-label={t('inspector.character.autoLeading', 'Auto Leading')}
              title={t('inspector.character.autoLeadingTitle', 'Auto leading (120% of the font size)')}
              onClick={() => handleLeadingChange(leadingIsAuto ? AUTO_LEADING : undefined)}
            >
              {t('inspector.character.auto', 'Auto')}
            </button>
          </div>
  );

  // Faux bold / italic, caps, super / subscript, tate-chu-yoko.
  const styleToolbar = (
        <div className={styles.strip} role="toolbar" aria-label={t('inspector.character.formattingStyles', 'Character Formatting Styles')}>
          <IconButton
            size="sm"
            variant="ghost"
            active={isFauxBold}
            aria-label={t('inspector.character.fauxBold', 'Faux Bold')}
            tooltip={t('inspector.character.fauxBold', 'Faux Bold')}
            className={styles.stripCell}
            onClick={() =>
              setCharProp('fauxBold', !isFauxBold, (v) => {
                if (hasTarget) setFauxBold(v === true);
                else setFallbackFauxBold(v === true);
              })
            }
          >
            <b>B</b>
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isFauxItalic}
            aria-label={t('inspector.character.fauxItalic', 'Faux Italic')}
            tooltip={t('inspector.character.fauxItalic', 'Faux Italic')}
            className={styles.stripCell}
            onClick={() =>
              setCharProp('fauxItalic', !isFauxItalic, (v) => {
                if (hasTarget) setFauxItalic(v === true);
                else setFallbackFauxItalic(v === true);
              })
            }
          >
            <i>I</i>
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isAllCaps}
            aria-label={t('inspector.character.allCaps', 'All Caps')}
            tooltip={t('inspector.character.allCaps', 'All Caps')}
            className={styles.stripCell}
            onClick={() => toggleRangeFlag('allCaps', !isAllCaps, () => {
              const next = isAllCaps ? 'none' : 'uppercase';
              if (hasTarget) setTextTransform(next);
              else setFallbackTextTransform(next);
            })}
          >
            TT
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isSmallCaps}
            aria-label={t('inspector.character.smallCaps', 'Small Caps')}
            tooltip={t('inspector.character.smallCaps', 'Small Caps')}
            className={styles.stripCell}
            onClick={() => toggleRangeFlag('smallCaps', !isSmallCaps, () => {
              const next = isSmallCaps ? 'normal' : 'small-caps';
              if (hasTarget) setFontVariant(next);
              else setFallbackFontVariant(next);
            })}
          >
            Tt
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isSuperscript}
            aria-label={t('inspector.character.superscript', 'Superscript')}
            tooltip={t('inspector.character.superscript', 'Superscript')}
            className={styles.stripCell}
            onClick={() => setRangeVerticalAlign(isSuperscript ? undefined : 'super', () => {
              const next = isSuperscript ? 'baseline' : 'super';
              if (hasTarget) setVerticalAlign(next);
              else setFallbackVerticalAlign(next);
            })}
          >
            T¹
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isSubscript}
            aria-label={t('inspector.character.subscript', 'Subscript')}
            tooltip={t('inspector.character.subscript', 'Subscript')}
            className={styles.stripCell}
            onClick={() => setRangeVerticalAlign(isSubscript ? undefined : 'sub', () => {
              const next = isSubscript ? 'baseline' : 'sub';
              if (hasTarget) setVerticalAlign(next);
              else setFallbackVerticalAlign(next);
            })}
          >
            T₁
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={isTateChuYoko}
            disabled={!ranged}
            aria-label={t('inspector.character.tateChuYoko', 'Tate-Chu-Yoko')}
            tooltip={ranged ? t('inspector.character.tateChuYoko', 'Tate-Chu-Yoko') : t('inspector.character.tateChuYokoHint', 'Tate-Chu-Yoko (select characters in vertical type)')}
            className={styles.stripCell}
            onClick={() => setCharProp('tateChuYoko', isTateChuYoko ? undefined : true, () => {})}
          >
            TCY
          </IconButton>
        </div>
  );

  // OpenType: ligatures, contextual alternates, stylistic sets.
  const openType = hasTarget && primary ? <OpenTypeControls nodeId={primary} /> : null;

  // The seven alignment / justify buttons.
  const alignGroup = (
        <div className={styles.strip} role="radiogroup" aria-label={t('inspector.character.paragraphAlignment', 'Paragraph Alignment')}>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'left'}
            aria-label={t('inspector.character.alignLeft', 'Left Align')}
            tooltip={t('inspector.character.alignLeft', 'Left Align')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('left')}
          >
            <Icon name="text-left" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'center'}
            aria-label={t('inspector.character.alignCenter', 'Center Align')}
            tooltip={t('inspector.character.alignCenter', 'Center Align')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('center')}
          >
            <Icon name="text-center" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'right'}
            aria-label={t('inspector.character.alignRight', 'Right Align')}
            tooltip={t('inspector.character.alignRight', 'Right Align')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('right')}
          >
            <Icon name="text-right" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify' || currentAlign === 'justify-left'}
            aria-label={t('inspector.character.justifyLeft', 'Justify Last Left')}
            tooltip={t('inspector.character.justifyLeft', 'Justify Last Left')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('justify-left')}
          >
            <Icon name="align-left" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify-center'}
            aria-label={t('inspector.character.justifyCenter', 'Justify Last Center')}
            tooltip={t('inspector.character.justifyCenter', 'Justify Last Center')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('justify-center')}
          >
            <Icon name="align-center" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify-right'}
            aria-label={t('inspector.character.justifyRight', 'Justify Last Right')}
            tooltip={t('inspector.character.justifyRight', 'Justify Last Right')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('justify-right')}
          >
            <Icon name="align-right" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            active={currentAlign === 'justify-all'}
            aria-label={t('inspector.character.justifyAll', 'Justify All Lines')}
            tooltip={t('inspector.character.justifyAll', 'Justify All Lines')}
            className={styles.stripCell}
            onClick={() => handleAlignChange('justify-all')}
          >
            <Icon name="distribute-horizontal" size="sm" />
          </IconButton>
        </div>
  );

  // AE: right-to-left text direction, and horizontal / vertical type.
  const directionRows = (
    <>
        <div className={styles.controlRow}>
          <Segmented
            size="sm"
            fullWidth
            className={styles.seg}
            aria-label={t('inspector.character.textDirection', 'Text Direction')}
            value={currentDirection}
            onChange={handleDirectionChange}
            options={[
              // Short marks in the strip; the full names stay the accessible names.
              { value: 'ltr', label: t('inspector.character.ltrShort', 'LTR'), ariaLabel: t('inspector.character.ltr', 'Left to Right') },
              { value: 'rtl', label: t('inspector.character.rtlShort', 'RTL'), ariaLabel: t('inspector.character.rtl', 'Right to Left') },
              // Each paragraph follows its first strong character (UAX #9 P2/P3).
              { value: 'auto', label: t('inspector.character.auto', 'Auto') },
            ]}
          />
        </div>
        <div className={styles.controlRow}>
          <Segmented
            size="sm"
            fullWidth
            className={styles.seg}
            aria-label={t('inspector.character.textOrientation', 'Text Orientation')}
            value={currentOrientation}
            onChange={handleOrientationChange}
            options={[
              { value: 'horizontal', label: t('inspector.character.horizontal', 'Horizontal') },
              { value: 'vertical', label: t('inspector.character.vertical', 'Vertical') },
            ]}
          />
        </div>
        {/* Where point text anchors: AE puts the anchor at the alignment edge
            (a left-aligned title grows to the right); older documents centre. */}
        <div className={styles.controlRow}>
          <Segmented
            size="sm"
            fullWidth
            className={styles.seg}
            aria-label={t('inspector.character.pointTextAnchor', 'Point Text Anchor')}
            value={currentTextAnchor}
            onChange={(v) => {
              if (hasTarget) setTextAnchor(v);
              else setFallbackTextAnchor(v);
            }}
            options={[
              { value: 'alignment', label: t('inspector.character.anchorAlignmentShort', 'Anchor: edge'), ariaLabel: t('inspector.character.anchorAlignment', 'Anchor at alignment') },
              { value: 'center', label: t('inspector.character.anchorCentreShort', 'Anchor: centre'), ariaLabel: t('inspector.character.anchorCentre', 'Anchor at centre') },
            ]}
          />
        </div>
        {currentOrientation === 'vertical' && (
          <div className={styles.controlRow}>
            <Checkbox
              label={t('inspector.character.verticalRoman', 'Standard Vertical Roman Alignment')}
              checked={currentRoman}
              onChange={(e) => handleRomanChange(e.target.checked)}
            />
          </div>
        )}
        {currentOrientation === 'vertical' && (
          <div className={styles.controlRow}>
            <Checkbox
              label={t('inspector.character.autoTcy', 'Auto Tate-Chu-Yoko')}
              checked={currentTcyAuto}
              onChange={(e) => handleTcyAutoChange(e.target.checked)}
            />
            {currentTcyAuto && (
              <Segmented
                size="sm"
                aria-label={t('inspector.character.tcyDigits', 'Tate-Chu-Yoko Digits')}
                value={String(currentTcyDigits)}
                onChange={handleTcyDigitsChange}
                options={[
                  { value: '1', label: '1' },
                  { value: '2', label: '2' },
                  { value: '3', label: '3' },
                  { value: '4', label: '4' },
                ]}
              />
            )}
          </div>
        )}
    </>
  );

  // Paragraph spacing & indents.
  /**
   * A typed px well — the paragraph's spacing and indents. A ValueField, like
   * Size / Leading / Tracking: a plain controlled `<input type="number">` wrote
   * on EVERY keystroke and was re-rendered from the mirror between them, so
   * typing "20" landed "2", then showed the field a value the next keystroke
   * had not typed (2026-10-19: "the value does not change but the effect
   * does"). The ValueField keeps a draft while you type and commits on
   * Enter / blur, scrubs, and takes arrows and maths.
   */
  const pxField = (label: string, title: string, ariaLabel: string, value: number, onChange: (v: number) => void): JSX.Element => (
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={title}>{label}</span>
            <div className={styles.fieldValue}>
              <ValueField aria-label={ariaLabel} value={value} step={1} precision={1} unit="px" onChange={onChange} />
            </div>
          </div>
  );
  const spacingGrid = (
    <>
        <div className={styles.row}>
          {/* Paragraph Spacing (legacy: between every line) */}
          {pxField(t('inspector.character.paraSpace', '¶ Space'), t('inspector.character.paraSpaceTitle', 'Extra space between every line (Paragraph Spacing)'), t('inspector.character.paragraphSpacing', 'Paragraph Spacing'), currentSpacing, handleSpacingChange)}
          {pxField(t('inspector.character.firstLine', '1st Line'), t('inspector.character.firstLineTitle', 'First Line Indent (paragraph text; negative = hanging)'), t('inspector.character.firstLineIndent', 'First Line Indent'), currentFirstLineIndent, handleFirstLineIndentChange)}
        </div>
        <div className={styles.row}>
          {pxField(t('inspector.character.left', 'Left'), t('inspector.character.leftIndentTitle', 'Indent left margin (paragraph text)'), t('inspector.character.leftIndent', 'Left Indent'), currentLeftIndent, handleLeftIndentChange)}
          {pxField(t('inspector.character.right', 'Right'), t('inspector.character.rightIndentTitle', 'Indent right margin (paragraph text)'), t('inspector.character.rightIndent', 'Right Indent'), currentRightIndent, handleRightIndentChange)}
        </div>
        <div className={styles.row}>
          {pxField(t('inspector.character.before', 'Before'), t('inspector.character.spaceBeforeTitle', 'Space before paragraph'), t('inspector.character.spaceBefore', 'Space Before'), currentSpaceBefore, handleSpaceBeforeChange)}
          {pxField(t('inspector.character.after', 'After'), t('inspector.character.spaceAfterTitle', 'Space after paragraph'), t('inspector.character.spaceAfter', 'Space After'), currentSpaceAfter, handleSpaceAfterChange)}
        </div>
    </>
  );

  // The preview line: AE / Illustrator's swatch pair (fill over stroke, the
  // swap arrow on hover, None as a red slash), the family, its face meta.
  const weightLabel = WEIGHT_LABELS[Number(activeWeight)] ?? t('inspector.character.regular', 'Regular');
  const isVariableFamily = fontFamilyInfo(activeFamily)?.variable === true;
  const toggleNone = (which: 'fill' | 'stroke'): void => {
    if (which === 'fill') {
      if (hasTarget) setNoFill(!activeNoFill);
      else setFallbackNoFill(!activeNoFill);
    } else if (hasTarget) setNoStroke(!activeNoStroke);
    else setFallbackNoStroke(!activeNoStroke);
  };
  const frontIsNone = frontPaint === 'fill' ? activeNoFill : activeNoStroke;
  const noneLabel = frontPaint === 'fill' ? t('inspector.character.noFill', 'No Fill') : t('inspector.character.noStroke', 'No Stroke');
  const swatchDeck = (
        <div className={styles.swatches}>
          <div className={styles.sw} role="group" aria-label={t('inspector.character.fillAndStroke', 'Fill and Stroke')}>
            <div
              className={styles.swFill}
              title={t('inspector.character.fillColor', 'Character Fill Color')}
              onPointerDownCapture={() => setFrontPaint('fill')}
            >
              <ColorPicker
                value={activeFill}
                onChange={handleFillChange}
                compact
                aria-label={t('inspector.character.fillColor', 'Character Fill Color')}
                className={styles.swPicker}
              />
              {activeNoFill && <span className={styles.swNone} aria-hidden />}
            </div>
            <div
              className={styles.swStroke}
              title={t('inspector.character.strokeColor', 'Character Stroke Color')}
              onPointerDownCapture={() => setFrontPaint('stroke')}
            >
              <ColorPicker
                value={shownStroke}
                onChange={handleStrokeChange}
                compact
                aria-label={t('inspector.character.strokeColor', 'Character Stroke Color')}
                className={styles.swPicker}
              />
              <span className={styles.swHole} aria-hidden />
              {activeNoStroke && <span className={styles.swNone} aria-hidden />}
            </div>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('inspector.character.swapFillStroke', 'Swap Fill and Stroke (Shift+X)')}
              tooltip={t('inspector.character.swapFillStroke', 'Swap Fill and Stroke (Shift+X)')}
              className={styles.swSwap}
              onClick={handleSwapFillStroke}
            >
              ⇄
            </IconButton>
            {/* AE's ⊘ under the pair: None for the square in front (the one clicked last). */}
            <IconButton
              size="sm"
              variant="ghost"
              active={frontIsNone}
              aria-label={noneLabel}
              tooltip={frontPaint === 'fill'
                ? t('inspector.character.noFillFront', 'No Fill (the fill square is in front)')
                : t('inspector.character.noStrokeFront', 'No Stroke (the stroke square is in front)')}
              className={styles.swNoneToggle}
              onClick={() => toggleNone(frontPaint)}
            >
              ⊘
            </IconButton>
          </div>
          <div className={styles.fontline}>
            <span className={styles.fontlineName}>{activeFamily}</span>
            <span className={styles.fontlineMeta}>
              {weightLabel} {activeWeight} · {activeItalic ? t('inspector.character.italic', 'Italic') : t('inspector.character.normal', 'Normal')}
              {isFauxBold ? ` · ${t('inspector.character.fauxBold', 'Faux Bold')}` : ''}{isFauxItalic ? ` · ${t('inspector.character.fauxItalic', 'Faux Italic')}` : ''}
              {isVariableFamily ? ` · ${t('inspector.character.variable', 'Variable')}` : ''}
            </span>
          </div>
        </div>
  );

  // Solid / Linear / Radial — a gradient spans the whole text block.
  const fillRows = hasTarget && primary ? <TextFillRows nodeId={primary} textColor={activeFill} /> : null;

  // Stroke width, line join, fill & stroke order.
  // The field shows two decimals; the document (and the typing session) keep
  // the full value — a scrubbed 4.12841796 reads as 4.13, not as overflow.
  const shownStrokeWidthRounded = Math.round(shownStrokeWidth * 100) / 100;
  const strokeGrid = (
        <div className={`${styles.row} ${styles.rowThree}`}>
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.strokeWidth', 'Stroke Width')}>{t('inspector.character.stroke', 'Stroke')}</span>
            <div className={styles.fieldValue}>
              {/* A ValueField (see pxField): a draft while typing, one commit, a scrub gesture. */}
              <ValueField
                aria-label={t('inspector.character.strokeWidth', 'Stroke Width')}
                value={shownStrokeWidthRounded}
                min={0}
                step={1}
                precision={2}
                unit="px"
                onChange={(v) => handleStrokeWidthChange(Math.max(0, v))}
                {...scrubOf(strokeWidthH)}
              />
            </div>
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.lineJoin', 'Line Join')}>{t('inspector.character.join', 'Join')}</span>
            <select
              aria-label={t('inspector.character.strokeLineJoin', 'Stroke Line Join')}
              className={styles.fieldSelect}
              value={activeLineJoin}
              onChange={(e) => {
                const v = e.target.value as StrokeLineJoin;
                if (hasTarget) setStrokeLineJoin(v);
                else setFallbackLineJoin(v);
              }}
            >
              {lineJoins().map((j) => (
                <option key={j.value} value={j.value}>{j.label}</option>
              ))}
            </select>
            <Icon name="chevron-down" size="sm" className={styles.fieldChevron} />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.orderTitle', 'Fill and stroke paint order')}>{t('inspector.character.order', 'Order')}</span>
            <select
              aria-label={t('inspector.character.fillStrokeOrder', 'Fill and Stroke Order')}
              className={styles.fieldSelect}
              value={activeStrokeOrder}
              onChange={(e) => handleStrokeOrderChange(e.target.value as StrokeOrder)}
            >
              {STROKE_ORDERS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <Icon name="chevron-down" size="sm" className={styles.fieldChevron} />
          </div>
        </div>
  );

  // Stroke Solid / Linear / Radial — a gradient spans the whole block.
  const strokeRows = hasTarget && primary ? <TextStrokeRows nodeId={primary} strokeColor={shownStroke} /> : null;

  // A box behind the glyphs: on/off, colour, opacity, padding, roundness, block or per line.
  const backgroundRows = hasTarget && primary && isText ? <TextBackgroundRows nodeId={primary} /> : null;

  // Tracking in 1/1000 em (AE's unit: 50 = 0.05 em, the same look at every size).
  // A range shows its run's `tracking`; a legacy px run reads back at the run's size.
  const rangeTracking = rangeStyle?.tracking !== undefined
    ? Math.round(rangeStyle.tracking)
    : rangeStyle?.letterSpacing !== undefined
      ? Math.round((rangeStyle.letterSpacing / (rangeStyle.fontSize ?? activeSize)) * 1000)
      : undefined;
  const trackingCell = (
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.trackingTitle', 'Tracking (VA), in 1/1000 em — After Effects\' unit. Negative tightens display type, positive opens small text.')}>{t('inspector.character.tracking', 'Tracking')}</span>
            <div className={styles.fieldValue}>
              <ValueField
                aria-label={t('inspector.character.tracking', 'Tracking')}
                value={rangeTracking ?? activeTracking}
                step={5}
                precision={0}
                unit="‰"
                onChange={handleTrackingChange}
                {...scrubOf(trackingH)}
              />
            </div>
          </div>
  );

  // Kerning — the mode for the layer; the manual value at the text caret
  // takes its own well only while there IS a caret (AE: it applies between
  // the two characters at the insertion point).
  const kerningCell = (
          <div className={styles.field}>
            <span
              className={styles.fieldLabel}
              title={t('inspector.character.kerningTitle', 'Kerning (V/A). Metrics uses the font\'s kerning pairs; Optical spaces each pair from the glyph shapes, ignoring the font\'s pairs. While editing text, the value applies between the two characters at the caret, in 1/1000 em, on top of either.')}
            >
              {t('inspector.character.kerning', 'Kerning')}
            </span>
            <select
              aria-label={t('inspector.character.kerningMode', 'Kerning Mode')}
              className={styles.fieldSelect}
              value={activeKerningMode}
              onChange={(e) => {
                const v = e.target.value === 'optical' ? 'optical' : 'metrics';
                if (hasTarget) setKerningMode(v);
                else setFallbackKerningMode(v);
              }}
            >
              <option value="metrics">{t('inspector.character.metrics', 'Metrics')}</option>
              <option value="optical">{t('inspector.character.optical', 'Optical')}</option>
            </select>
            <Icon name="chevron-down" size="sm" className={styles.fieldChevron} />
          </div>
  );
  const manualKerningRow = kernRange ? (
        <div className={`${styles.row} ${styles.rowOne}`}>
          <div className={styles.field}>
            <span className={styles.fieldLabel} title={t('inspector.character.kernPairTitle', 'Kerning between the two characters at the caret, in 1/1000 em')}>{t('inspector.character.kernPair', 'Kern pair')}</span>
            <div className={styles.fieldValue}>
              <ValueField
                aria-label={t('inspector.character.manualKerning', 'Manual Kerning')}
                value={manualKerning}
                mixed={kerningMixed}
                step={5}
                precision={0}
                unit="‰"
                onChange={handleKerningChange}
              />
            </div>
          </div>
        </div>
  ) : null;

  /** A typed well with a unit, for the per-range styles and the scales. */
  const typedField = (
    label: string,
    title: string,
    ariaLabel: string,
    value: number,
    unit: string,
    onChange: (v: number) => void,
    extra: { disabled?: boolean; min?: string; max?: string } = {},
  ): JSX.Element => (
          <div className={`${styles.field}${extra.disabled ? ` ${styles.fieldOff}` : ''}`}>
            <span className={styles.fieldLabel} title={title}>{label}</span>
            <div className={styles.fieldValue}>
              {/* A ValueField (see pxField): a draft while typing, one commit on Enter / blur. */}
              <ValueField
                aria-label={ariaLabel}
                value={value}
                disabled={extra.disabled}
                {...(extra.min !== undefined ? { min: Number(extra.min) } : {})}
                {...(extra.max !== undefined ? { max: Number(extra.max) } : {})}
                step={1}
                precision={1}
                unit={unit}
                onChange={onChange}
              />
            </div>
          </div>
  );

  // Size · Leading, Tracking · Kerning, the scales, Baseline · Tsume: two
  // wells a row, in AE's Character panel order.
  const metricRows = (
    <>
          <div className={styles.row}>
            {sizeCell}
            {leadingCell}
          </div>
          <div className={styles.row}>
            {trackingCell}
            {kerningCell}
          </div>
          {manualKerningRow}
          <div className={styles.row}>
            {typedField(t('inspector.character.scaleV', 'Scale ↕'), t('inspector.character.scaleVTitle', 'Vertical Scale (IT)'), t('inspector.character.verticalScale', 'Vertical Scale'), shownVertScale, '%', (v) => handleRangeNumber('verticalScale', v, (val) => {
              if (hasTarget) setVerticalScale(val);
              else setFallbackVertScale(val);
            }))}
            {typedField(t('inspector.character.scaleH', 'Scale ↔'), t('inspector.character.scaleHTitle', 'Horizontal Scale (T-)'), t('inspector.character.horizontalScale', 'Horizontal Scale'), shownHorizScale, '%', (v) => handleRangeNumber('horizontalScale', v, (val) => {
              if (hasTarget) setHorizontalScale(val);
              else setFallbackHorizScale(val);
            }))}
          </div>
          <div className={styles.row}>
            {typedField(t('inspector.character.baseline', 'Baseline'), t('inspector.character.baselineTitle', 'Baseline Shift (A_)'), t('inspector.character.baselineShift', 'Baseline Shift'), shownBaselineShift, 'px', (v) => handleRangeNumber('baselineShift', v, (val) => {
              if (hasTarget) setBaselineShift(val);
              else setFallbackBaselineShift(val);
            }))}
            {/* Tsume — per range only (a selection's side bearings), as in AE */}
            {typedField(
              t('inspector.character.tsume', 'Tsume'),
              t('inspector.character.tsumeTitle', 'Tsume: tighten the space around the selected characters (select characters in the text to apply)'),
              t('inspector.character.tsume', 'Tsume'),
              shownTsume,
              '%',
              (v) => handleRangeNumber('tsume', Math.max(0, Math.min(100, v)), () => {}),
              { disabled: !ranged, min: '0', max: '100' },
            )}
          </div>
    </>
  );

  // Variable-font axes (AE 26.0) — only for fonts that have them.
  const variableAxes = hasTarget && primary ? <VariableAxesSection nodeId={primary} /> : null;

  /**
   * Text Box — AE point vs paragraph text, box size, auto-size, vertical
   * alignment. A function rather than a block: it MEASURES the text, so it runs
   * only where it is drawn, not behind a collapsed disclosure or group.
   */
  const renderTextBoxRows = (): JSX.Element | null => {
        // B4: the STORED box from the mirror, the MEASURED one (content height, overflow) from the
        // engine's `getTextLayout` — asked when the layer changes (useTextLayout), not per render.
        if (!hasTarget || !primary || !isText) return null;
        const paraBox = mirrorParagraphBox(m, primary);
        // Text on a path is point text (AE): no box to convert into or edit.
        const onPath = textLayout?.onPath ?? textPathOf(m, primary) !== '';
        const measuredBox = paraBox ? textLayout?.paragraph ?? null : null;
        const autoSize: BoxAutoSize = paraBox?.autoSize ?? 'height';
        const fixed = paraBox?.fixedHeight === true;
        const vAlign: BoxVerticalAlign =
          boxVerticalAlign === 'center' || boxVerticalAlign === 'bottom' ? boxVerticalAlign : 'top';
        const V_ALIGNS: ReadonlyArray<{ value: BoxVerticalAlign; label: string; icon: 'align-top' | 'align-middle' | 'align-bottom' }> = [
          { value: 'top', label: t('inspector.character.boxAlignTop', 'Align Top in Box'), icon: 'align-top' },
          { value: 'center', label: t('inspector.character.boxAlignCenter', 'Align Center in Box'), icon: 'align-middle' },
          { value: 'bottom', label: t('inspector.character.boxAlignBottom', 'Align Bottom in Box'), icon: 'align-bottom' },
        ];
        return (
          <>
            <div className={styles.controlRow}>
              <Segmented
                size="sm"
                fullWidth
                className={styles.seg}
                aria-label={t('inspector.character.pointOrParagraph', 'Point or Paragraph Text')}
                value={paraBox ? 'paragraph' : 'point'}
                disabled={onPath}
                onChange={(v) => {
                  if (v === 'paragraph') void convertToParagraphText([primary]);
                  else void convertToPointText([primary]);
                }}
                options={[
                  { value: 'point', label: t('inspector.character.point', 'Point') },
                  { value: 'paragraph', label: t('inspector.character.paragraph', 'Paragraph') },
                ]}
              />
            </div>
            {onPath ? (
              <p className={styles.help} role="note">
                {t('inspector.character.onPathNote', 'Text on a path is point text — the paragraph box is ignored until the path is removed.')}
              </p>
            ) : null}
            {paraBox && (
              <>
                <div className={styles.row}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel} title={t('inspector.character.boxWidthTitle', 'Box width — the text re-wraps')}>{t('inspector.character.boxW', 'W')}</span>
                    <div className={styles.fieldValue}>
                      <ValueField
                        aria-label={t('inspector.character.boxWidth', 'Box Width')}
                        value={typeof boxWidth === 'number' ? boxWidth : paraBox.boxWidth}
                        min={MIN_BOX_SIZE}
                        step={1}
                        precision={0}
                        unit="px"
                        onChange={(v) => setBoxWidth(Math.max(MIN_BOX_SIZE, v))}
                      />
                    </div>
                  </div>
                  <div className={`${styles.field}${fixed ? '' : ` ${styles.fieldOff}`}`}>
                    <span className={styles.fieldLabel} title={t('inspector.character.boxHeightTitle', 'Box height (Auto Height follows the text)')}>{t('inspector.character.boxH', 'H')}</span>
                    <div className={styles.fieldValue}>
                      <ValueField
                        aria-label={t('inspector.character.boxHeight', 'Box Height')}
                        disabled={!fixed}
                        value={fixed
                          ? (typeof boxHeight === 'number' ? boxHeight : paraBox.boxHeight)
                          : Math.round(measuredBox?.contentHeight ?? 0)}
                        min={MIN_BOX_SIZE}
                        step={1}
                        precision={0}
                        unit="px"
                        onChange={(v) => setBoxHeight(Math.max(MIN_BOX_SIZE, v))}
                      />
                    </div>
                  </div>
                </div>
                <div className={styles.controlRow}>
                  <Segmented
                    size="sm"
                    fullWidth
                    aria-label={t('inspector.character.boxAutoSize', 'Box Auto-Size')}
                    value={autoSize}
                    onChange={(v) => { void setBoxAutoSize(primary, v); }}
                    options={[
                      { value: 'off', label: t('inspector.character.off', 'Off') },
                      { value: 'height', label: t('inspector.character.autoHeight', 'Auto Height') },
                      { value: 'fit', label: t('inspector.character.fitText', 'Fit Text') },
                    ]}
                  />
                </div>
                <div className={styles.strip} role="radiogroup" aria-label={t('inspector.character.boxVerticalAlign', 'Vertical Alignment in Box')}>
                  {V_ALIGNS.map((o) => (
                    <IconButton
                      key={o.value}
                      size="sm"
                      variant="ghost"
                      active={fixed && vAlign === o.value}
                      disabled={!fixed}
                      aria-label={o.label}
                      tooltip={fixed ? o.label : t('inspector.character.needsFixedHeight', '{label} (needs a fixed box height)', { label: o.label })}
                      className={styles.stripCell}
                      onClick={() => setBoxVerticalAlign(o.value)}
                    >
                      <Icon name={o.icon} size="sm" />
                    </IconButton>
                  ))}
                  {measuredBox?.overflow ? (
                    <span className={styles.statusText} title={t('inspector.character.overflowTitle', 'Some text does not fit the box')} role="status">{t('inspector.character.overflow', 'Overflow')}</span>
                  ) : null}
                </div>
              </>
            )}
          </>
        );
  };
  /** The Properties section's Text Box card (the panel draws a Text Box group instead). */
  const renderTextBox = (): JSX.Element | null => {
    const rows = renderTextBoxRows();
    return rows && (
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>{t('inspector.character.textBox', 'Text Box')}</div>
        {rows}
      </div>
    );
  };

  // Path options (mask text path riding): AE's Path Options ▸ Path, then the
  // options of the path it rides.
  const hasPathOptions = hasTarget && maskPaths.length > 0;
  const pathSelect = (
            <select
              value={activePathId}
              aria-label={t('inspector.character.maskPath', 'Mask Path')}
              onChange={(e) => {
                if (!primary) return;
                // AE's Path Options ▸ Path: '' detaches (G1 `text/pathOptions/path`).
                void fieldEdit(e.target.value ? 'Text on Path' : 'Detach Text from Path', primary, 'text/pathOptions/path', e.target.value);
              }}
              className={`${styles.fontSelect} ${styles.pathSelect}`}
            >
              <option value="">{t('inspector.character.none', 'None')}</option>
              {maskPaths.map((p, i) => (
                <option key={p.id} value={p.id}>{t('inspector.character.maskN', 'Mask {n}', { n: i + 1 })}</option>
              ))}
            </select>
  );
  /* Path Options — keyframeable, also listed under Text in the timeline */
  const pathOptions = activePathId !== '' && primary ? <TextPathOptions nodeId={primary} /> : null;
  const pathCard = hasPathOptions && (
        <div className={styles.sectionCard}>
          <div className={styles.controlRow}>
            <span className={styles.sectionHeader}>{t('inspector.character.maskPath', 'Mask Path')}</span>
            {pathSelect}
          </div>
          {pathOptions}
        </div>
  );

  // Quick typography presets.
  const presetGrid = (
        <div className={styles.presetGrid}>
          {presets().map((p) => (
            <button
              key={p.label}
              type="button"
              className={styles.presetChip}
              title={t('inspector.character.presetTitle', '{label} — {size}px / {weight}', { label: p.label, size: p.fontSize, weight: p.fontWeight })}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
  );
  const presetsCard = (
      <div className={styles.sectionCard}>
        <div className={styles.sectionHeader}>{t('inspector.character.presets', 'Presets')}</div>
        {presetGrid}
      </div>
  );

  // The group headers' dim state readouts ("Outfit · Extra Bold", "Center · LTR"):
  // a closed group still tells what it holds.
  const characterSummary = activeItalic
    ? t('inspector.character.summaryItalic', '{family} · {weight} Italic', { family: activeFamily, weight: weightLabel })
    : `${activeFamily} · ${weightLabel}`;
  const ALIGN_SUMMARY: Readonly<Record<string, string>> = {
    left: t('inspector.character.left', 'Left'), center: t('inspector.character.center', 'Center'), right: t('inspector.character.right', 'Right'),
    justify: t('inspector.character.justify', 'Justify'), 'justify-left': t('inspector.character.justify', 'Justify'),
    'justify-center': t('inspector.character.justifyCenterSummary', 'Justify center'), 'justify-right': t('inspector.character.justifyRightSummary', 'Justify right'),
    'justify-all': t('inspector.character.justifyAllSummary', 'Justify all'),
  };
  const DIRECTION_SUMMARY: Readonly<Record<'ltr' | 'rtl' | 'auto', string>> = {
    ltr: t('inspector.character.ltrShort', 'LTR'), rtl: t('inspector.character.rtlShort', 'RTL'), auto: t('inspector.character.auto', 'Auto'),
  };
  const paragraphSummary = `${ALIGN_SUMMARY[currentAlign] ?? currentAlign} · ${DIRECTION_SUMMARY[currentDirection]}`;

  if (variant === 'section') {
    return (
      <TooltipProvider>
        {/* Same keep attribute as the panel: focus in here keeps on-canvas
            text editing (and its character selection) alive. */}
        <div className={styles.sectionRoot} {...{ [TEXT_EDIT_KEEP_ATTR]: '' }}>
          {rangeNotice}
          {/* After Effects' Character panel, in its order (2026-10-07): the
              fill / stroke pair with the face, the font pickers, then size ·
              leading · tracking · kerning · scales · baseline · tsume two wells
              a row, the stroke row, and the faux-style strip. */}
          <TwirlGroup
            prefKey="text.character"
            label={t('inspector.character.character', 'Character')}
            defaultOpen
            trailing={<span className={styles.groupSummary}>{characterSummary}</span>}
          >
            <div className={styles.groupBody}>
              {swatchDeck}
              {fontRow}
              {metricRows}
              {strokeGrid}
              {backgroundRows}
              {styleToolbar}
            </div>
          </TwirlGroup>
          <div className={styles.sep} role="presentation" />
          {/* AE's Paragraph panel: alignment, then indents and spacing. */}
          <TwirlGroup
            prefKey="text.paragraph"
            label={t('inspector.character.paragraph', 'Paragraph')}
            defaultOpen
            trailing={<span className={styles.groupSummary}>{paragraphSummary}</span>}
          >
            <div className={styles.groupBody}>
              {alignGroup}
              {spacingGrid}
              {directionRows}
            </div>
          </TwirlGroup>
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <Icon name={moreOpen ? 'chevron-down' : 'chevron-right'} size="sm" />
            <span>{t('inspector.character.moreOptions', 'More text options')}</span>
          </button>
          {moreOpen && (
            <div className={styles.moreBody}>
              {contentCard}
              {(fillRows || strokeRows || openType) && (
                <div className={styles.sectionCard}>
                  <div className={styles.sectionHeader}>{t('inspector.character.fillStrokeOpenType', 'Fill, stroke & OpenType')}</div>
                  {fillRows}
                  {strokeRows}
                  {openType}
                </div>
              )}
              {variableAxes}
              {renderTextBox()}
              {pathCard}
              {presetsCard}
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

  // ── The two dock panels. No heading inside either: the tab is the title. ──

  // AE's Paragraph panel: the seven alignment buttons, indents and spacing,
  // then direction and orientation — the Properties section's Paragraph group.
  if (isParagraphPanel) {
    return (
      <TooltipProvider>
        {/* Focus moving into the panel keeps on-canvas text editing alive —
            see TextEditOverlay. */}
        <div className={styles.panelRoot} {...{ [TEXT_EDIT_KEEP_ATTR]: '' }}>
          <div className={styles.panelRows}>
            {alignGroup}
            {spacingGrid}
            {directionRows}
          </div>
        </div>
      </TooltipProvider>
    );
  }

  /*
    AE's Character panel, in AE's order (the Properties section's Character
    group): font, the fill / stroke pair, size · leading · tracking · kerning ·
    scales · baseline · tsume, the stroke settings, the faux styles, OpenType.
    What AE's panel does not carry — the Source Text box, the paragraph box,
    Path Options, the quick presets — follows as group rows that open and close
    like the Properties sections (and remember it the same way).
  */
  const groupOpen = (id: string): boolean => groupsOpen[id] ?? true;
  const characterGroups: AccordionItem[] = [];
  if (hasTarget) {
    characterGroups.push({
      id: 'character.sourceText',
      title: t('inspector.character.sourceText', 'Source Text'),
      defaultOpen: true,
      content: (
        <>
          {contentBox}
          <div className={styles.groupActions}>{sourceKeyButton}</div>
        </>
      ),
    });
  }
  if (hasTarget && isText) {
    characterGroups.push({
      id: 'character.textBox',
      title: t('inspector.character.textBox', 'Text Box'),
      defaultOpen: true,
      // It measures the text: only while it is open.
      mountOnOpen: true,
      content: groupOpen('character.textBox') ? renderTextBoxRows() : null,
    });
  }
  if (hasPathOptions) {
    characterGroups.push({
      id: 'character.pathOptions',
      title: t('inspector.character.pathOptions', 'Path Options'),
      defaultOpen: true,
      content: (
        <>
          <div className={styles.controlRow}>
            <span className={styles.rowLabel}>{t('inspector.character.path', 'Path')}</span>
            {pathSelect}
          </div>
          {pathOptions}
        </>
      ),
    });
  }
  characterGroups.push({ id: 'character.presets', title: t('inspector.character.presets', 'Presets'), defaultOpen: true, content: presetGrid });

  return (
    <TooltipProvider>
      {/* Focus moving into the panel keeps on-canvas text editing (and its
          character selection) alive — see TextEditOverlay. */}
      <div className={styles.panelRoot} {...{ [TEXT_EDIT_KEEP_ATTR]: '' }}>
        {/* The ≡ menu's Text Style Presets (draws nothing here — see `presetMenu`). */}
        {hasTarget && (
          <SectionMenuSlot registry={presetMenu} slotKey="text-presets" order={0}>
            <SectionPresetMenu
              sectionId="text"
              label={t('inspector.character.textStylePresets', 'Text style presets')}
              // B4: the props the layer STORES (PropertyInfo.stored), from the mirror at call time.
              capture={() => (primary ? mirrorTextPresetCapture(documentMirror(), primary) : {})}
              apply={(values) => textPresetEdit(selected, values)}
            />
          </SectionMenuSlot>
        )}
        <div className={styles.panelRows}>
          {rangeNotice}
          {swatchDeck}
          {fontRow}
          {fillRows}
          {metricRows}
          {strokeGrid}
          {strokeRows}
          {backgroundRows}
          {styleToolbar}
          {openType}
          {variableAxes}
        </div>
        <Accordion
          className={styles.groups}
          items={characterGroups}
          openOverrides={groupsOpen}
          onToggle={toggleGroup}
        />
      </div>
    </TooltipProvider>
  );
}
