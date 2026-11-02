/**
 * Text layer BACKGROUND — a box painted behind the glyphs (Premiere's caption
 * background; After Effects needs a shape layer and sourceRectAtTime for it).
 *
 * Laid out like an After Effects property group: the switch and the Shape
 * menu are settings (`text/background`, `text/backgroundMode` — static, as
 * AE's More Options), and Color, Opacity, Padding and Roundness are
 * keyframeable properties with a stopwatch, a keyframe navigator and a lane
 * in the timeline (`text/backgroundColor`, `text/backgroundOpacity`,
 * `text/backgroundPadding`, `text/backgroundRadius` — they exist while the
 * switch is on). The engine's text painter draws one rounded box around the
 * laid-out text, or one per line, under the fill and stroke.
 */

import { t } from '@core/i18n';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { componentPropValue } from '@core/mirror/componentProps';
import { colorValueHex } from '@core/mirror/paintFields';
import { documentMirror } from '@stores/documentMirror';
import { Checkbox } from '@components/Checkbox';
import { Icon } from '@components/Icon';
import { useComponentProp } from './useComponentProp';
import { ColorKfRow } from './ColorKfRow';
import { AnimatablePaintRow } from './appearance/AnimatablePaintRow';
import styles from './CharacterPanel.module.css';

/* eslint-disable design-system/no-hex-color */
const DEFAULT_BACKGROUND = '#000000';
/* eslint-enable design-system/no-hex-color */

const TEXT_COMPONENT = { type: 'Text' } as const;

/** A background number's static value (a latent property reads as its default until stored). */
function staticNumber(key: string, fallback: number): PropertyAccess {
  return {
    read: (id) => {
      const v = componentPropValue(documentMirror(), id, key);
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    },
  };
}
const OPACITY = staticNumber('backgroundOpacity', 100);
const PADDING = staticNumber('backgroundPadding', 12);
const RADIUS = staticNumber('backgroundRadius', 0);

export function TextBackgroundRows({ nodeId }: { nodeId: string }): JSX.Element {
  const [on, setOn] = useComponentProp(nodeId, TEXT_COMPONENT, 'background');
  const [mode, setMode] = useComponentProp(nodeId, TEXT_COMPONENT, 'backgroundMode');
  const enabled = on === true;
  const color = colorValueHex(documentMirror().tree(nodeId)?.nodes.get('text/backgroundColor')?.value) ?? DEFAULT_BACKGROUND;

  return (
    <div>
      <div className={styles.controlRow}>
        <Checkbox
          label={t('inspector.textBackground.background', 'Background')}
          checked={enabled}
          onChange={(e) => setOn(e.target.checked)}
        />
      </div>
      {enabled && (
        <>
          <ColorKfRow
            nodeId={nodeId}
            propPrefix="backgroundColor"
            label={t('inspector.textBackground.color', 'Background Color')}
            value={color}
            setValue={() => undefined}
          />
          <AnimatablePaintRow nodeId={nodeId} prop="backgroundOpacity" label={t('inspector.textBackground.opacity', 'Background Opacity')} access={OPACITY} />
          <AnimatablePaintRow nodeId={nodeId} prop="backgroundPadding" label={t('inspector.textBackground.padding', 'Background Padding')} access={PADDING} />
          <AnimatablePaintRow nodeId={nodeId} prop="backgroundRadius" label={t('inspector.textBackground.radius', 'Background Roundness')} access={RADIUS} />
          <div className={`${styles.row} ${styles.rowOne}`}>
            <div className={styles.field}>
              <span className={styles.fieldLabel} title={t('inspector.textBackground.shapeTitle', 'One box around the whole text, or one box per line')}>{t('inspector.textBackground.shape', 'Shape')}</span>
              <select
                aria-label={t('inspector.textBackground.shapeLabel', 'Background Shape')}
                className={styles.fieldSelect}
                value={mode === 'line' ? 'line' : 'block'}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="block">{t('inspector.textBackground.block', 'Whole block')}</option>
                <option value="line">{t('inspector.textBackground.line', 'Per line')}</option>
              </select>
              <Icon name="chevron-down" size="sm" className={styles.fieldChevron} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The Background group header's dim readout: "Off", or "Whole block" / "Per line" with the box colour. */
export function TextBackgroundSummary({ nodeId }: { nodeId: string }): JSX.Element {
  const [on] = useComponentProp(nodeId, TEXT_COMPONENT, 'background');
  const [mode] = useComponentProp(nodeId, TEXT_COMPONENT, 'backgroundMode');
  if (on !== true) return <span className={styles.groupSummary}>{t('inspector.textBackground.off', 'Off')}</span>;
  const color = colorValueHex(documentMirror().tree(nodeId)?.nodes.get('text/backgroundColor')?.value) ?? DEFAULT_BACKGROUND;
  return (
    <span className={styles.groupSummary}>
      <span className={styles.backgroundChip} style={{ background: color }} aria-hidden />
      {mode === 'line' ? t('inspector.textBackground.line', 'Per line') : t('inspector.textBackground.block', 'Whole block')}
    </span>
  );
}

export default TextBackgroundRows;
