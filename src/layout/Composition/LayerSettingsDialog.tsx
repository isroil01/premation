/**
 * Layer Settings / Solid Settings dialog (AE: Ctrl+Shift+Y; Layer ▸ New ▸
 * Solid opens Solid Settings before inserting).
 *
 * The data rules live in `@core/scene/layerSettings`; this is the form.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { LABEL_COLORS } from '@core/scene/labelColor';
import {
  DEFAULT_SOLID_COLOR,
  applyLayerSettings,
  buildSolidLayer,
  nextSolidName,
  readLayerSettings,
  sanitizeLayerSize,
  type LayerSettingsKind,
  type LayerSettingsValues,
} from '@core/scene/layerSettings';
import { cn } from '@utils/cn';
import { activeCompRootId } from '@core/scene/activeComp';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { layerSettingsEdit } from './compositionEdits';
import styles from './LayerSettingsDialog.module.css';

type Mode = { mode: 'new' } | { mode: 'edit'; nodeId: string };

interface BodyProps {
  target: Mode;
  kind: LayerSettingsKind;
  initial: LayerSettingsValues;
  close: () => void;
}

function LayerSettingsBody({ target, kind, initial, close }: BodyProps): JSX.Element {
  const compW = useCompositionStore((s) => s.width) || 1920;
  const compH = useCompositionStore((s) => s.height) || 1080;
  const [name, setName] = useState(initial.name);
  const [width, setWidth] = useState(String(initial.width ?? compW));
  const [height, setHeight] = useState(String(initial.height ?? compH));
  const [color, setColor] = useState(initial.color ?? DEFAULT_SOLID_COLOR);
  const [label, setLabel] = useState<string | undefined>(initial.labelColor);

  const hasSize = kind !== 'plain';
  const w = sanitizeLayerSize(Number(width));
  const h = sanitizeLayerSize(Number(height));
  const valid = name.trim() !== '' && (!hasSize || (w !== null && h !== null && width.trim() !== '' && height.trim() !== ''));

  const submit = (): void => {
    if (!valid) return;
    const values: LayerSettingsValues = { name: name.trim() };
    if (hasSize) {
      values.width = w ?? undefined;
      values.height = h ?? undefined;
    }
    if (kind === 'solid') values.color = color;
    if (target.mode === 'edit') {
      values.labelColor = label;
      const nodeId = target.nodeId;
      void layerSettingsEdit(nodeId, values).then((r) => {
        if (r === 'gone') {
          useUIStore.getState().notify({ level: 'warning', message: 'That layer no longer exists.', durationMs: 3000 });
        } else if (r === 'legacy') {
          // B3-legacy: engine gap — an off-palette label colour has no API label index; such an apply keeps the snapshot writer for the whole dialog (one step).
          applyLayerSettings(nodeId, values);
        }
      });
    } else {
      // The New Solid builder (comp-sized, centred, colour, name, size) runs off-document and
      // lands as ONE pasteLayers entry, selected (offDocument.ts).
      void insertBuiltLayers('New Solid', activeCompRootId(), () => buildSolidLayer(values));
    }
    close();
  };
  useDialogPrimaryAction(valid ? submit : null);

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label}>Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Layer name" autoFocus onFocus={(e) => e.currentTarget.select()} />
      </label>

      {hasSize && (
        <fieldset className={styles.group}>
          <legend className={styles.label}>Size</legend>
          <div className={styles.sizeRow}>
            <Input value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Width" inputMode="numeric" suffix="px" error={w === null ? 'Width' : undefined} />
            <span className={styles.times} aria-hidden>×</span>
            <Input value={height} onChange={(e) => setHeight(e.target.value)} aria-label="Height" inputMode="numeric" suffix="px" error={h === null ? 'Height' : undefined} />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setWidth(String(compW));
              setHeight(String(compH));
            }}
          >
            Make Comp Size
          </Button>
        </fieldset>
      )}

      {kind === 'solid' && (
        <label className={styles.colorRow}>
          <span className={styles.label}>Color</span>
          <input type="color" className={styles.colorInput} value={color} onChange={(e) => setColor(e.target.value)} aria-label="Solid color" />
          <span className={styles.hex}>{color.toUpperCase()}</span>
        </label>
      )}

      {target.mode === 'edit' && (
        <div className={styles.colorRow}>
          <span className={styles.label}>Label</span>
          <div className={styles.swatches} role="radiogroup" aria-label="Label color">
            <button
              type="button"
              role="radio"
              aria-checked={label === undefined}
              aria-label="None (default)"
              title="None (default)"
              className={cn(styles.swatch, styles.swatchNone, label === undefined && styles.swatchOn)}
              onClick={() => setLabel(undefined)}
            />
            {LABEL_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={label === c.color}
                aria-label={c.label}
                title={c.label}
                className={cn(styles.swatch, label === c.color && styles.swatchOn)}
                style={{ background: c.color }}
                onClick={() => setLabel(c.color)}
              />
            ))}
          </div>
        </div>
      )}

      <DialogFooter
        secondary={
          <Button variant="secondary" size="md" onClick={close}>
            Cancel
          </Button>
        }
        primary={
          <Button variant="primary" size="md" onClick={submit} disabled={!valid}>
            {target.mode === 'new' ? 'OK' : 'Apply'}
          </Button>
        }
      />
    </div>
  );
}

/**
 * Open Solid Settings. `new` configures a solid and inserts it on OK (Layer ▸
 * New ▸ Solid); `edit` opens the selected (or given) solid's settings.
 */
export function openSolidSettings(opts: { mode: 'new' } | { mode: 'edit'; nodeId?: string }): void {
  if (opts.mode === 'new') {
    const comp = useCompositionStore.getState();
    openModal({
      id: 'solid-settings',
      title: 'Solid Settings',
      size: 'sm',
      render: (close) => (
        <LayerSettingsBody
          target={{ mode: 'new' }}
          kind="solid"
          initial={{ name: nextSolidName(), width: comp.width || 1920, height: comp.height || 1080, color: DEFAULT_SOLID_COLOR }}
          close={close}
        />
      ),
    });
    return;
  }
  openLayerSettings(opts.nodeId);
}

/** Open Layer Settings (Solid Settings for a solid) for `nodeId`, default the single selected layer. */
export function openLayerSettings(nodeId?: string): void {
  const ids = useSelectionStore.getState().ids;
  const id = nodeId ?? (ids.length === 1 ? ids[0] : undefined);
  const read = id ? readLayerSettings(id) : null;
  if (!id || !read) {
    useUIStore.getState().notify({ level: 'info', message: 'Select one layer to open its settings.', durationMs: 3000 });
    return;
  }
  openModal({
    id: 'layer-settings',
    title: read.kind === 'solid' ? 'Solid Settings' : 'Layer Settings',
    size: 'sm',
    render: (close) => <LayerSettingsBody target={{ mode: 'edit', nodeId: id }} kind={read.kind} initial={read.values} close={close} />,
  });
}
