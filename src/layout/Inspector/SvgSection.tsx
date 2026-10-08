/**
 * SvgSection — the Inspector panel for an SVG layer.
 *
 * Shows what the file is, what it contains, and the one action that turns it
 * into editable geometry. Live SVG layers scrub SMIL/CSS at the playhead; other
 * SVG layers are static textures until Convert to Editable Shapes.
 */

import { useMemo } from 'react';
import { useMirrorLayer } from '@hooks/useMirror';
import { useSvgDocument } from '@hooks/useSvgDocument';
import { svgCapabilityWarnings } from '@core/svg/svgCapabilities';
import { confirmAndConvertSvg, svgLayerDataOf } from './svgLayerActions';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import styles from './TransformSection.module.css';

/** A capability the conversion will lose — a real warning, so it stays on screen (panel `help` role). */
function Warning({ text }: { text: string }): JSX.Element {
  return (
    <div className={styles.warningBox} role="note">
      <Icon name="warning" size="sm" />
      <span>{text}</span>
    </div>
  );
}

/** A read-only fact about the file: label, then the value as a readout. */
function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.popoverRow}>
      <span className={styles.popoverLabel}>{label}</span>
      <span className={styles.readout} title={value}>{value}</span>
    </div>
  );
}

export function SvgSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: the layer's mirror header decides whether it is (still) an SVG layer
  // and wakes the section when it changes.
  const layer = useMirrorLayer(nodeId);
  // The stored document (file name, intrinsic size, capability scan, playback) — the engine's `getSvgDocument`.
  const doc = useSvgDocument(layer?.svg === 'layer' ? nodeId : null);
  const data = useMemo(() => (layer?.svg === 'layer' ? svgLayerDataOf(doc) : null), [layer, doc]);
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

      <div className={styles.stackAfter}>
        {warnings.map((w) => (
          <Warning key={w} text={w} />
        ))}
        {/* What converting costs is the button's tooltip, not a paragraph in the list. */}
        <Button
          size="sm"
          variant="secondary"
          fullWidth
          title={data.livePlayback
            ? 'This animated SVG plays with the timeline. Convert only when you need per-path keyframes — gradients, masks and filters may flatten.'
            : 'The original file is stored intact and rendered as authored. Convert it to edit individual paths — gradients, masks and filters are flattened when you do.'}
          onClick={() => void confirmAndConvertSvg(nodeId)}
        >
          Convert to Editable Shapes
        </Button>
      </div>
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
    <div className={styles.stackAfter}>
      <Button
        size="sm"
        variant="secondary"
        fullWidth
        title="Converted from an SVG. The original file is still stored on this group."
        onClick={onRevert}
      >
        Revert to Original SVG
      </Button>
    </div>
  );
}
