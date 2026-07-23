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
import { insertNull } from '@core/scene/parenting';
import { insertPrimitive, insertCamera, precomposeSelected } from '@core/scene/sceneInsert';
import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import { defaultAnimation } from '@motion/animation';
import { hasTrim, setTrim, defaultTrim } from '@core/scene/trimPath';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useActiveWorkspace } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { runAnimEdit } from '@core/animation/animationCommands';
import styles from './MotionToolsPanel.module.css';

// Predefined After Effects label colors
const SWATCH_COLORS = [
  { name: 'Red', hex: '#f04f43' },
  { name: 'Yellow', hex: '#f1ca3a' },
  { name: 'Green', hex: '#5cb85c' },
  { name: 'Blue', hex: '#4a90e2' },
  { name: 'Pink', hex: '#e4839c' },
  { name: 'Orange', hex: '#f39c12' },
  { name: 'Purple', hex: '#9b59b6' },
  { name: 'Cyan', hex: '#48c9b0' },
  { name: 'Grey', hex: '#95a5a6' },
  { name: 'Charcoal', hex: '#555555' },
];

export function MotionToolsPanel(): JSX.Element {
  const selectedNodeIds = useSelectionStore((s) => s.ids);
  const selectedKeyframeIds = useKeyframeSelectionStore((s) => s.ids);
  
  // Workspace playhead
  const playhead = useActiveWorkspace()?.time ?? 0;

  // Stagger & Velocity values
  const [stagger, setStagger] = useState(0.3);
  const [velIn, setVelIn] = useState(33);
  const [velOut, setVelOut] = useState(33);

  const handleAnchorClick = useCallback((xPercent: number, yPercent: number) => {
    if (selectedNodeIds.length === 0) return;
    runAnimEdit('Align Anchor Point', () => {
      for (const nodeId of selectedNodeIds) {
        const bounds = estimateNodeBounds(nodeId);
        const ax = bounds.width * xPercent;
        const ay = bounds.height * yPercent;
        moveAnchorCompensated(nodeId, ax, ay);
      }
    });
    bumpScene();
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

  // Color Swatch Selection
  const handleColorSelect = useCallback((colorHex: string) => {
    if (selectedNodeIds.length === 0) return;
    runAnimEdit('Set Label Color', () => {
      for (const nodeId of selectedNodeIds) {
        const node = defaultSceneGraph.getNode(nodeId);
        if (node) {
          (node as any).color = colorHex;
        }
      }
    });
    bumpScene();
  }, [selectedNodeIds]);

  // Motion Tweaks Actions
  const handleToggle3D = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    runAnimEdit('Toggle 3D Layer', () => {
      for (const nodeId of selectedNodeIds) {
        const node = defaultSceneGraph.getNode(nodeId);
        if (node) {
          set3DEnabled(nodeId, !is3DEnabled(node));
        }
      }
    });
    bumpScene();
  }, [selectedNodeIds]);

  const handleToggleTimeRemap = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    const nodeId = selectedNodeIds[0]!;
    const isAnimated = defaultAnimation.isAnimated(nodeId, 'timeRemap') || defaultAnimation.isAnimated(nodeId, 'precompTime');
    runAnimEdit(isAnimated ? 'Disable time remap' : 'Enable time remap', () => {
      if (isAnimated) {
        defaultAnimation.removeTrack(nodeId, 'timeRemap');
        defaultAnimation.removeTrack(nodeId, 'precompTime');
      } else {
        defaultAnimation.setKeyframe(nodeId, 'timeRemap', playhead, playhead);
      }
    });
    bumpScene();
  }, [selectedNodeIds, playhead]);

  const handleToggleTrimPaths = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    runAnimEdit('Toggle Trim Paths', () => {
      for (const nodeId of selectedNodeIds) {
        const node = defaultSceneGraph.getNode(nodeId);
        if (!node) continue;
        if (hasTrim(node)) {
          setTrim(nodeId, null);
        } else {
          setTrim(nodeId, defaultTrim());
        }
      }
    });
    bumpScene();
  }, [selectedNodeIds]);

  // Trim Pack Actions
  const handleTrimIn = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    getTimelineController().trimSelectedStartToPlayhead(selectedNodeIds);
    bumpScene();
  }, [selectedNodeIds]);

  const handleTrimOut = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    getTimelineController().trimSelectedEndToPlayhead(selectedNodeIds);
    bumpScene();
  }, [selectedNodeIds]);

  const handleAddKeyframe = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    runAnimEdit('Add Keyframes', () => {
      for (const nodeId of selectedNodeIds) {
        const props = defaultAnimation.tracksFor(nodeId).map((t) => t.prop);
        if (props.length > 0) {
          for (const prop of props) {
            const val = defaultAnimation.sample(nodeId, prop, playhead) ?? 0;
            defaultAnimation.setKeyframe(nodeId, prop, playhead, val);
          }
        } else {
          // add default position keyframes
          const xVal = defaultAnimation.sample(nodeId, 'x', playhead) ?? 0;
          const yVal = defaultAnimation.sample(nodeId, 'y', playhead) ?? 0;
          defaultAnimation.setKeyframe(nodeId, 'x', playhead, xVal);
          defaultAnimation.setKeyframe(nodeId, 'y', playhead, yVal);
        }
      }
    });
    bumpScene();
  }, [selectedNodeIds, playhead]);

  return (
    <div className={styles.root}>
      {/* SECTION 1: Anchor point grid and color swatches */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Motion Layout</div>
        
        <div className={styles.layoutFlexRow}>
          {/* Circular 9-dot grid for Anchor point alignment */}
          <div className={styles.anchorGrid}>
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(-0.5, -0.5)} title="Top Left" />
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(0, -0.5)} title="Top Center" />
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(0.5, -0.5)} title="Top Right" />
            
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(-0.5, 0)} title="Center Left" />
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(0, 0)} title="Center" />
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(0.5, 0)} title="Center Right" />
            
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(-0.5, 0.5)} title="Bottom Left" />
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(0, 0.5)} title="Bottom Center" />
            <button type="button" className={styles.gridDot} onClick={() => handleAnchorClick(0.5, 0.5)} title="Bottom Right" />
          </div>

          {/* Preset Color Swatches */}
          <div className={styles.colorPalette}>
            {SWATCH_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                className={styles.colorSwatch}
                style={{ backgroundColor: c.hex }}
                onClick={() => handleColorSelect(c.hex)}
                title={`Set label color to ${c.name}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* SECTION 2: Keyframe Velocity & Easing Sliders */}
      <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
        <div className={styles.sectionTitle}>Easing & Velocity</div>
        
        {/* Quick presets row */}
        <div className={styles.presetsRow}>
          <button type="button" className={styles.presetBtn} onClick={() => handleEasing('Ease')} disabled={selectedKeyframeIds.size === 0}>
            <Icon name="ease" size={12} /> Ease
          </button>
          <button type="button" className={styles.presetBtn} onClick={() => handleEasing('Linear')} disabled={selectedKeyframeIds.size === 0}>
            <Icon name="line" size={12} /> Linear
          </button>
          <button type="button" className={styles.presetBtn} onClick={() => handleEasing('Hold')} disabled={selectedKeyframeIds.size === 0}>
            <Icon name="stop" size={12} /> Hold
          </button>
        </div>

        {/* Velocity Sliders */}
        <div className={styles.sliderContainer}>
          <div className={styles.sliderRow}>
            <span className={styles.sliderLabel}>Out Speed</span>
            <input
              type="range"
              min="0"
              max="100"
              value={velOut}
              onChange={(e) => setVelOut(Number(e.target.value))}
              disabled={selectedKeyframeIds.size === 0}
              className={styles.rangeInput}
            />
            <span className={styles.sliderVal}>{velOut}%</span>
          </div>

          <div className={styles.sliderRow}>
            <span className={styles.sliderLabel}>In Speed</span>
            <input
              type="range"
              min="0"
              max="100"
              value={velIn}
              onChange={(e) => setVelIn(Number(e.target.value))}
              disabled={selectedKeyframeIds.size === 0}
              className={styles.rangeInput}
            />
            <span className={styles.sliderVal}>{velIn}%</span>
          </div>

          <button
            type="button"
            className={styles.applyBtn}
            onClick={applyVelocity}
            disabled={selectedKeyframeIds.size === 0}
          >
            Apply Velocity
          </button>
        </div>
      </div>

      {/* SECTION 3: Motion Tweaks Panel (AE shortcuts) */}
      <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
        <div className={styles.sectionTitle}>Motion Tweaks</div>
        <div className={styles.tweaksGrid}>
          <button type="button" className={styles.tweakBtn} onClick={handleToggle3D} disabled={selectedNodeIds.length === 0} title="Toggle 3D Layer mode">
            <Icon name="3d" size={12} />
            <span>3D Toggle</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={() => insertNull()} title="Insert Null Object Layer">
            <Icon name="crosshair" size={12} />
            <span>Create Null</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={() => insertPrimitive('shape', 'Shape')} title="Create new Shape Layer">
            <Icon name="shape" size={12} />
            <span>Create Shape</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={() => insertCamera()} title="Insert active workspace Camera">
            <Icon name="camera" size={12} />
            <span>Create Cam</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={() => insertPrimitive('text', 'Text')} title="Insert new Text Layer">
            <Icon name="type" size={12} />
            <span>Create Text</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={() => precomposeSelected()} disabled={selectedNodeIds.length === 0} title="Precompose selected layers">
            <Icon name="component" size={12} />
            <span>Precompose</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={handleToggleTimeRemap} disabled={selectedNodeIds.length === 0} title="Toggle time-remapping keys">
            <Icon name="stopwatch" size={12} />
            <span>Time Remap</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={handleToggleTrimPaths} disabled={selectedNodeIds.length === 0} title="Toggle shape Trim-Paths modifier">
            <Icon name="scissors" size={12} />
            <span>Trim Paths</span>
          </button>
        </div>
      </div>

      {/* SECTION 4: Trim Pack & Workflow Utilities */}
      <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
        <div className={styles.sectionTitle}>Trim Pack & Workflow</div>
        <div className={styles.tweaksGrid}>
          <button type="button" className={styles.tweakBtn} onClick={handleTrimIn} disabled={selectedNodeIds.length === 0} title="Trim selected start boundaries to playhead">
            <Icon name="chevron-left" size={12} />
            <span>Trim In</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={handleTrimOut} disabled={selectedNodeIds.length === 0} title="Trim selected end boundaries to playhead">
            <Icon name="chevron-right" size={12} />
            <span>Trim Out</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={handleAddKeyframe} disabled={selectedNodeIds.length === 0} title="Insert keyframe for active properties at playhead">
            <Icon name="keyframe" size={12} />
            <span>Add Key</span>
          </button>
          <button type="button" className={styles.tweakBtn} onClick={handleReverse} disabled={selectedNodeIds.length === 0} title="Reverse keyframe order sequence">
            <Icon name="refresh" size={12} />
            <span>Reverse</span>
          </button>
        </div>

        {/* Stagger Sequence Utility */}
        <div className={styles.staggerRow}>
          <button
            type="button"
            className={styles.staggerBtn}
            onClick={handleSequence}
            disabled={selectedNodeIds.length < 2}
            title="Stagger layer start times end-to-end"
          >
            <Icon name="layers" size={12} /> Stagger Layers
          </button>
          <div className={styles.staggerInputWrapper}>
            <input
              type="number"
              step="0.05"
              min="0"
              value={stagger}
              onChange={(e) => setStagger(Number(e.target.value))}
              className={styles.staggerInput}
            />
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
