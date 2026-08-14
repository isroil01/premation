/**
 * SvgSection — the Inspector panel for an SVG layer.
 *
 * Shows what the file is, what it contains, and the one action that turns it
 * into editable geometry. Live SVG layers scrub SMIL/CSS at the playhead; other
 * SVG layers are static textures until Convert to Editable Shapes.
 */

import { useMemo } from 'react';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readSvgLayer } from '@core/svg/svgLayer';
import { svgCapabilityWarnings } from '@core/svg/svgCapabilities';
import { confirmAndConvertSvg } from './svgLayerActions';
import { Icon } from '@components/Icon';
import styles from './TransformSection.module.css';

function Warning({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'flex-start',
        fontSize: 10,
        lineHeight: 1.45,
        color: '#ffb703',
        background: 'rgba(255, 183, 3, 0.08)',
        border: '1px solid rgba(255, 183, 3, 0.2)',
        borderRadius: 4,
        padding: '6px 8px',
      }}
    >
      <Icon name="warning" size="sm" style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{text}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.popoverRow}>
      <span className={styles.popoverLabel}>{label}</span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 150,
          textAlign: 'right',
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function SvgSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const data = useMemo(() => (node ? readSvgLayer(node) : null), [node]);
  if (!data) return null;

  const warnings = svgCapabilityWarnings(data.capabilities);

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        <Row label="File" value={data.fileName} />
        <Row
          label="Dimensions"
          value={`${Math.round(data.intrinsicWidth)} × ${Math.round(data.intrinsicHeight)}`}
        />
        <Row label="Paths" value={String(data.capabilities.pathCount)} />
        <Row label="Playback" value={data.livePlayback ? 'Live SVG (time-scrubbed)' : 'Static texture'} />
      </div>

      {warnings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {warnings.map((w) => (
            <Warning key={w} text={w} />
          ))}
        </div>
      )}

      <p
        style={{
          margin: '12px 0 8px',
          fontSize: 10,
          lineHeight: 1.5,
          color: 'var(--color-text-tertiary)',
        }}
      >
        {data.livePlayback
          ? 'This animated SVG plays with the timeline. Convert to Editable Shapes only when you need per-path keyframes — gradients, masks and filters may flatten.'
          : 'The original file is stored intact and rendered as authored. Convert it to edit individual paths — gradients, masks and filters are flattened when you do.'}
      </p>

      <button
        type="button"
        onClick={() => void confirmAndConvertSvg(nodeId)}
        style={{
          width: '100%',
          background: 'var(--color-surface-3)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-primary)',
          fontSize: 11,
          padding: '6px',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Convert to Editable Shapes
      </button>
    </div>
  );
}

/**
 * RevertSvgRow — shown on a GROUP that was converted from an SVG.
 *
 * Retention (§13) is only worth anything if there is a way to use it, and this
 * is it: one click back to the original document, at any point after the
 * conversion.
 */
export function RevertSvgRow({ onRevert }: { onRevert: () => void }): JSX.Element {
  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ margin: '0 0 6px', fontSize: 'var(--font-size-micro)', lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>
        Converted from an SVG. The original file is still stored on this group.
      </p>
      <button
        type="button"
        onClick={onRevert}
        style={{
          width: '100%',
          background: 'var(--color-surface-3)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-primary)',
          fontSize: 11,
          padding: '6px',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Revert to Original SVG
      </button>
    </div>
  );
}
