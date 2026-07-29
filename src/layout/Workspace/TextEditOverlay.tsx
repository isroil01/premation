/**
 * TextEditOverlay — on-canvas text editing.
 *
 * A `contentEditable` div overlaid on the canvas at the text layer's position,
 * styled to match what the renderer draws (font, size, colour, alignment,
 * rotation, zoom). Commit on Enter, cancel on Escape, commit on blur.
 *
 * This replaces `window.prompt`, which Electron's Chromium refuses — so text
 * editing was silently dead in the desktop build the app actually ships as.
 * The overlay tracks the camera live (rAF while active) so it stays glued to
 * the layer as you pan/zoom.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { useTextEditStore } from '@stores/textEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { readRuns, reindexRuns } from '@core/text/richText';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useProjectStore } from '@stores/projectStore';
import { getRemappedTime } from '@core/timeline/TimelineController';

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
const strp = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Count the characters before (`node`, `offset`) within `root`.
 *
 * A Range's own `toString.length` would be simpler, but it does not count a
 * `<br>` — which is exactly what Shift+Enter inserts here — so every offset
 * after a line break would be short by one and style the wrong characters. This
 * walks the tree the way `innerText` reads it: text nodes contribute their
 * text, a `<br>` contributes one newline.
 *
 * Returns UTF-16 units; the caller converts to code points.
 */
function charOffsetOf(root: Node, node: Node, offset: number): number {
  let count = 0;
  let found = false;

  const walk = (current: Node): void => {
    if (found) return;
    if (current === node && current.nodeType !== Node.TEXT_NODE) {
      // An element container offset counts whole children before it.
      for (let i = 0; i < offset && i < current.childNodes.length; i++) {
        walk(current.childNodes[i]!);
      }
      found = true;
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current === node) {
        count += Math.min(offset, current.textContent?.length ?? 0);
        found = true;
        return;
      }
      count += current.textContent?.length ?? 0;
      return;
    }
    if (current.nodeName === 'BR') {
      count += 1;
      return;
    }
    for (const child of Array.from(current.childNodes)) {
      walk(child);
      if (found) return;
    }
  };

  for (const child of Array.from(root.childNodes)) {
    walk(child);
    if (found) break;
  }
  return count;
}

/** UTF-16 offset -> code-point index, the index space runs are stored in. */
function toCodePointIndex(text: string, utf16Offset: number): number {
  return [...text.slice(0, utf16Offset)].length;
}

/** Merge every component's props, the way buildSnapshot reads a text layer. */
function mergedProps(nodeId: string): Record<string, unknown> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return {};
  const out: Record<string, unknown> = {};
  for (const c of node.components) Object.assign(out, c.props);
  return out;
}

