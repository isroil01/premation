/**
 * ColorPicker — an inset swatch field that opens a real color picker popover
 * (react-colorful for the saturation/hue surface, Radix Popover for the
 * accessible, portalled, dismissable overlay). Styled entirely with our tokens
 * so it matches the dark pro chrome.
 */

import * as Popover from '@radix-ui/react-popover';
import { HexColorPicker, HexColorInput } from 'react-colorful';
import { cn } from '@utils/cn';
import styles from './ColorPicker.module.css';

export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  className?: string;
  'aria-label'?: string;
  compact?: boolean;
}

export function ColorPicker({ value, onChange, className, 'aria-label': ariaLabel, compact = false }: ColorPickerProps): JSX.Element {
  const color = value && /^#/.test(value) ? value : `#${value || '000000'}`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={cn(compact ? styles.compactTrigger : styles.trigger, className)} aria-label={ariaLabel ?? 'Pick a color'}>
          <span className={cn(styles.swatch, compact && styles.compactSwatch)} style={{ background: color }} />
          {!compact && <span className={styles.hex}>{color.toUpperCase()}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.content} sideOffset={6} align="start" collisionPadding={12}>
          <div className={styles.picker}>
            <HexColorPicker color={color} onChange={onChange} />
            <div className={styles.hexRow}>
              <span className={styles.hexHash}>#</span>
              <HexColorInput
                color={color}
                onChange={onChange}
                prefixed={false}
                className={styles.hexInput}
                aria-label="Hex value"
              />
            </div>
          </div>
          <Popover.Arrow className={styles.arrow} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default ColorPicker;
