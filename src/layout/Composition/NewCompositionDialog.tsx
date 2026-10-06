import { useState, useMemo, useRef } from 'react';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { documentMirror } from '@stores/documentMirror';
import { defaultCompNameIn } from '@core/mirror/compNames';
import { createCompositionEdit } from './compositionEdits';
import {
  SIZE_PRESETS,
  SIZE_GROUPS,
  findSizePreset,
  MAX_DURATION,
  aspectRatioLabel,
  clampDimension,
  clampFps,
  clampDuration,
  type SizePreset,
} from '@core/composition/presets';
import { framesToTimecode } from '@core/time/timecode';
import styles from './NewCompositionDialog.module.css';

/* eslint-disable design-system/no-hex-color -- Studio background hex values are composition document presets, not UI theme chrome */
const STUDIO_COLOR_SWATCHES = [
  { label: 'Studio Dark', hex: '#101014' },
  { label: 'Deep Black', hex: '#000000' },
  { label: 'Slate Charcoal', hex: '#1c1c22' },
  { label: 'Clean White', hex: '#ffffff' },
];
/* eslint-enable design-system/no-hex-color */

/*
 * "New Composition" ADDS a composition — it does not touch the existing scene
 * (in a fresh project it configures the auto-minted pristine comp instead;
 * see `createCompositionEdit`). One engine entry; undo removes the comp (or
 * restores the adopted one) exactly.
 *
 * The dialog is a SETTINGS FORM (2026-10), the shape of After Effects'
 * Composition Settings and of the dashboard's New project: one column of
 * labelled fields, labels right-aligned to the fields they name. It replaced a
 * preview panel, five tabs of preset cards and boxed sections — the same
 * choices, as one preset menu and seven rows.
 */

