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
import { useProjectStore } from '@stores/projectStore';
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

const RESOLUTION_PRESETS = SIZE_PRESETS;

const POPULAR_PRESETS: readonly SizePreset[] = [
  SIZE_PRESETS.find((p) => p.id === 'yt_1080')!,
  SIZE_PRESETS.find((p) => p.id === 'ig_reel')!,
  SIZE_PRESETS.find((p) => p.id === 'uhd_4k')!,
  SIZE_PRESETS.find((p) => p.id === 'ig_post')!,
].filter(Boolean);

/* eslint-disable design-system/no-hex-color -- Studio background hex values are composition document presets, not UI theme chrome */
const STUDIO_COLOR_SWATCHES = [
  { label: 'Studio Dark', hex: '#101014' },
  { label: 'Deep Black', hex: '#000000' },
  { label: 'Slate Charcoal', hex: '#1c1c22' },
  { label: 'Clean White', hex: '#ffffff' },
];
/* eslint-enable design-system/no-hex-color */

type CategoryFilter = 'popular' | 'social' | 'video' | 'cinema' | 'all';

/*
 * "New Composition" ADDS a composition — it does not touch the existing scene
 * (in a fresh project it configures the auto-minted pristine comp instead;
 * see `createCompositionEdit`). One engine entry; undo removes the comp (or
 * restores the adopted one) exactly.
 */

