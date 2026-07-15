import { useState, useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { useCompositionStore, type CompositionSettings } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';
import type { ProjectFile } from '@core/types';
import styles from './CompositionSettingsDialog.module.css'; // Re-use styling to guarantee look & feel

interface ResolutionPreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: '16_9', name: '16:9 Landscape (1920×1080) - YouTube', width: 1920, height: 1080 },
  { id: '9_16', name: '9:16 Portrait (1080×1920) - Reels/TikTok', width: 1080, height: 1920 },
  { id: '1_1', name: '1:1 Square (1080×1080) - Post', width: 1080, height: 1080 },
  { id: '4_5', name: '4:5 Vertical (1080×1350) - Feed', width: 1080, height: 1350 },
  { id: '4_3', name: '4:3 Classic (1440×1080) - Retro TV', width: 1440, height: 1080 },
  { id: '21_9', name: '21:9 UltraWide (2560×1080) - Cinematic', width: 2560, height: 1080 },
];

interface EditorSnapshot {
  scene: ProjectFile;
  anim: AnimSnapshot;
  comp: CompositionSettings | null;
}

function captureEditorState(compId: string | undefined): EditorSnapshot {
  const comps = useProjectStore.getState().comps;
  const comp = compId ? comps[compId] : undefined;
  return {
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
    comp: comp ? { ...comp } : null,
  };
}

/**
 * "New Composition" replaces the scene, animation AND comp settings, so a
 * plain StoreSnapshotCommand (scene+anim only) is not enough — undo must also
 * restore the comp's size/fps/duration and re-sync the timeline engine.
 */
class NewCompositionCommand implements IUndoableCommand {
  readonly label = 'New Composition';

  constructor(
    private readonly compId: string | undefined,
    private readonly before: EditorSnapshot,
    private readonly after: EditorSnapshot,
  ) {}

  private restore(snap: EditorSnapshot): void {
    sceneProjectIO.restore(structuredClone(snap.scene));
    defaultAnimation.restore(snap.anim);
    if (this.compId && snap.comp) {
      useProjectStore.getState().actions.updateComp(this.compId, { ...snap.comp });
      getTimelineController().setFrameRate(snap.comp.fps);
      getTimelineController().setDurationSeconds(snap.comp.durationSeconds);
    }
    useSelectionStore.getState().clear();
    bumpScene();
  }

  execute(_ctx: CommandContext): void {
    this.restore(this.after);
  }

  undo(_ctx: CommandContext): void {
    this.restore(this.before);
  }
}

function NewComposition({ close }: { close: () => void }): JSX.Element {
  const [name, setName] = useState('Comp 1');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [duration, setDuration] = useState(10);
  const [background, setBackground] = useState('#101014');
  const [transparent, setTransparent] = useState(false);

  // More than just the comp root node = the user has actual content at risk.
  const hasContent = useMemo(() => defaultSceneGraph.size > 1, []);

  const activePreset = useMemo(() => {
    const match = RESOLUTION_PRESETS.find((p) => p.width === width && p.height === height);
    return match ? match.id : 'custom';
  }, [width, height]);

  const handlePresetChange = (presetId: string): void => {
    if (presetId === 'custom') return;
    const match = RESOLUTION_PRESETS.find((p) => p.id === presetId);
    if (match) {
      setWidth(match.width);
      setHeight(match.height);
    }
  };

  const handleCreate = () => {
    // Capture the full editable state first so the whole operation is one
    // undoable command (this used to destroy the scene irreversibly).
    const project = useProjectStore.getState();
    const activeTab = project.activeTabId ? project.tabs[project.activeTabId] : null;
    const compId = activeTab?.compositionId;
    const before = captureEditorState(compId);

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

    // 5. Record the whole replacement as one undoable command
    const after = captureEditorState(compId);
    getCommandSystem().getHistory().push(new NewCompositionCommand(compId, before, after));

    // 6. Trigger update and close modal
    bumpScene();
    close();
  };

  return (
    <div className={styles.root}>
      {/* Preset Dropdown */}
      <div className={styles.section}>
        <div className={styles.label}>Preset</div>
        <select
          value={activePreset}
          onChange={(e) => handlePresetChange(e.target.value)}
          style={{
            width: '100%',
            background: '#1c1c1f',
            border: '1px solid #333',
            color: '#fff',
            fontSize: 12,
            padding: '6px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="custom">Custom Size</option>
          {RESOLUTION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
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

      {/* Destructive-action notice — this replaces the current scene */}
      {hasContent && (
        <div
          className={styles.section}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: 'var(--color-warning, #e0a83c)',
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          <Icon name="warning" size={13} />
          <span>Creating replaces the current scene and keyframes. You can undo with Ctrl+Z.</span>
        </div>
      )}

      {/* Footer */}
      <div className={styles.footer} style={{ gap: 'var(--space-2)' }}>
        <Button variant="secondary" size="md" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="plus" size={14} />} onClick={handleCreate}>
          {hasContent ? 'Replace & Create' : 'Create'}
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
