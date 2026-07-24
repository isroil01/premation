import { useState, useEffect, useRef, useCallback } from 'react';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { defaultAnimation, parseKeyframeId, expandKeyframeProp, makeKeyframeId } from '@motion/animation';
import { getEventBus } from '@core/events/EventBus';
import { Icon } from '@components/Icon';
import styles from './FlowPanel.module.css';

// Preset curves
interface EasePreset {
  name: string;
  bezier: [number, number, number, number];
  icon: string;
}

const FLOW_PRESETS: EasePreset[] = [
  { name: 'Linear', bezier: [0.0, 0.0, 1.0, 1.0], icon: 'M 6 34 L 34 6' },
  { name: 'Ease', bezier: [0.25, 0.1, 0.25, 1.0], icon: 'M 6 34 C 13 31.2, 13 6, 34 6' },
  { name: 'Ease In', bezier: [0.42, 0.0, 1.0, 1.0], icon: 'M 6 34 C 17.76 34, 34 34, 34 6' },
  { name: 'Ease Out', bezier: [0.0, 0.0, 0.58, 1.0], icon: 'M 6 34 C 6 6, 22.24 6, 34 6' },
  { name: 'Ease In Out', bezier: [0.42, 0.0, 0.58, 1.0], icon: 'M 6 34 C 17.76 34, 22.24 6, 34 6' },
  { name: 'Quad In', bezier: [0.11, 0.0, 0.5, 0.0], icon: 'M 6 34 C 9.08 34, 20 34, 34 6' },
  { name: 'Quad Out', bezier: [0.5, 1.0, 0.89, 1.0], icon: 'M 6 34 C 20 6, 30.92 6, 34 6' },
  { name: 'Back In', bezier: [0.36, 0.0, 0.66, -0.56], icon: 'M 6 34 C 16.08 34, 24.48 41, 34 6' },
  { name: 'Back Out', bezier: [0.34, 1.56, 0.64, 1.0], icon: 'M 6 34 C 15.52 -1, 23.92 6, 34 6' },
  { name: 'Elastic In Out', bezier: [0.76, -0.24, 0.24, 1.24], icon: 'M 6 34 C 27.28 40.72, 12.72 -0.72, 34 6' },
];

