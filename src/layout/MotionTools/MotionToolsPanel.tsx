import { useCallback, useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { Icon } from '@components/Icon';
import { estimateNodeBounds, moveAnchorCompensated } from '@core/scene/anchor';
import {
  applyEasingToKeyframes,
  applyVelocityToKeyframes,
  sequenceLayers,
  timeReverseKeyframes,
} from '@core/animation/keyframeAssistants';
import styles from './MotionToolsPanel.module.css';

export function MotionToolsPanel(): JSX.Element {
  const selectedNodeIds = useSelectionStore((s) => s.ids);
  const selectedKeyframeIds = useKeyframeSelectionStore((s) => s.ids);
  // Stagger interval (seconds) for Sequence Layers — configurable, no longer 0.3 fixed.
  const [stagger, setStagger] = useState(0.3);
  
  // Custom velocity influence percentage (0% to 100%)
  const [velIn, setVelIn] = useState(33);
  const [velOut, setVelOut] = useState(33);

  const handleAnchorClick = useCallback((xPercent: number, yPercent: number) => {
    if (selectedNodeIds.length === 0) return;
    
    for (const nodeId of selectedNodeIds) {
      const bounds = estimateNodeBounds(nodeId);
      // ax and ay are offsets from the center (0,0)
      const ax = bounds.width * xPercent;
      const ay = bounds.height * yPercent;
      moveAnchorCompensated(nodeId, ax, ay);
    }
  }, [selectedNodeIds]);

  const handleEasing = useCallback((type: 'Ease' | 'Linear' | 'EaseIn' | 'EaseOut' | 'Hold') => {
    if (selectedKeyframeIds.size === 0) return;
    applyEasingToKeyframes(Array.from(selectedKeyframeIds), type);
  }, [selectedKeyframeIds]);

  const applyVelocity = useCallback(() => {
    if (selectedKeyframeIds.size === 0) return;
    applyVelocityToKeyframes(Array.from(selectedKeyframeIds), velOut, velIn);
  }, [selectedKeyframeIds, velIn, velOut]);

  const handleSequence = useCallback(() => {
    if (selectedNodeIds.length < 2) return;
    sequenceLayers(selectedNodeIds, Math.max(0, stagger));
  }, [selectedNodeIds, stagger]);

  const handleReverse = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    for (const nodeId of selectedNodeIds) {
      timeReverseKeyframes(nodeId);
    }
  }, [selectedNodeIds]);

  return (
    <div className={styles.root}>
      {/* Anchor Point Grid */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Anchor Alignment</div>
        <div className={styles.anchorGrid}>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(-0.5, -0.5)} aria-label="Top Left">↖</button>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(0, -0.5)} aria-label="Top Center">↑</button>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(0.5, -0.5)} aria-label="Top Right">↗</button>
          
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(-0.5, 0)} aria-label="Center Left">←</button>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(0, 0)} aria-label="Center">•</button>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(0.5, 0)} aria-label="Center Right">→</button>
          
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(-0.5, 0.5)} aria-label="Bottom Left">↙</button>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(0, 0.5)} aria-label="Bottom Center">↓</button>
          <button type="button" className={styles.gridBtn} onClick={() => handleAnchorClick(0.5, 0.5)} aria-label="Bottom Right">↘</button>
        </div>
      </div>

      {/* Easing Shortcuts */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Keyframe Easing</div>
        <div className={styles.actionRow}>
          <button type="button" className={styles.actionBtn} onClick={() => handleEasing('Ease')} disabled={selectedKeyframeIds.size === 0} title="Easy Ease">
            <Icon name="ease" size={14} /> Ease
          </button>
          <button type="button" className={styles.actionBtn} onClick={() => handleEasing('Linear')} disabled={selectedKeyframeIds.size === 0} title="Linear">
            <Icon name="line" size={14} /> Linear
          </button>
        </div>
        <div className={styles.actionRow}>
          <button type="button" className={styles.actionBtn} onClick={() => handleEasing('EaseIn')} disabled={selectedKeyframeIds.size === 0} title="Ease In">
            <Icon name="chevron-down" size={14} /> In
          </button>
          <button type="button" className={styles.actionBtn} onClick={() => handleEasing('EaseOut')} disabled={selectedKeyframeIds.size === 0} title="Ease Out">
            <Icon name="chevron-up" size={14} /> Out
          </button>
        </div>
        
        {/* Velocity Sliders */}
        <div className={styles.sliderContainer}>
          <div className={styles.sliderHeader}>
            <span className={styles.sliderLabel}>Keyframe Velocity</span>
          </div>
          <div className={styles.sliderRow} style={{ marginTop: 4 }}>
            <span style={{ fontSize: 11, width: 28, color: 'var(--color-text-tertiary)' }}>Out</span>
            <input
              type="range"
              min="0"
              max="100"
              value={velOut}
              onChange={(e) => setVelOut(Number(e.target.value))}
              disabled={selectedKeyframeIds.size === 0}
              className={styles.sliderInput}
              aria-label="Outgoing velocity percentage"
            />
            <span className={styles.sliderValue} style={{ width: 32, textAlign: 'right' }}>{velOut}%</span>
          </div>
          <div className={styles.sliderRow} style={{ marginTop: 4 }}>
            <span style={{ fontSize: 11, width: 28, color: 'var(--color-text-tertiary)' }}>In</span>
            <input
              type="range"
              min="0"
              max="100"
              value={velIn}
              onChange={(e) => setVelIn(Number(e.target.value))}
              disabled={selectedKeyframeIds.size === 0}
              className={styles.sliderInput}
              aria-label="Incoming velocity percentage"
            />
            <span className={styles.sliderValue} style={{ width: 32, textAlign: 'right' }}>{velIn}%</span>
          </div>
          <div className={styles.sliderRow} style={{ marginTop: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={styles.applyBtn}
              onClick={applyVelocity}
              disabled={selectedKeyframeIds.size === 0}
              title="Apply velocity to selected keyframes"
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Workflow Utilities */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Workflow</div>
        <div className={styles.actionRow}>
          <button type="button" className={styles.actionBtn} onClick={handleSequence} disabled={selectedNodeIds.length < 2} title={`Sequence selected layers, staggered by ${stagger}s`}>
            <Icon name="layers" size={14} /> Sequence
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-tertiary)' }} title="Stagger interval between layers (seconds)">
            <input
              type="number"
              value={stagger}
              min={0}
              max={5}
              step={0.05}
              onChange={(e) => setStagger(Number(e.target.value))}
              aria-label="Stagger interval (seconds)"
              style={{ width: 52, background: 'var(--color-surface-1)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)', borderRadius: 4, padding: '4px 6px', fontSize: 12 }}
            />
            s
          </label>
          <button type="button" className={styles.actionBtn} onClick={handleReverse} disabled={selectedNodeIds.length === 0} title="Reverse Keyframes">
            <Icon name="refresh" size={14} /> Reverse
          </button>
        </div>
      </div>
    </div>
  );
}