export function TextEditOverlay(): JSX.Element | null {
  const nodeId = useTextEditStore((s) => s.nodeId);
  const end = useTextEditStore((s) => s.end);
  const setSelection = useTextEditStore((s) => s.setSelection);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const committedRef = useRef(false);

  // Keep the overlay glued to the layer while the camera moves.
  useEffect(() => {
    if (!nodeId) return;
    let raf = 0;
    const place = (): void => {
      const box = boxRef.current;
      const p = getWorkspaceController().getNodeScreenPlacement(nodeId);
      if (box && p) {
        box.style.left = `${p.x}px`;
        box.style.top = `${p.y}px`;
        box.style.transform = `translate(-50%, -50%) rotate(${p.rotationDeg}deg) scale(${p.zoom})`;
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);

  // Focus + select-all on open, and seed the current text.
  useLayoutEffect(() => {
    committedRef.current = false;
    const box = boxRef.current;
    if (!nodeId || !box) return;
    box.textContent = strp(mergedProps(nodeId).content) ?? '';
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [nodeId]);

  // Publish the selection so the inspector can style a character range.
  // `selectionchange` is a document-level event — there is no element-level
  // equivalent — so the handler filters to selections inside our box.
  useEffect(() => {
    if (!nodeId) return;
    const onSelectionChange = (): void => {
      const box = boxRef.current;
      const sel = window.getSelection();
      if (!box || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!box.contains(range.commonAncestorContainer)) return;
      const text = box.innerText ?? '';
      const a = toCodePointIndex(text, charOffsetOf(box, range.startContainer, range.startOffset));
      const b = toCodePointIndex(text, charOffsetOf(box, range.endContainer, range.endOffset));
      setSelection({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    onSelectionChange(); // the open-time select-all is itself a selection
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [nodeId, setSelection]);

  if (!nodeId) return null;

  const p = mergedProps(nodeId);
  const size = num(p.fontSize, 48);
  const family = strp(p.fontFamily) ?? 'Inter';
  const weight = strp(p.fontWeight) ?? (typeof p.fontWeight === 'number' ? String(p.fontWeight) : '600');
  const italic = p.fontStyle === 'italic';
  const align = (strp(p.align) ?? 'left') as 'left' | 'center' | 'right' | 'justify';
  const color = strp(p.color) ?? strp(p.fill) ?? '#ffffff';
  const lineHeight = num(p.lineHeight, 1.2);
  const letterSpacing = num(p.letterSpacing, 0);

  const commit = (): void => {
    if (committedRef.current) return;
    committedRef.current = true;
    const node = defaultSceneGraph.getNode(nodeId);
    const textComp = node?.components.find((c) => c.type === 'Text');
    const next = boxRef.current?.innerText ?? '';
    const prev = textComp ? strp(textComp.props.content) ?? '' : '';
    // Source Text keyframed (AE): an edit becomes a keyframe at the playhead —
    // the renderer reads the data track, so writing the static prop would be
    // an edit that changes nothing on screen.
    if (node && textComp && defaultAnimation.isDataAnimated(node.id, 'text.source')) {
      const tab = useProjectStore.getState();
      const t = tab.tabs[tab.activeTabId ?? '']?.time ?? 0;
      const layerT = getRemappedTime(node.id, t);
      if (next !== defaultAnimation.sampleData(node.id, 'text.source', layerT)) {
        runAnimEdit('Edit Source Text keyframe', () => {
          defaultAnimation.setDataKeyframe(node.id, 'text.source', 'text', layerT, next);
        });
      }
      return;
    }
    if (node && textComp && next !== prev) {
      // Emits NodeUpdated, which the history snapshot records — the same
      // undoable path every canvas prop edit uses. (Not runAnimEdit: that is
      // for keyframes, and text content is a plain node prop.)
      updateNodeComponentProp(defaultSceneGraph, node.id, textComp.id, 'content', next);
      // Runs address characters by index, so an edit that shifts characters
      // must shift the runs with them — otherwise typing a word at the front
      // slides the layer's whole styling one word to the right.
      const runs = readRuns(node);
      if (runs.length > 0) {
        updateNodeComponentProp(
          defaultSceneGraph,
          node.id,
          textComp.id,
          '__runs',
          reindexRuns(runs, prev, next),
        );
      }
    }
    end();
  };

  return (
    <div
      ref={boxRef}
      role="textbox"
      aria-label="Edit text"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committedRef.current = true; // cancel: discard edits
          end();
        }
      }}
      onBlur={commit}
      style={{
        position: 'absolute',
        // transform-origin at the layer's anchor so rotate/scale pivot there.
        transformOrigin: 'center',
        // whiteSpace pre keeps newlines and leading spaces the renderer honours.
        whiteSpace: 'pre',
        minWidth: '1ch',
        padding: 0,
        margin: 0,
        outline: '1px solid var(--color-primary, #4c8dff)',
        background: 'transparent',
        caretColor: color,
        color,
        textAlign: align === 'justify' ? 'left' : align,
        fontFamily: `"${family}", Inter, system-ui, sans-serif`,
        fontSize: `${size}px`,
        fontWeight: weight,
        fontStyle: italic ? 'italic' : 'normal',
        lineHeight,
        letterSpacing: `${letterSpacing}px`,
        cursor: 'text',
        zIndex: 20,
      }}
    />
  );
}

export default TextEditOverlay;
