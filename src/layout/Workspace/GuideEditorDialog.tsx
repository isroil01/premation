/**
 * Guide editor (AE 26.5) — position, unit, pin edge and colour of ONE ruler
 * guide. Opened by double-clicking a guide or from its right-click menu.
 *
 * Changing the unit or the pin edge keeps the guide where it is on screen and
 * re-expresses the number (AE does the same); typing a number moves it.
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useActiveCompSize } from '@hooks/useMirrorFrame';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  GUIDE_COLOR_PRESETS,
  guidePositionFromValue,
  guideValueFromPosition,
  type GuideEdge,
  type GuideUnit,
} from '@core/workspace/guideGeometry';
import { cn } from '@utils/cn';
import styles from './GuideEditorDialog.module.css';

const round = (v: number): number => Math.round(v * 1000) / 1000;

function GuideEditor({ guideId, close }: { guideId: string; close: () => void }): JSX.Element {
  const controller = getWorkspaceController();
  const guide = controller.ws.guides.get(guideId);
  const compSize = useActiveCompSize();
  const compW = compSize.width || 1920;
  const compH = compSize.height || 1080;
  const comp = useMemo(() => ({ w: compW, h: compH }), [compW, compH]);
  const axis = guide?.axis ?? 'x';

  const [unit, setUnit] = useState<GuideUnit>(guide?.unit ?? 'px');
  const [edge, setEdge] = useState<GuideEdge>(guide?.edge ?? 'start');
  const [color, setColor] = useState<string | null>(guide?.color ?? null);
  const [text, setText] = useState(() =>
    String(round(guideValueFromPosition(guide?.position ?? 0, axis, guide?.unit ?? 'px', guide?.edge ?? 'start', comp))),
  );

  const value = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(value);
  const position = valid ? guidePositionFromValue(value, axis, unit, edge, comp) : null;

  /** Re-express the current number in a new unit/edge without moving the guide. */
  const reexpress = (nextUnit: GuideUnit, nextEdge: GuideEdge): void => {
    if (position !== null) setText(String(round(guideValueFromPosition(position, axis, nextUnit, nextEdge, comp))));
    setUnit(nextUnit);
    setEdge(nextEdge);
  };

  const submit = (): void => {
    if (!guide || position === null) return;
    controller.ws.guides.update(guideId, { position, unit, edge, color: color ?? undefined });
    controller.requestRender();
    close();
  };
  useDialogPrimaryAction(valid ? submit : null);

  if (!guide) {
    return <p className={styles.hint}>This guide no longer exists.</p>;
  }

  const startLabel = axis === 'x' ? 'Left' : 'Top';
  const endLabel = axis === 'x' ? 'Right' : 'Bottom';

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label}>{axis === 'x' ? 'Vertical guide position' : 'Horizontal guide position'}</span>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Guide position"
          inputMode="decimal"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          error={valid ? undefined : 'Enter a number'}
          suffix={unit === '%' ? '%' : 'px'}
        />
      </label>

      <div className={styles.row}>
        <span className={styles.label}>Units</span>
        <div className={styles.segmented} role="radiogroup" aria-label="Guide units">
          {(['px', '%'] as const).map((u) => (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={unit === u}
              className={cn(styles.segment, unit === u && styles.segmentOn)}
              onClick={() => reexpress(u, edge)}
            >
              {u === 'px' ? 'Pixels' : '% of composition'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Pin to</span>
        <div className={styles.segmented} role="radiogroup" aria-label="Pin guide to edge">
          {(['start', 'end'] as const).map((ed) => (
            <button
              key={ed}
              type="button"
              role="radio"
              aria-checked={edge === ed}
              className={cn(styles.segment, edge === ed && styles.segmentOn)}
              onClick={() => reexpress(unit, ed)}
            >
              {ed === 'start' ? startLabel : endLabel}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Colour</span>
        <div className={styles.swatches} role="radiogroup" aria-label="Guide colour">
          {GUIDE_COLOR_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={color === p.color}
              aria-label={p.label}
              title={p.label}
              className={cn(styles.swatch, p.color === null && styles.swatchDefault, color === p.color && styles.swatchOn)}
              style={p.color ? { background: p.color } : undefined}
              onClick={() => setColor(p.color)}
            />
          ))}
        </div>
      </div>

      <p className={styles.hint}>
        {edge === 'end'
          ? `Keeps its distance from the ${endLabel.toLowerCase()} edge when the composition is resized.`
          : unit === '%'
            ? 'Keeps its proportion when the composition is resized.'
            : `Keeps its distance from the ${startLabel.toLowerCase()} edge when the composition is resized.`}
      </p>

      <DialogFooter
        secondary={
          <Button variant="secondary" size="md" onClick={close}>
            Cancel
          </Button>
        }
        primary={
          <Button variant="primary" size="md" onClick={submit} disabled={!valid}>
            OK
          </Button>
        }
      />
    </div>
  );
}

/** Open the editor for one engine guide. */
export function openGuideEditor(guideId: string): void {
  openModal({
    id: 'guide-editor',
    title: 'Edit Guide',
    size: 'sm',
    render: (close) => <GuideEditor guideId={guideId} close={close} />,
  });
}