export function NewComposition({ close }: { close: () => void }): JSX.Element {
  // Generate a smart, non-colliding default name like "Comp 1", "Comp 2", etc.
  // B4: the document mirror's compositions.
  const initialDefaultName = useMemo(() => defaultCompNameIn(documentMirror()), []);

  const [name, setName] = useState(initialDefaultName);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [duration, setDuration] = useState(10);
  // eslint-disable-next-line design-system/no-hex-color
  const [background, setBackground] = useState('#101014');
  const [transparent, setTransparent] = useState(false);

  // Aspect ratio lock
  const [aspectLocked, setAspectLocked] = useState(false);
  const lockRatio = useRef(1920 / 1080);

  const activePreset = useMemo(() => {
    const match = findSizePreset(width, height);
    return match ? match.id : 'custom';
  }, [width, height]);

  const orientation = width > height ? 'Landscape' : height > width ? 'Portrait' : 'Square';

  const handleSelectPreset = (preset: SizePreset): void => {
    setWidth(preset.width);
    setHeight(preset.height);
    if (aspectLocked && preset.height > 0) {
      lockRatio.current = preset.width / preset.height;
    }
  };

  const handlePresetChange = (presetId: string): void => {
    if (presetId === 'custom') return;
    const match = SIZE_PRESETS.find((p) => p.id === presetId);
    if (match) handleSelectPreset(match);
  };

  const toggleAspectLock = (): void => {
    if (!aspectLocked && height > 0) {
      lockRatio.current = width / height;
    }
    setAspectLocked((prev) => !prev);
  };

  // Change width with optional aspect ratio lock
  const handleWidthChange = (newW: number): void => {
    const clampedW = clampDimension(newW);
    setWidth(clampedW);
    if (aspectLocked && lockRatio.current > 0) {
      setHeight(clampDimension(Math.round(clampedW / lockRatio.current)));
    }
  };

  // Change height with optional aspect ratio lock
  const handleHeightChange = (newH: number): void => {
    const clampedH = clampDimension(newH);
    setHeight(clampedH);
    if (aspectLocked && lockRatio.current > 0) {
      setWidth(clampDimension(Math.round(clampedH * lockRatio.current)));
    }
  };

  // Swap width and height (orientation flip)
  const handleSwapDimensions = (): void => {
    const prevW = width;
    const prevH = height;
    setWidth(prevH);
    setHeight(prevW);
    if (aspectLocked && prevW > 0) {
      lockRatio.current = prevH / prevW;
    }
  };

  const totalFrames = Math.max(1, Math.round(duration * fps));
  const timecodeString = framesToTimecode(duration, fps);

  const handleCreate = (): void => {
    close();
    void createCompositionEdit({
      name: name.trim() || 'Comp 1',
      width: clampDimension(width),
      height: clampDimension(height),
      fps: clampFps(fps),
      durationSeconds: clampDuration(duration),
      background,
      transparent,
    });
  };

  // Enter creates the comp
  useDialogPrimaryAction(handleCreate);

  return (
    <div className={styles.root}>
      <div className={styles.grid}>
        <span className={styles.label}>Composition name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Comp 1"
          aria-label="Composition name"
          autoFocus
        />

        <div className={styles.rule} />

        <span className={styles.label}>Preset</span>
        <select
          value={activePreset}
          onChange={(e) => handlePresetChange(e.target.value)}
          className={styles.select}
          aria-label="Preset"
        >
          <option value="custom">Custom</option>
          {SIZE_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {SIZE_PRESETS.filter((p) => p.group === group).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.width} × {p.height}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <span className={styles.label}>Width</span>
        <div className={styles.inline}>
          <div className={styles.number}>
            <ValueField value={width} onChange={handleWidthChange} min={16} max={7680} step={1} unit="px" aria-label="Width" />
          </div>
          <IconButton
            size="sm"
            variant="secondary"
            onClick={handleSwapDimensions}
            tooltip="Swap width and height (flip orientation)"
            aria-label="Swap width and height"
          >
            <Icon name="rotate" size="sm" />
          </IconButton>
        </div>

        <span className={styles.label}>Height</span>
        <div className={styles.inline}>
          <div className={styles.number}>
            <ValueField value={height} onChange={handleHeightChange} min={16} max={7680} step={1} unit="px" aria-label="Height" />
          </div>
          <IconButton
            size="sm"
            variant="secondary"
            active={aspectLocked}
            onClick={toggleAspectLock}
            tooltip={aspectLocked ? 'Aspect ratio locked (click to unlock)' : 'Lock aspect ratio'}
            aria-label={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
          >
            <Icon name="link" size="sm" />
          </IconButton>
          {/* The size, read back: what the two fields add up to. */}
          <span className={styles.hint}>
            <span>{width} × {height} px</span> · <span>{aspectRatioLabel(width, height)}</span> · <span>{orientation}</span>
          </span>
        </div>

        <span className={styles.label}>Frame rate</span>
        <div className={styles.inline}>
          <div className={styles.number}>
            <ValueField value={fps} onChange={setFps} min={1} max={240} step={1} unit="fps" aria-label="Frame rate" />
          </div>
          <span className={styles.hint}>frames per second</span>
        </div>

        <span className={styles.label}>Duration</span>
        <div className={styles.inline}>
          <div className={styles.number}>
            <ValueField value={duration} onChange={setDuration} min={0.1} max={MAX_DURATION} step={0.5} unit="s" aria-label="Duration" />
          </div>
          <span className={styles.hint}>
            <span>{timecodeString}</span> · <span>{totalFrames} frames at {fps} fps</span>
          </span>
        </div>

        <span className={styles.label}>Background colour</span>
        <div className={styles.inline}>
          <div className={styles.swatches} role="group" aria-label="Background swatches">
            {STUDIO_COLOR_SWATCHES.map((swatch) => {
              const isSelected = !transparent && background.toLowerCase() === swatch.hex.toLowerCase();
              return (
                <button
                  key={swatch.hex}
                  type="button"
                  className={`${styles.swatch} ${isSelected ? styles.swatchActive : ''}`}
                  style={{ background: swatch.hex }}
                  onClick={() => {
                    setBackground(swatch.hex);
                    setTransparent(false);
                  }}
                  title={swatch.label}
                  aria-label={swatch.label}
                  aria-pressed={isSelected}
                />
              );
            })}
          </div>
          <div className={`${styles.picker} ${transparent ? styles.pickerOff : ''}`}>
            <ColorPicker
              value={background}
              onChange={(color) => {
                setBackground(color);
                setTransparent(false);
              }}
              aria-label="Custom background color"
            />
          </div>
          <Switch checked={transparent} onChange={(e) => setTransparent(e.target.checked)} label="Transparent" />
        </div>
      </div>

      {/* `data-dialog-actions`: the dialog frame styles this row's buttons as its footer's. */}
      <div className={styles.actions} data-dialog-actions>
        <DialogFooter
          note="You can change these later in composition settings."
          secondary={
            <Button variant="secondary" size="md" onClick={close}>
              Cancel
            </Button>
          }
          primary={
            <Button variant="primary" size="md" onClick={handleCreate}>
              Create
            </Button>
          }
        />
      </div>
    </div>
  );
}

export function openNewCompositionDialog(): void {
  openModal({
    id: 'new-composition',
    title: 'New Composition',
    size: 'md',
    className: styles.dialogWindow,
    render: (close) => <NewComposition close={close} />,
  });
}
