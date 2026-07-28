/**
 * Logo — the single source of truth for the Premation brand mark in the app.
 *
 * Two variants, matching how the marketing site uses the same two assets:
 *   - `mark`   → the shape mark alone, for tight spots (title bar, sidebars).
 *   - `lockup` → shape mark + wordmark in a centered row with a small gap,
 *                for roomy spots (auth screen, loading screen, About).
 *
 * `size` is always the height of the SHAPE mark; the wordmark and the gap are
 * derived from it so a lockup stays proportional at any size. The ratios below
 * are taken from the marketing site's lockups (mark 56/wordmark 44/gap 12 and
 * mark 72/wordmark 56/gap 16) so both surfaces read identically.
 */
import markSrc from '@assets/brand/premation-mark.png';
import wordmarkSrc from '@assets/brand/premation-wordmark.png';
import styles from './Logo.module.css';

export type LogoVariant = 'mark' | 'lockup';

export interface LogoProps {
  /** Height (and width) of the shape mark in px. Default 24. */
  size?: number;
  /** `mark` for small places, `lockup` for big ones. Default `lockup`. */
  variant?: LogoVariant;
  className?: string;
  /** Native tooltip. The accessible name is always the brand name. */
  title?: string;
}

export const BRAND_NAME = 'Premation';

/** Intrinsic aspect of premation-wordmark.png (512×96). */
const WORDMARK_ASPECT = 512 / 96;
/** Wordmark height as a fraction of the mark height. */
const WORDMARK_RATIO = 0.78;
/** Gap between mark and wordmark as a fraction of the mark height. */
const GAP_RATIO = 0.22;

export function Logo({ size = 24, variant = 'lockup', className, title }: LogoProps): JSX.Element {
  const markImg = (
    <img
      src={markSrc}
      width={size}
      height={size}
      // In a lockup the wordmark carries the accessible name, so the mark is
      // decorative — otherwise screen readers announce the brand twice.
      alt={variant === 'lockup' ? '' : BRAND_NAME}
      aria-hidden={variant === 'lockup' || undefined}
      className={styles.img}
      draggable={false}
    />
  );

  if (variant === 'mark') {
    return (
      <span className={[styles.lockup, className].filter(Boolean).join(' ')} title={title ?? BRAND_NAME}>
        {markImg}
      </span>
    );
  }

  const wordmarkHeight = Math.max(1, Math.round(size * WORDMARK_RATIO));

  return (
    <span
      className={[styles.lockup, className].filter(Boolean).join(' ')}
      style={{ gap: `${Math.max(2, Math.round(size * GAP_RATIO))}px` }}
      title={title ?? BRAND_NAME}
    >
      {markImg}
      <img
        src={wordmarkSrc}
        height={wordmarkHeight}
        width={Math.round(wordmarkHeight * WORDMARK_ASPECT)}
        alt={BRAND_NAME}
        className={styles.img}
        draggable={false}
      />
    </span>
  );
}

export default Logo;
