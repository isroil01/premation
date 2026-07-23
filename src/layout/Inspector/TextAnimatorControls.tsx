import { compToKeyframeTime } from '@core/timeline/TimelineController';
/**
 * TextAnimatorControls (MG Phase D) — the "Text Animators" section of the
 * inspector, shown only for text layers.
 *
 * Each animator group exposes a range selector (based on characters / words /
 * lines, with a falloff shape) plus transform offsets (position, scale,
 * rotation, opacity, tracking, colour). Every numeric parameter has a stopwatch:
 * off, edits write the static base value; on, edits write keyframes under the
 * animator's prop-path through the reversible command path (Prompt 2), so the
 * whole animation is undoable. The renderer reads the resolved values in
 * buildSnapshot and lays the text out glyph-by-glyph.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';

import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { applyTypewriter } from '@core/animation/keyframeAssistants';
import {
  hasTextComponent,
  readAnimatorData,
  addTextAnimator,
  removeTextAnimator,
  updateAnimator,
  animatorPropPath,
  type AnimatorParam,
  type RangeBasedOn,
  type SelectorShape,
  type TextAnimatorData,
} from '@core/text/textAnimators';
import styles from './TextAnimatorControls.module.css';
import { Checkbox } from '@components/Checkbox';

const BASED_ON: { id: RangeBasedOn; label: string }[] = [
  { id: 'characters', label: 'Characters' },
  { id: 'words', label: 'Words' },
  { id: 'lines', label: 'Lines' },
];

const SHAPES: { id: SelectorShape; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'rampUp', label: 'Ramp Up' },
  { id: 'rampDown', label: 'Ramp Down' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'round', label: 'Round' },
  { id: 'smooth', label: 'Smooth' },
];

/** A single keyframeable numeric parameter of one animator. */
function ParamRow({
  nodeId,
  index,
  param,
  label,
  value,
  unit,
  min,
  max,
  step,
}: {
  nodeId: string;
  index: number;
  param: AnimatorParam;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = animatorPropPath(index, param);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  // ONE axis for reads and writes: the canonical keyframe time.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, path, layerT) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(
        `Set ${label}`,
        () => defaultAnimation.setKeyframe(nodeId, path, layerT, v),
        `ta:${nodeId}:${path}:${layerT}`,
      );
    } else {
      updateAnimator(nodeId, index, { [param]: v } as Partial<TextAnimatorData>);
    }
  };

  const toggle = (): void => {
    if (animated) {
      runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    } else {
      runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, value));
    }
  };

  return (
    <div className={styles.paramRow}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Checkbox 
            checked={animated} 
            onChange={toggle} 
            title="Toggle Animation"
            style={{ width: 14, height: 14 }}
          />
        </div>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField
        value={display}
        onChange={onChange}
        unit={unit}
        min={min}
        max={max}
        step={step}
        aria-label={label}
      />
    </div>
  );
}

function pickTrigger(label: string): JSX.Element {
  return (
    <button type="button" className={styles.pick}>
      <span>{label}</span>
      <Icon name="chevron-down" size={11} />
    </button>
  );
}

