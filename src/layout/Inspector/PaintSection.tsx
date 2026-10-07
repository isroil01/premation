/**
 * Properties ▸ Paint (AE parity 5.6): the selected layer's paint strokes —
 * the same list the Paint panel shows (select to redraw, video switch, key the
 * Path, delete, Paint on Transparent) — with the Brush tool and the Paint panel
 * one click away, so painting is reachable from the layer's properties.
 */

import { Button } from '@components/Button';
import { useLayoutStore } from '@stores/layoutStore';
import { useMirrorTree } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { isPaintableLayer } from '@core/mirror/layerKinds';
import { mirrorPaintStrokes } from '@core/mirror/paintStrokes';
import { PaintStrokeList } from '@layout/Paint/PaintPanel';
import { setPaintTool } from '@layout/Paint/paintTool';
import { PropertyRow } from '@components/PropertyRow';

/** A paintable layer that has strokes (a fresh layer gets the section from the Paint panel / Brush tool). */
export function hasPaintSection(nodeId: string): boolean {
  const m = documentMirror();
  return isPaintableLayer(m.layer(nodeId)) && mirrorPaintStrokes(m, nodeId).length > 0;
}

export function PaintSection({ nodeId }: { nodeId: string }): JSX.Element {
  useMirrorTree(nodeId);
  return (
    <div data-paint-section="">
      <PaintStrokeList layerId={nodeId} />
      <PropertyRow label="" compact>
        <span style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="secondary" onClick={() => setPaintTool('brush')}>Brush Tool</Button>
          <Button size="sm" variant="secondary" onClick={() => useLayoutStore.getState().openPanel('paint')}>Paint Panel</Button>
        </span>
      </PropertyRow>
    </div>
  );
}

export default PaintSection;
