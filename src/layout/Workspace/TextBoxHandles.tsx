/**
 * TextBoxHandles — AE's paragraph text box, drawn over the canvas while you
 * type: a dashed box outline, eight handles that RESIZE THE BOX (the text
 * re-wraps at the same font size) and, when the text runs past the bottom of a
 * fixed box, the red overflow "+" on the bottom-right handle.
 *
 * Shown while a paragraph text layer is being edited in place, or while the
 * Type tool is active with one paragraph layer selected — AE's two "box
 * handles" states. With the Selection tool the canvas's own handles scale the
 * layer instead (unchanged).
 *
 * DOM, not the canvas overlay, for one reason: a press on a handle must not
 * end in-place editing. The handles carry `data-text-edit-keep` (so the
 * editor's outside-click commit ignores them) and swallow mousedown (so focus,
 * and the caret, stay in the editor). The write side is `textBoxReflow.ts`.
 */

import { useEffect, useRef } from 'react';
import { secondsToFlicks, type OverlayKind } from '@motion/engine-api';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { playheadSeconds } from '@core/timeline/timelineView';
import { useTextEditStore, TEXT_EDIT_KEEP_ATTR } from '@stores/textEditStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { MAIN_VIEWPORT, overlayLayer, overlayScreenPlacement, requestOverlayLayers } from '@stores/overlayGeometry';
import { useMirrorRevision } from '@hooks/useMirror';
import { useTextLayout } from '@hooks/useTextLayout';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorParagraphBox } from '@layout/Text/textMirror';
import { BOX_HANDLES, handleLocalPosition, type BoxHandle } from '@core/text/paragraphBox';
import { beginBoxReflow, type BoxReflowSession } from './textBoxReflow';
import styles from './TextBoxHandles.module.css';

const HANDLE_CURSOR: Record<BoxHandle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

/** Which layer's box to show, if any: the one being edited, else the Type tool's selection (B4: from the mirror). */
export function textBoxTargetId(
  editingId: string | null,
  activeTool: string,
  selection: ReadonlyArray<string>,
): string | null {
  const typeTool = activeTool === 'text' || activeTool === 'vertical-text';
  const id = editingId ?? (typeTool && selection.length === 1 ? selection[0]! : null);
  if (!id) return null;
  const m = documentMirror();
  const layer = m.layer(id);
  if (!layer || uiKindOf(layer) !== 'text') return null;
  return mirrorParagraphBox(m, id) ? id : null;
}

/** What the text box handles ask of the overlay geometry push: the layer's matrix and its measured box. */
const TEXT_BOX_KINDS: ReadonlyArray<OverlayKind> = ['transform', 'textBox'];

export function TextBoxHandles({ overflow: liveOverflow }: {
  /** The in-place editor's overflow for the text being TYPED (not yet
   *  committed), so the "+" follows each keystroke. Absent = the layer's. */
  overflow?: boolean;
} = {}): JSX.Element | null {
  const editingId = useTextEditStore((s) => s.nodeId);
  const activeTool = useUIStore((s) => s.activeTool) as string;
  const selection = useSelectionStore((s) => s.ids);
  useMirrorRevision();
  const target = textBoxTargetId(editingId, activeTool, selection);
  // The layer's measured paragraph box (the engine's getTextLayout).
  const layout = useTextLayout(target);
  const overflow = liveOverflow ?? layout?.paragraph?.overflow === true;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const handleRefs = useRef<Partial<Record<BoxHandle, HTMLDivElement | null>>>({});
  const dragRef = useRef<{ session: BoxReflowSession; x: number; y: number; zoom: number; pointerId: number } | null>(null);

  // The box and matrix come with each frame (the overlay geometry push, B4).
  useEffect(() => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'textBox', target ? [target] : [], TEXT_BOX_KINDS);
    return () => { void requestOverlayLayers(MAIN_VIEWPORT, 'textBox', [], TEXT_BOX_KINDS); };
  }, [target]);

  // Glue to the layer every frame, like the in-place editor.
  useEffect(() => {
    if (!target) return;
    let raf = 0;
    const place = (): void => {
      const root = rootRef.current;
      const ws = getWorkspaceController().ws;
      const g = overlayLayer(MAIN_VIEWPORT, target, secondsToFlicks(playheadSeconds()));
      const p = overlayScreenPlacement(g, (q) => ws.worldToScreen(q));
      const box = g?.textBox;
      if (root && p && box && box.length >= 4) {
        const zoom = ws.camera.zoom;
        const kx = zoom * p.scaleX;
        const ky = zoom * p.scaleY;
        const w = box[2]! * kx;
        const h = box[3]! * ky;
        // The push's box is local x, y, width, height; the handles lay out on a
        // box centred on the layer origin shifted by (ox, oy) — the box's own
        // centre (readGeometry's offsetY; x is centred for the page's boxes).
        const ox = (box[0]! + box[2]! / 2) * kx;
        const oy = (box[1]! + box[3]! / 2) * ky;
        root.style.left = `${p.x}px`;
        root.style.top = `${p.y}px`;
        root.style.transform = `rotate(${p.rotationDeg}deg)`;
        const outline = outlineRef.current;
        if (outline) {
          outline.style.left = `${-w / 2 + ox}px`;
          outline.style.top = `${-h / 2 + oy}px`;
          outline.style.width = `${w}px`;
          outline.style.height = `${h}px`;
        }
        for (const hid of BOX_HANDLES) {
          const el = handleRefs.current[hid];
          if (!el) continue;
          const at = handleLocalPosition(hid, w, h, oy);
          el.style.left = `${at.x + ox}px`;
          el.style.top = `${at.y}px`;
        }
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  // A gesture must never outlive the component (tool switch mid-drag).
  useEffect(() => () => {
    dragRef.current?.session.end();
    dragRef.current = null;
  }, [target]);

  if (!target) return null;

  const finish = (pointerId: number): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== pointerId) return;
    dragRef.current = null;
    d.session.end();
    getWorkspaceController().requestRender();
  };

  const keep = { [TEXT_EDIT_KEEP_ATTR]: '' };
  return (
    <div ref={rootRef} className={styles.root} {...keep}>
      <div ref={outlineRef} className={styles.outline} data-overflow={overflow || undefined} />
      {BOX_HANDLES.map((hid) => (
        <div
          key={hid}
          ref={(el) => { handleRefs.current[hid] = el; }}
          role="presentation"
          className={styles.handle}
          data-handle={hid}
          data-overflow={hid === 'se' && overflow ? true : undefined}
          style={{ cursor: HANDLE_CURSOR[hid] }}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const session = beginBoxReflow(target, hid);
            if (!session) return;
            const zoom = getWorkspaceController().ws.camera.zoom;
            dragRef.current = { session, x: e.clientX, y: e.clientY, zoom: zoom || 1, pointerId: e.pointerId };
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* synthetic pointer — capture is best-effort */
            }
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            d.session.update({ x: (e.clientX - d.x) / d.zoom, y: (e.clientY - d.y) / d.zoom });
            getWorkspaceController().requestRender();
          }}
          onPointerUp={(e) => finish(e.pointerId)}
          onPointerCancel={(e) => finish(e.pointerId)}
          onLostPointerCapture={(e) => finish(e.pointerId)}
        >
          {hid === 'se' && overflow ? (
            <svg className={styles.overflowGlyph} viewBox="0 0 10 10" aria-label="Text overflows the box">
              <path d="M5 2.2v5.6M2.2 5h5.6" stroke="var(--color-overlay-text)" strokeWidth="1.4" fill="none" />
            </svg>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default TextBoxHandles;
