/**
 * InfoReadout — AE's Info panel, condensed into the status bar: the pixel
 * colour swatch + RGBA and the composition-space X,Y under the pointer. Fed by
 * the workspace pointer handler via `infoStore`; shows a muted placeholder when
 * the cursor is off the viewport (or the colour is unreadable on the GPU
 * backend).
 */

import { useInfoStore } from '@stores/infoStore';

const mono: React.CSSProperties = {
  fontFamily: 'var(--font-family-mono)',
  fontVariantNumeric: 'tabular-nums',
};

export function InfoReadout(): JSX.Element {
  const { x, y, rgba, present } = useInfoStore();

  if (!present) {
    return <span style={{ ...mono, color: 'var(--color-text-muted)' }} title="Info: cursor color + position">—</span>;
  }

  const swatch =
    rgba && rgba.a > 0
      ? `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${(rgba.a / 255).toFixed(2)})`
      : 'transparent';

  return (
    <span
      style={{ ...mono, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)' }}
      title="Info: pixel color (RGBA) and composition position under the cursor"
    >
      <span
        aria-hidden
        style={{
          width: 11,
          height: 11,
          borderRadius: 2,
          background: swatch,
          border: '1px solid var(--color-border)',
          // Checker so a transparent/low-alpha swatch is distinguishable.
          backgroundImage:
            'linear-gradient(45deg,var(--color-surface-3) 25%,transparent 25%,transparent 75%,var(--color-surface-3) 75%)',
          backgroundSize: '6px 6px',
        }}
      >
        <span style={{ display: 'block', width: '100%', height: '100%', background: swatch, borderRadius: 1 }} />
      </span>
      {rgba ? <span>{`${rgba.r} ${rgba.g} ${rgba.b} ${rgba.a}`}</span> : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
      <span style={{ opacity: 0.4 }}>·</span>
      <span>{`${x}, ${y}`}</span>
    </span>
  );
}