function AnimatorGroup({
  nodeId,
  index,
  data,
}: {
  nodeId: string;
  index: number;
  data: TextAnimatorData;
}): JSX.Element {
  const basedLabel = BASED_ON.find((b) => b.id === data.basedOn)?.label ?? 'Characters';
  const shapeLabel = SHAPES.find((s) => s.id === data.shape)?.label ?? 'Square';

  const basedItems: DropdownItem[] = BASED_ON.map((b) => ({
    type: 'item',
    id: b.id,
    label: b.label,
    icon: b.id === data.basedOn ? 'check' : undefined,
    onSelect: () => updateAnimator(nodeId, index, { basedOn: b.id }),
  }));
  const shapeItems: DropdownItem[] = SHAPES.map((s) => ({
    type: 'item',
    id: s.id,
    label: s.label,
    icon: s.id === data.shape ? 'check' : undefined,
    onSelect: () => updateAnimator(nodeId, index, { shape: s.id }),
  }));

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>Animator {index + 1}</span>
        <button
          type="button"
          className={styles.remove}
          onClick={() => removeTextAnimator(nodeId, index)}
          aria-label={`Remove animator ${index + 1}`}
          title="Remove animator"
        >
          <Icon name="minus" size={12} />
        </button>
      </div>

      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Based on</span>
        <Dropdown placement="left-start" trigger={pickTrigger(basedLabel)} items={basedItems} />
      </div>
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Shape</span>
        <Dropdown placement="left-start" trigger={pickTrigger(shapeLabel)} items={shapeItems} />
      </div>
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Selector</span>
        <Dropdown
          placement="left-start"
          trigger={pickTrigger(data.mode === 'wiggly' ? 'Wiggly' : 'Range')}
          items={[
            { type: 'item', id: 'range', label: 'Range', icon: data.mode !== 'wiggly' ? 'check' : undefined, onSelect: () => updateAnimator(nodeId, index, { mode: 'range' }) },
            { type: 'item', id: 'wiggly', label: 'Wiggly (per-unit noise)', icon: data.mode === 'wiggly' ? 'check' : undefined, onSelect: () => updateAnimator(nodeId, index, { mode: 'wiggly' }) },
          ]}
        />
      </div>

      <div className={styles.subhead}>Range</div>
      <ParamRow nodeId={nodeId} index={index} param="start" label="Start" value={data.start} unit="%" min={0} max={100} />
      <ParamRow nodeId={nodeId} index={index} param="end" label="End" value={data.end} unit="%" min={0} max={100} />
      <ParamRow nodeId={nodeId} index={index} param="offset" label="Offset" value={data.offset} unit="%" min={-100} max={100} />
      {data.mode === 'wiggly' && (
        <ParamRow nodeId={nodeId} index={index} param="wiggleFreq" label="Wiggles/sec" value={data.wiggleFreq ?? 2} unit="Hz" min={0.1} />
      )}

      <div className={styles.subhead}>Transform</div>
      <ParamRow nodeId={nodeId} index={index} param="x" label="Position X" value={data.x} unit="px" />
      <ParamRow nodeId={nodeId} index={index} param="y" label="Position Y" value={data.y} unit="px" />
      <ParamRow nodeId={nodeId} index={index} param="scale" label="Scale" value={data.scale} unit="%" min={0} />
      <ParamRow nodeId={nodeId} index={index} param="rotation" label="Rotation" value={data.rotation} unit="°" />
      <ParamRow nodeId={nodeId} index={index} param="opacity" label="Opacity" value={data.opacity} unit="%" min={0} max={100} />
      <ParamRow nodeId={nodeId} index={index} param="tracking" label="Tracking" value={data.tracking} unit="px" />
      <ParamRow nodeId={nodeId} index={index} param="skew" label="Skew" value={data.skew ?? 0} unit="°" />

      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Fill colour</span>
        <div className={styles.colorCell}>
          {data.color ? (
            <>
              <ColorPicker
                value={data.color}
                onChange={(hex) => updateAnimator(nodeId, index, { color: hex })}
                aria-label="Animator fill colour"
              />
              <button
                type="button"
                className={styles.remove}
                onClick={() => updateAnimator(nodeId, index, { color: undefined })}
                aria-label="Clear animator colour"
                title="Clear colour"
              >
                <Icon name="close" size={12} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.pick}
              onClick={() => updateAnimator(nodeId, index, { color: '#ff3b30' })}
            >
              <span>Add colour</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TextAnimatorControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasTextComponent(node)) return null;

  const animators = readAnimatorData(node);

  const handleAutoTypewriter = (): void => {
    if (applyTypewriter(nodeId, time)) {
      useUIStore.getState().notify({ level: 'success', message: 'Created typewriter typing motion!', durationMs: 1800 });
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>Text Animators</span>
        <button
          type="button"
          className={styles.add}
          onClick={() => addTextAnimator(nodeId)}
          aria-label="Add text animator"
          title="Add animator"
        >
          <Icon name="plus" size={12} />
          <span>Add</span>
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '4px 12px 10px 12px' }}>
        <button
          type="button"
          onClick={handleAutoTypewriter}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: '0.75rem',
            fontWeight: 600,
            borderRadius: '4px',
            border: '1px dashed var(--color-accent, #635bff)',
            background: 'rgba(99,91,255,0.06)',
            color: 'var(--color-accent, #635bff)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          title="Auto-creates typewriter rig keyframed over 1.5s"
        >
          <Icon name="type" size={13} />
          <span>Auto-Animate Typing</span>
        </button>
      </div>

      {animators.length === 0 ? (
        <div className={styles.empty}>No animators. Add one to animate characters, words, or lines.</div>
      ) : (
        animators.map((a, i) => <AnimatorGroup key={a.id} nodeId={nodeId} index={i} data={a} />)
      )}
    </div>
  );
}

export default TextAnimatorControls;
