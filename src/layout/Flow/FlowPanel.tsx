import { useState, useEffect, useRef } from 'react';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { defaultAnimation, parseKeyframeId, expandKeyframeProp } from '@motion/animation';
import { Icon } from '@components/Icon';
import styles from './FlowPanel.module.css';

// Preset curves
interface EasePreset {
  name: string;
  bezier: [number, number, number, number];
  icon: string;
}

const FLOW_PRESETS: EasePreset[] = [
  { name: 'Linear', bezier: [0.0, 0.0, 1.0, 1.0], icon: 'M 0 40 L 40 0' },
  { name: 'Ease', bezier: [0.25, 0.1, 0.25, 1.0], icon: 'M 0 40 C 10 36, 10 0, 40 0' },
  { name: 'Ease In', bezier: [0.42, 0.0, 1.0, 1.0], icon: 'M 0 40 C 16.8 40, 40 40, 40 0' },
  { name: 'Ease Out', bezier: [0.0, 0.0, 0.58, 1.0], icon: 'M 0 40 C 0 0, 23.2 0, 40 0' },
  { name: 'Ease In Out', bezier: [0.42, 0.0, 0.58, 1.0], icon: 'M 0 40 C 16.8 40, 23.2 0, 40 0' },
  { name: 'Quad In', bezier: [0.11, 0.0, 0.5, 0.0], icon: 'M 0 40 C 4.4 40, 20 40, 40 0' },
  { name: 'Quad Out', bezier: [0.5, 1.0, 0.89, 1.0], icon: 'M 0 40 C 20 0, 35.6 0, 40 0' },
  { name: 'Back In', bezier: [0.36, 0.0, 0.66, -0.56], icon: 'M 0 40 C 14.4 40, 26.4 50, 40 0' },
  { name: 'Back Out', bezier: [0.34, 1.56, 0.64, 1.0], icon: 'M 0 40 C 13.6 -10, 25.6 0, 40 0' },
  { name: 'Elastic In Out', bezier: [0.76, -0.24, 0.24, 1.24], icon: 'M 0 40 C 30.4 49.6, 9.6 -9.6, 40 0' },
];

export function FlowPanel(): JSX.Element {
  const selectedKfIds = useKeyframeSelectionStore((s) => s.ids);
  
  // EaseClipboard store hook
  const { copyEase, pasteEase, applyCustomBezier, bezier: clipboardBezier, copied: hasCopiedEase } = useEaseClipboardStore();

  // Local bezier state
  const [bezier, setBezier] = useState<[number, number, number, number]>([0.25, 0.1, 0.25, 1.0]);
  const [x1, y1, x2, y2] = bezier;

  // Track the first selected keyframe to load its easing dynamically
  useEffect(() => {
    if (selectedKfIds.size === 0) return;
    const firstId = Array.from(selectedKfIds)[0];
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
  }, [selectedKfIds]);

  // Drag state
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<1 | 2 | null>(null);

  const handlePointerDown = (handleIndex: 1 | 2) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDraggingHandle(handleIndex);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingHandle === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    
    // Normalize coordinates inside SVG viewport (0,0 is top-left, width/height is 200)
    const rawX = (e.clientX - rect.left) / rect.width;
    const rawY = 1 - (e.clientY - rect.top) / rect.height; // invert Y axis for math graph

    // Clamp values
    const x = Math.max(0, Math.min(1, rawX));
    const y = Math.max(-1, Math.min(2, rawY)); // allow overshoot for back curves

    setBezier((prev) => {
      const next = [...prev] as [number, number, number, number];
      if (draggingHandle === 1) {
        next[0] = Number(x.toFixed(2));
        next[1] = Number(y.toFixed(2));
      } else {
        next[2] = Number(x.toFixed(2));
        next[3] = Number(y.toFixed(2));
      }
      return next;
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (draggingHandle !== null) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setDraggingHandle(null);
    }
  };

  const handleInputChange = (index: number, val: string) => {
    const num = Number(val);
    if (isNaN(num)) return;
    setBezier((prev) => {
      const next = [...prev] as [number, number, number, number];
      next[index] = num;
      return next;
    });
  };

  const handleApply = () => {
    applyCustomBezier(selectedKfIds, bezier);
  };

  const handleCopy = () => {
    if (selectedKfIds.size > 0) {
      const firstId = Array.from(selectedKfIds)[0]!;
      copyEase(firstId);
    }
  };

  const handlePaste = () => {
    pasteEase(selectedKfIds);
  };

  // Convert normalized [0, 1] values to SVG [0, 200] space
  const svgSize = 200;
  const p1 = { x: x1 * svgSize, y: (1 - y1) * svgSize };
  const p2 = { x: x2 * svgSize, y: (1 - y2) * svgSize };

  return (
    <div className={styles.root}>
      {/* Visual Bezier Graph Editor */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Flow Curve Editor</div>
        <div className={styles.graphContainer}>
          <svg
            ref={svgRef}
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            className={styles.svg}
            onPointerMove={handlePointerMove}
          >
            {/* Grid Lines */}
            <line x1={svgSize / 4} y1="0" x2={svgSize / 4} y2={svgSize} className={styles.gridLine} />
            <line x1={svgSize / 2} y1="0" x2={svgSize / 2} y2={svgSize} className={styles.gridLine} />
            <line x1={(svgSize * 3) / 4} y1="0" x2={(svgSize * 3) / 4} y2={svgSize} className={styles.gridLine} />
            
            <line x1="0" y1={svgSize / 4} x2={svgSize} y2={svgSize / 4} className={styles.gridLine} />
            <line x1="0" y1={svgSize / 2} x2={svgSize} y2={svgSize / 2} className={styles.gridLine} />
            <line x1="0" y1={(svgSize * 3) / 4} x2={svgSize} y2={(svgSize * 3) / 4} className={styles.gridLine} />

            {/* Handle Lines */}
            <line x1="0" y1={svgSize} x2={p1.x} y2={p1.y} className={styles.handleLine1} />
            <line x1={svgSize} y1="0" x2={p2.x} y2={p2.y} className={styles.handleLine2} />

            {/* Bezier Curve Path */}
            <path
              d={`M 0 ${svgSize} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${svgSize} 0`}
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
              onClick={() => setBezier(p.bezier)}
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
          disabled={selectedKfIds.size === 0}
          className={styles.applyBtn}
          title={selectedKfIds.size > 0 ? "Apply current easing to selected keyframes" : "Select keyframe(s) first"}
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
            disabled={selectedKfIds.size === 0}
            title="Copy easing from the selected keyframe"
          >
            <Icon name="copy" size={14} /> Copy Ease
          </button>
          <button
            type="button"
            className={styles.clipBtn}
            onClick={handlePaste}
            disabled={!hasCopiedEase || selectedKfIds.size === 0}
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
