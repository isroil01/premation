import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import styles from './CompositionSettingsDialog.module.css'; // Re-use styling to guarantee look & feel

interface Preset {
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

const PRESETS: Preset[] = [
  { name: 'HD 1080p 29.97', width: 1920, height: 1080, fps: 30, duration: 10 },
  { name: 'HD 1080p 60', width: 1920, height: 1080, fps: 60, duration: 10 },
  { name: '4K UHD 30', width: 3840, height: 2160, fps: 30, duration: 10 },
  { name: 'Social Story (1080x1920)', width: 1080, height: 1920, fps: 30, duration: 15 },
  { name: 'Square Post (1080x1080)', width: 1080, height: 1080, fps: 30, duration: 10 },
];

function NewComposition({ close }: { close: () => void }): JSX.Element {
  const [name, setName] = useState('Comp 1');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [duration, setDuration] = useState(10);
  const [background, setBackground] = useState('#101014');
  const [transparent, setTransparent] = useState(false);
  const [activePreset, setActivePreset] = useState<string>('HD 1080p 29.97');

  const applyPreset = (p: Preset) => {
    setActivePreset(p.name);
    setWidth(p.width);
    setHeight(p.height);
    setFps(p.fps);
    setDuration(p.duration);
  };

  const handleCreate = () => {
    // 1. Update the store values
    const store = useCompositionStore.getState();
    store.update({
      name,
      width,
      height,
      fps,
      durationSeconds: duration,
      background,
      transparent,
    });

    // 2. Align timeline controller parameters
    getTimelineController().setFrameRate(fps);
    getTimelineController().setDurationSeconds(duration);
    getTimelineController().seekSeconds(0);

    // 3. Clear existing scene & add an empty comp_root node
    defaultSceneGraph.clear();
    defaultSceneGraph.addNode({
      id: 'comp_root',
      name: name,
      parent: null,
      children: [],
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
    });

    // 4. Clear all keyframes
    defaultAnimation.clear();
    useSelectionStore.getState().clear();

    // 5. Trigger update and close modal
    bumpScene();
    close();
  };

  return (
    <div className={styles.root}>
      {/* Preset Row */}
      <div className={styles.section}>
        <div className={styles.label}>Preset</div>
        <div className={styles.chips}>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className={activePreset === p.name ? styles.chipOn : styles.chip}
              onClick={() => applyPreset(p)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* Name */}
      <div className={styles.section}>
        <div className={styles.label}>Composition Name</div>
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Comp name" />
      </div>

      {/* Size */}
      <div className={styles.section}>
        <div className={styles.label}>Size</div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Width</span>
            <ValueField value={width} onChange={setWidth} min={1} max={16384} step={1} unit="px" aria-label="Width" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Height</span>
            <ValueField value={height} onChange={setHeight} min={1} max={16384} step={1} unit="px" aria-label="Height" />
          </label>
        </div>
      </div>

      {/* Frame rate + duration */}
      <div className={styles.section}>
        <div className={styles.label}>Frame rate & duration</div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Frame rate</span>
            <ValueField value={fps} onChange={setFps} min={1} max={240} step={1} unit="fps" aria-label="Frame rate" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Duration</span>
            <ValueField value={duration} onChange={setDuration} min={0.1} max={3600} step={0.5} unit="s" aria-label="Duration" />
          </label>
        </div>
      </div>

      {/* Background */}
      <div className={styles.section}>
        <div className={styles.label}>Background</div>
        <div className={styles.bgRow}>
          <ColorPicker
            value={background}
            onChange={setBackground}
            className={styles.colorTrigger}
            aria-label="Background color"
          />
          <Switch
            checked={transparent}
            onChange={(e) => setTransparent(e.target.checked)}
            label="Transparent"
          />
        </div>
      </div>

      {/* Footer */}
      <div className={styles.footer} style={{ gap: 'var(--space-2)' }}>
        <Button variant="secondary" size="md" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="plus" size={14} />} onClick={handleCreate}>
          Create
        </Button>
      </div>
    </div>
  );
}

export function openNewCompositionDialog(): void {
  openModal({
    id: 'new-composition',
    title: 'New Composition',
    size: 'sm',
    render: (close) => <NewComposition close={close} />,
  });
}
