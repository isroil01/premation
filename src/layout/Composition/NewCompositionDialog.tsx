import { useState, useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { type CompositionSettings } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { createComposition, deleteComposition } from '@core/composition/compositionOps';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';
import { shortId } from '@utils/lang';
import { SIZE_PRESETS, SIZE_GROUPS, findSizePreset, MAX_DURATION } from '@core/composition/presets';
import styles from './CompositionSettingsDialog.module.css'; // Re-use styling to guarantee look & feel

// Shared with the settings dialog and the dashboard's setup modal — one
// catalog, so a preset added for a new platform shows up everywhere at once.
const RESOLUTION_PRESETS = SIZE_PRESETS;

/**
 * "New Composition" ADDS a composition — it does not touch the existing scene.
 *
 * It used to clear the scene graph, clear every keyframe and overwrite the one
 * comp's settings: Reset Project wearing the wrong label, because nothing could
 * insert into the comps table. Undo is now simply "remove the comp I made";
 * the id is fixed up front so redo restores the same one and later history
 * entries that reference it stay valid.
 */
class CreateCompositionCommand implements IUndoableCommand {
  readonly label = 'New Composition';

  constructor(
    private readonly init: Partial<CompositionSettings> & { id: string },
    private readonly previousTabId: string | null,
  ) {}

  execute(_ctx: CommandContext): void {
    createComposition(this.init);
  }

  undo(_ctx: CommandContext): void {
    deleteComposition(this.init.id);
    if (this.previousTabId) useProjectStore.getState().actions.setActiveTab(this.previousTabId);
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

  const activePreset = useMemo(() => {
    const match = findSizePreset(width, height);
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
    const previousTabId = useProjectStore.getState().activeTabId;
    const command = new CreateCompositionCommand(
      { id: `comp_${shortId()}`, name, width, height, fps, durationSeconds: duration, background, transparent },
      previousTabId,
    );

    // Additive: existing comps, layers and keyframes are untouched.
    command.execute({} as CommandContext);
    getCommandSystem().getHistory().push(command);
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
          {SIZE_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {RESOLUTION_PRESETS.filter((p) => p.group === group).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.width}×{p.height}
                </option>
              ))}
            </optgroup>
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
            <ValueField value={duration} onChange={setDuration} min={0.1} max={MAX_DURATION} step={0.5} unit="s" aria-label="Duration" />
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
      {/* No "this replaces your scene" warning any more — creating a
          composition is additive; it opens a new comp beside the existing ones. */}

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