export function NewComposition({ close }: { close: () => void }): JSX.Element {
  // Generate a smart, non-colliding default name like "Comp 1", "Comp 2", etc.
  const initialDefaultName = useMemo(() => {
    const comps = useProjectStore.getState().comps;
    const compList = Object.values(comps);
    let n = Math.max(1, compList.length + 1);
    const existingNames = new Set(compList.map((c) => c.name.toLowerCase()));
    while (existingNames.has(`comp ${n}`.toLowerCase())) {
      n += 1;
    }
    return `Comp ${n}`;
  }, []);

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

  // Category filter for presets
  const [category, setCategory] = useState<CategoryFilter>('popular');

  const activePreset = useMemo(() => {
    const match = findSizePreset(width, height);
    return match ? match.id : 'custom';
  }, [width, height]);

  // Current orientation
  const orientation = useMemo(() => {
    if (width > height) return 'Landscape';
    if (height > width) return 'Portrait';
    return 'Square';
  }, [width, height]);

  // Handle preset selection
  const handleSelectPreset = (preset: SizePreset): void => {
    setWidth(preset.width);
    setHeight(preset.height);
    if (aspectLocked && preset.height > 0) {
      lockRatio.current = preset.width / preset.height;
    }
  };

  const handleDropdownPresetChange = (presetId: string): void => {
    if (presetId === 'custom') return;
    const match = RESOLUTION_PRESETS.find((p) => p.id === presetId);
    if (match) {
      handleSelectPreset(match);
    }
  };

  // Toggle aspect lock
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

  // Preset list for selected category
  const visiblePresets = useMemo(() => {
    switch (category) {
      case 'popular':
        return POPULAR_PRESETS;
      case 'social':
        return RESOLUTION_PRESETS.filter((p) => p.group === 'Social');
      case 'video':
        return RESOLUTION_PRESETS.filter((p) => p.group === 'YouTube' || p.id === 'hd_720');
      case 'cinema':
        return RESOLUTION_PRESETS.filter((p) => p.group === 'Big screen');
      case 'all':
      default:
        return RESOLUTION_PRESETS;
    }
  }, [category]);

  // Scaled canvas frame dimensions for the preview box (max 210×120)
  const previewBoxStyle = useMemo(() => {
    const maxBoxW = 200;
    const maxBoxH = 110;
    const canvasAspect = (width || 1920) / (height || 1080);
    let boxW = maxBoxW;
    let boxH = boxW / canvasAspect;
    if (boxH > maxBoxH) {
      boxH = maxBoxH;
      boxW = boxH * canvasAspect;
    }
    return {
      width: `${Math.max(28, Math.round(boxW))}px`,
      height: `${Math.max(28, Math.round(boxH))}px`,
      backgroundColor: transparent ? 'transparent' : background,
    };
  }, [width, height, background, transparent]);

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
      <div className={styles.columns}>
        {/* ── Left Column: Preview + Background ── */}
        <div className={styles.leftCol}>
          {/* Visual Viewport Preview */}
          <div className={styles.previewCard} aria-label="Composition preview">
            <div className={styles.previewViewport}>
              <div
                data-testid="canvas-preview-frame"
                data-transparent={transparent}
                className={`${styles.previewCanvasFrame} ${transparent ? styles.checkerboard : ''}`}
                style={previewBoxStyle}
              >
                <div className={styles.viewfinderGuide} />
                <div className={styles.previewCenterCross} />
              </div>
            </div>

            <div className={styles.previewMeta}>
              <div className={styles.previewMetaRow}>
                <div className={styles.metaItem}>
                  <span className={styles.metaBadge}>{orientation}</span>
                  <span>{aspectRatioLabel(width, height)}</span>
                </div>
                <div className={styles.metaItem}>
                  <span>{width} × {height} px</span>
                </div>
              </div>

              <div className={styles.previewMetaRow}>
                <div className={styles.metaItem}>
                  <span>{fps} fps</span>
                </div>
                <div className={styles.metaItem}>
                  <span>{timecodeString} ({totalFrames}f)</span>
                </div>
              </div>
            </div>
          </div>

          {/* Canvas Background */}
          <div className={styles.section}>
            <div className={styles.label}>Canvas Background</div>
            <div className={styles.bgContainer}>
              <div className={styles.bgControlsRow}>
                <div className={styles.swatchRow} role="group" aria-label="Background swatches">
                  {STUDIO_COLOR_SWATCHES.map((swatch) => {
                    const isSelected = !transparent && background.toLowerCase() === swatch.hex.toLowerCase();
                    return (
                      <button
                        key={swatch.hex}
                        type="button"
                        className={`${styles.colorSwatch} ${isSelected ? styles.colorSwatchActive : ''}`}
                        style={{ backgroundColor: swatch.hex }}
                        onClick={() => {
                          setBackground(swatch.hex);
                          setTransparent(false);
                        }}
                        title={swatch.label}
                        aria-label={swatch.label}
                      />
                    );
                  })}

                  <div
                    className={styles.colorPickerWrap}
                    style={transparent ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
                  >
                    <ColorPicker
                      value={background}
                      onChange={(color) => {
                        setBackground(color);
                        setTransparent(false);
                      }}
                      aria-label="Custom background color"
                    />
                  </div>
                </div>

                <Switch
                  checked={transparent}
                  onChange={(e) => setTransparent(e.target.checked)}
                  label="Transparent"
                />
              </div>
            </div>
          </div>
        </div>

        {/* ── Right Column: Form Controls ── */}
        <div className={styles.rightCol}>
          {/* Composition Name */}
          <div className={styles.section}>
            <div className={styles.label}>Composition Name</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Comp 1"
              aria-label="Composition name"
              autoFocus
            />
          </div>

          {/* Resolution Presets */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.label}>
                <Icon name="sliders-h" size="sm" />
                <span>Preset</span>
              </div>

              {activePreset === 'custom' && (
                <span className={styles.metaBadge}>Custom Size</span>
              )}
            </div>

            {/* Category switcher */}
            <div className={styles.categoryTabs} role="tablist" aria-label="Preset categories">
              {(
                [
                  { id: 'popular', label: 'Popular' },
                  { id: 'social', label: 'Social' },
                  { id: 'video', label: 'Video' },
                  { id: 'cinema', label: 'Cinema' },
                  { id: 'all', label: 'All' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={category === t.id}
                  className={`${styles.categoryTab} ${category === t.id ? styles.categoryTabActive : ''}`}
                  onClick={() => setCategory(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Preset Cards Grid (or Dropdown if 'all') */}
            {category === 'all' ? (
              <select
                value={activePreset}
                onChange={(e) => handleDropdownPresetChange(e.target.value)}
                className={styles.selectInput}
                aria-label="All resolution presets"
              >
                <option value="custom">Custom Size ({width}×{height})</option>
                {SIZE_GROUPS.map((group) => (
                  <optgroup key={group} label={group}>
                    {RESOLUTION_PRESETS.filter((p) => p.group === group).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} — {p.width}×{p.height} ({aspectRatioLabel(p.width, p.height)})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <div className={styles.presetGrid}>
                {visiblePresets.map((p) => {
                  const isSelected = activePreset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`${styles.presetCard} ${isSelected ? styles.presetCardActive : ''}`}
                      onClick={() => handleSelectPreset(p)}
                    >
                      <div className={styles.presetTopRow}>
                        <span className={styles.presetLabel}>{p.label}</span>
                        <span className={styles.presetAspect}>{aspectRatioLabel(p.width, p.height)}</span>
                      </div>
                      <span className={styles.presetDimensions}>
                        {p.width} × {p.height}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Dimensions */}
          <div className={styles.section}>
            <div className={styles.label}>Dimensions</div>
            <div className={styles.dimensionControlsRow}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Width</span>
                <ValueField
                  value={width}
                  onChange={handleWidthChange}
                  min={16}
                  max={7680}
                  step={1}
                  unit="px"
                  aria-label="Width"
                />
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

              <div className={styles.field}>
                <span className={styles.fieldLabel}>Height</span>
                <ValueField
                  value={height}
                  onChange={handleHeightChange}
                  min={16}
                  max={7680}
                  step={1}
                  unit="px"
                  aria-label="Height"
                />
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
          </div>

          {/* Frame Rate & Duration */}
          <div className={styles.section}>
            <div className={styles.timingRow}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Frame Rate</span>
                <ValueField
                  value={fps}
                  onChange={setFps}
                  min={1}
                  max={240}
                  step={1}
                  unit="fps"
                  aria-label="Frame rate"
                />
                <div className={styles.chips}>
                  {[24, 30, 60].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={`${styles.chip} ${fps === rate ? styles.chipActive : ''}`}
                      onClick={() => setFps(rate)}
                    >
                      {rate}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.field}>
                <span className={styles.fieldLabel}>Duration</span>
                <ValueField
                  value={duration}
                  onChange={setDuration}
                  min={0.1}
                  max={MAX_DURATION}
                  step={0.5}
                  unit="s"
                  aria-label="Duration"
                />
                <div className={styles.chips}>
                  {[5, 10, 15, 30, 60].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className={`${styles.chip} ${duration === sec ? styles.chipActive : ''}`}
                      onClick={() => setDuration(sec)}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter
        secondary={
          <Button variant="secondary" size="md" onClick={close}>
            Cancel
          </Button>
        }
        primary={
          <Button
            variant="primary"
            size="md"
            leftIcon={<Icon name="plus" size="sm" />}
            onClick={handleCreate}
          >
            Create Composition
          </Button>
        }
      />
    </div>
  );
}

export function openNewCompositionDialog(): void {
  openModal({
    id: 'new-composition',
    title: 'New Composition',
    size: 'lg',
    className: styles.dialogWindow,
    render: (close) => <NewComposition close={close} />,
  });
}