export function FlowPanel(): JSX.Element {
  const selectedKfIds = useKeyframeSelectionStore((s) => s.ids);
  const selectedLayerIds = useSelectionStore((s) => s.ids);
  
  // EaseClipboard store hook
  const { copyEase, pasteEase, applyCustomBezier, bezier: clipboardBezier, copied: hasCopiedEase } = useEaseClipboardStore();

  // Local bezier state
  const [bezier, setBezier] = useState<[number, number, number, number]>([0.25, 0.1, 0.25, 1.0]);
  const [x1, y1, x2, y2] = bezier;

  // Resolve target keyframes: explicitly selected keyframe IDs, or all keyframes on selected layers
  const getTargetKfIds = useCallback((): string[] => {
    if (selectedKfIds.size > 0) {
      return Array.from(selectedKfIds);
    }
    const result: string[] = [];
    for (const nodeId of selectedLayerIds) {
      for (const prop of defaultAnimation.animatedProps(nodeId)) {
        const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
        if (kfs) {
          for (const kf of kfs) {
            result.push(makeKeyframeId(nodeId, prop, kf.t));
          }
        }
      }
    }
    return result;
  }, [selectedKfIds, selectedLayerIds]);

  const targetKfIds = getTargetKfIds();

  // Sync editor curve from the primary target keyframe
  const syncCurveFromKeyframe = useCallback(() => {
    const targets = getTargetKfIds();
    if (targets.length === 0) return;
    const firstId = targets[0];
    if (!firstId) return;

    const ref = parseKeyframeId(firstId);
    if (!ref) return;

    const props = expandKeyframeProp(ref.prop);
    const prop = props[0];
    if (!prop) return;

    const kfs = defaultAnimation.getTrackKeyframes(ref.nodeId, prop);
    const kf = kfs?.find((k) => Math.abs(k.t - ref.t) < 1e-6);
    if (kf && kf.easing === 'bezier' && kf.bezier) {
      setBezier([...kf.bezier] as [number, number, number, number]);
    }
  }, [getTargetKfIds]);

  useEffect(() => {
    syncCurveFromKeyframe();
  }, [syncCurveFromKeyframe, selectedKfIds, selectedLayerIds]);

  useEffect(() => {
    const sub = getEventBus().on('AnimationChanged', () => syncCurveFromKeyframe());
    return () => sub.dispose();
  }, [syncCurveFromKeyframe]);

  // Drag state
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<1 | 2 | null>(null);

  const applyCurveToTargets = useCallback((nextBezier: [number, number, number, number]) => {
    const targets = getTargetKfIds();
    if (targets.length > 0) {
      applyCustomBezier(targets, nextBezier);
    }
  }, [getTargetKfIds, applyCustomBezier]);

  const handlePointerDown = (handleIndex: 1 | 2) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDraggingHandle(handleIndex);
  };

  // Padded SVG coordinate constants (240x240 viewBox, 24px margin around 192x192 inner grid)
  const SVG_VIEW_SIZE = 240;
  const PAD = 24;
  const INNER_SIZE = 192;

  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingHandle === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    
    // SVG screen coordinates
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_VIEW_SIZE;
    const svgY = ((e.clientY - rect.top) / rect.height) * SVG_VIEW_SIZE;

    // Map SVG screen position back to math 0..1 coordinates
    const normX = (svgX - PAD) / INNER_SIZE;
    const normY = (PAD + INNER_SIZE - svgY) / INNER_SIZE;

    // Clamp values (allowing overshoot for back/elastic curves within padded viewBox)
    const x = Math.max(0, Math.min(1, normX));
    const y = Math.max(-0.6, Math.min(1.6, normY));

    const next: [number, number, number, number] = [...bezier];
    if (draggingHandle === 1) {
      next[0] = Number(x.toFixed(2));
      next[1] = Number(y.toFixed(2));
    } else {
      next[2] = Number(x.toFixed(2));
      next[3] = Number(y.toFixed(2));
    }

    setBezier(next);
    applyCurveToTargets(next);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (draggingHandle !== null) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setDraggingHandle(null);
      applyCurveToTargets(bezier);
    }
  };

  const handleInputChange = (index: number, val: string) => {
    const num = Number(val);
    if (isNaN(num)) return;
    const next = [...bezier] as [number, number, number, number];
    next[index] = num;
    setBezier(next);
    applyCurveToTargets(next);
  };

  const handleSelectPreset = (presetBezier: [number, number, number, number]) => {
    setBezier(presetBezier);
    applyCurveToTargets(presetBezier);
  };

  const handleApply = () => {
    applyCurveToTargets(bezier);
  };

  const handleCopy = () => {
    const targets = getTargetKfIds();
    if (targets.length > 0) {
      copyEase(targets[0]!);
    }
  };

  const handlePaste = () => {
    const targets = getTargetKfIds();
    if (targets.length > 0) {
      pasteEase(targets);
    }
  };

  // Convert normalized math coordinates [0, 1] to padded SVG [0, 240] space
  const startPt = { x: PAD, y: PAD + INNER_SIZE }; // (0, 0)
  const endPt = { x: PAD + INNER_SIZE, y: PAD };   // (1, 1)
  const p1 = { x: PAD + x1 * INNER_SIZE, y: (PAD + INNER_SIZE) - y1 * INNER_SIZE };
  const p2 = { x: PAD + x2 * INNER_SIZE, y: (PAD + INNER_SIZE) - y2 * INNER_SIZE };

  return (
    <div className={styles.root}>
      {/* Target status hint */}
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', paddingBottom: 2 }}>
        {selectedKfIds.size > 0
          ? `${selectedKfIds.size} keyframe${selectedKfIds.size > 1 ? 's' : ''} selected`
          : targetKfIds.length > 0
            ? `${targetKfIds.length} keyframe${targetKfIds.length > 1 ? 's' : ''} on selected layer${selectedLayerIds.length > 1 ? 's' : ''}`
            : 'Select keyframes or a layer to apply easing'}
      </div>

      {/* Visual Bezier Graph Editor */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Flow Curve Editor</div>
        <div className={styles.graphContainer}>
          <svg
            ref={svgRef}
            width={SVG_VIEW_SIZE}
            height={SVG_VIEW_SIZE}
            viewBox={`0 0 ${SVG_VIEW_SIZE} ${SVG_VIEW_SIZE}`}
            className={styles.svg}
            onPointerMove={handlePointerMove}
          >
            {/* Inner Grid Frame */}
            <rect x={PAD} y={PAD} width={INNER_SIZE} height={INNER_SIZE} className={styles.innerFrame} />

            {/* Grid Lines */}
            <line x1={PAD + INNER_SIZE / 4} y1={PAD} x2={PAD + INNER_SIZE / 4} y2={PAD + INNER_SIZE} className={styles.gridLine} />
            <line x1={PAD + INNER_SIZE / 2} y1={PAD} x2={PAD + INNER_SIZE / 2} y2={PAD + INNER_SIZE} className={styles.gridLine} />
            <line x1={PAD + (INNER_SIZE * 3) / 4} y1={PAD} x2={PAD + (INNER_SIZE * 3) / 4} y2={PAD + INNER_SIZE} className={styles.gridLine} />
            
            <line x1={PAD} y1={PAD + INNER_SIZE / 4} x2={PAD + INNER_SIZE} y2={PAD + INNER_SIZE / 4} className={styles.gridLine} />
            <line x1={PAD} y1={PAD + INNER_SIZE / 2} x2={PAD + INNER_SIZE} y2={PAD + INNER_SIZE / 2} className={styles.gridLine} />
            <line x1={PAD} y1={PAD + (INNER_SIZE * 3) / 4} x2={PAD + INNER_SIZE} y2={PAD + (INNER_SIZE * 3) / 4} className={styles.gridLine} />

            {/* Handle Lines */}
            <line x1={startPt.x} y1={startPt.y} x2={p1.x} y2={p1.y} className={styles.handleLine1} />
            <line x1={endPt.x} y1={endPt.y} x2={p2.x} y2={p2.y} className={styles.handleLine2} />

            {/* Bezier Curve Path */}
            <path
              d={`M ${startPt.x} ${startPt.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${endPt.x} ${endPt.y}`}
              fill="none"
              className={styles.curvePath}
            />

            {/* Control Point Handles */}
            <circle
              cx={p1.x}
              cy={p1.y}
              r={7}
              className={styles.handle1}
              onPointerDown={handlePointerDown(1)}
              onPointerUp={handlePointerUp}
              role="button"
              aria-label="Outgoing Influence"
            />
            <circle
              cx={p2.x}
              cy={p2.y}
              r={7}
              className={styles.handle2}
              onPointerDown={handlePointerDown(2)}
              onPointerUp={handlePointerUp}
              role="button"
              aria-label="Incoming Influence"
            />
          </svg>
        </div>

        {/* Easing preset buttons */}
        <div className={styles.presetsGrid}>
          {FLOW_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className={styles.presetBtn}
              onClick={() => handleSelectPreset(p.bezier)}
              title={p.name}
            >
              <svg width="40" height="40" viewBox="0 0 40 40" className={styles.presetSvg}>
                <rect width="40" height="40" fill="var(--color-surface-3)" rx="4" />
                <path d={p.icon} fill="none" stroke="var(--color-text-secondary)" strokeWidth="2" />
              </svg>
            </button>
          ))}
        </div>

        {/* Slider readouts & manual input */}
        <div className={styles.inputsRow}>
          <div className={styles.inputCell}>
            <label>X1</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={x1}
              onChange={(e) => handleInputChange(0, e.target.value)}
            />
          </div>
          <div className={styles.inputCell}>
            <label>Y1</label>
            <input
              type="number"
              step="0.05"
              value={y1}
              onChange={(e) => handleInputChange(1, e.target.value)}
            />
          </div>
          <div className={styles.inputCell}>
            <label>X2</label>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={x2}
              onChange={(e) => handleInputChange(2, e.target.value)}
            />
          </div>
          <div className={styles.inputCell}>
            <label>Y2</label>
            <input
              type="number"
              step="0.05"
              value={y2}
              onChange={(e) => handleInputChange(3, e.target.value)}
            />
          </div>
        </div>

        {/* Apply Easing Button */}
        <button
          type="button"
          onClick={handleApply}
          disabled={targetKfIds.length === 0}
          className={styles.applyBtn}
          title={targetKfIds.length > 0 ? "Apply current easing to selected keyframe(s)" : "Select keyframe(s) or a layer first"}
        >
          APPLY CURVE
        </button>
      </div>

      {/* EaseCopy Section */}
      <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }}>
        <div className={styles.sectionTitle}>EaseCopy</div>
        <div className={styles.clipboardRow}>
          <button
            type="button"
            className={styles.clipBtn}
            onClick={handleCopy}
            disabled={targetKfIds.length === 0}
            title="Copy easing from the selected keyframe"
          >
            <Icon name="copy" size={14} /> Copy Ease
          </button>
          <button
            type="button"
            className={styles.clipBtn}
            onClick={handlePaste}
            disabled={!hasCopiedEase || targetKfIds.length === 0}
            title="Paste copied easing curve to selected keyframes"
          >
            <Icon name="download" size={14} /> Paste Ease
          </button>
        </div>
        <div className={styles.clipboardReadout}>
          <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>Current Clipboard:</span>
          <span className={styles.readoutText}>
            {hasCopiedEase && clipboardBezier
              ? `[ ${clipboardBezier[0].toFixed(2)}, ${clipboardBezier[1].toFixed(2)}, ${clipboardBezier[2].toFixed(2)}, ${clipboardBezier[3].toFixed(2)} ]`
              : 'Empty'}
          </span>
        </div>
      </div>
    </div>
  );
}

