/**
 * TextEditOverlay — on-canvas text editing.
 *
 * A `contentEditable` div overlaid on the canvas at the text layer's position,
 * styled to match what the renderer draws (font, size, colour, alignment,
 * rotation, zoom). Enter inserts a newline (After Effects).
 *
 * Committing, as in AE:
 *   • Ctrl/Cmd+Enter, or ENTER ON THE NUMERIC KEYPAD — AE's "exit text edit";
 *   • Escape — AE keeps your edits when you leave text editing with Esc;
 *   • clicking anywhere outside the box (and outside the Character panel).
 * Discarding is the separate, explicit Shift+Escape.
 *
 * Focus moving INTO an element marked `data-text-edit-keep` (the Character
 * panel) does not end the edit: the character selection stays live, so a
 * size, colour or kerning change applies to the selected characters or the
 * caret — the whole point of editing them from the panel.
 *
 * This replaces `window.prompt`, which Electron's Chromium refuses — so text
 * editing was silently dead in the desktop build the app actually ships as.
 * The overlay tracks the camera live (rAF while active) so it stays glued to
 * the layer as you pan/zoom.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { readGeometry } from '@core/workspace/geometry';
import { useTextEditStore, TEXT_EDIT_KEEP_ATTR } from '@stores/textEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readRuns, reindexRuns } from '@core/text/richText';
import { utf16ToGraphemeIndex } from '@core/text/graphemes';
import { readParagraphBox, readParagraphDirection, resolveAlignForDirection } from '@core/text/textExtras';
import { isAutoTextLayerName, textLayerNameFor } from '@core/text/textLayerName';
import { defaultAnimation } from '@motion/animation';
import { isLayer } from '@core/engine/doc';
import { commitSourceTextEdit } from './viewportEdits';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { installTextCommands } from '@layout/Inspector/textCommands';
import {
  installParagraphTextCommands,
  TEXT_CONVERT_TO_PARAGRAPH_COMMAND,
  TEXT_CONVERT_TO_POINT_COMMAND,
} from '@layout/Inspector/paragraphTextCommands';
import { measureTextNodeParagraphBox } from '@core/text/measureText';
import { openContextMenu } from '@stores/contextMenuStore';
import { TextBoxHandles } from './TextBoxHandles';

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
const strp = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Inside a surface that belongs to the inspector — the Character panel, or a
 * popover it opened. Popovers (font picker, colour picker) PORTAL to <body>,
 * outside the panel, so they carry the attribute themselves; the node may
 * also be a text node inside one, which has no `closest` of its own.
 */
export function insideKeepZone(el: EventTarget | null): boolean {
  let node = el as (Node & { closest?: (s: string) => Element | null }) | null;
  if (node && typeof node.closest !== 'function') node = (node as Node).parentElement;
  return !!node && typeof node.closest === 'function' && node.closest(`[${TEXT_EDIT_KEEP_ATTR}]`) !== null;
}

/**
 * Count the characters before (`node`, `offset`) within `root`.
 *
 * A Range's own `toString.length` would be simpler, but it does not count a
 * `<br>` — which is exactly what Shift+Enter inserts here — so every offset
 * after a line break would be short by one and style the wrong characters. This
 * walks the tree the way `innerText` reads it: text nodes contribute their
 * text, a `<br>` contributes one newline.
 *
 * Returns UTF-16 units; the caller converts to grapheme clusters.
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
  const commitRef = useRef<() => void>(() => {});
  /** The text as TYPED (null until the first keystroke): the preview's box
   *  alignment and overflow follow it, not the last committed content. */
  const [draft, setDraft] = useState<string | null>(null);

  // The text commands (Swap Fill and Stroke, Shift+X) live with the text
  // feature; this component is always mounted with the workspace.
  useEffect(() => {
    installTextCommands();
    installParagraphTextCommands();
  }, []);

  // Keep the overlay glued to the layer while the camera moves.
  useEffect(() => {
    if (!nodeId) return;
    let raf = 0;
    const place = (): void => {
      const box = boxRef.current;
      const p = getWorkspaceController().getNodeScreenPlacement(nodeId);
      const node = defaultSceneGraph.getNode(nodeId);
      const geom = node ? readGeometry(node) : null;
      if (box && p) {
        const zoom = p.zoom;
        const sx = p.scaleX ?? 1;
        const sy = p.scaleY ?? 1;
        const ox = (geom?.offsetX ?? 0) * zoom * sx;
        const oy = (geom?.offsetY ?? 0) * zoom * sy;
        box.style.left = `${p.x}px`;
        box.style.top = `${p.y}px`;
        // Only PARAGRAPH text has a box to pin the editor to. `geom` measures
        // the COMMITTED content, so pinning point text to it froze the editor
        // at the width of the old text ("Text", for a layer made a moment ago)
        // while a whole sentence was typed into it — a fixed box that point
        // text, by definition, does not have. Point text sizes to its own
        // content (`max-content`) and so grows as you type,
        // centred on the layer origin exactly as the renderer centres it.
        const hasBox = !!node && readParagraphBox(node) !== null;
        if (hasBox && geom && geom.width > 0 && geom.height > 0) {
          box.style.width = `${geom.width}px`;
          box.style.height = `${geom.height}px`;
        } else if (!hasBox) {
          box.style.width = 'max-content';
          box.style.height = 'auto';
        }
        box.style.transform =
          `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px)) rotate(${p.rotationDeg}deg) scale(${zoom * sx}, ${zoom * sy})`;
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);

  // Hide the canvas glyphs while the overlay is up, and restore them on close.
  useEffect(() => {
    if (!nodeId) return;
    getWorkspaceController().requestRender();
    return () => getWorkspaceController().requestRender();
  }, [nodeId]);
  useLayoutEffect(() => {
    committedRef.current = false;
    setDraft(null);
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
      const a = utf16ToGraphemeIndex(text, charOffsetOf(box, range.startContainer, range.startOffset));
      const b = utf16ToGraphemeIndex(text, charOffsetOf(box, range.endContainer, range.endOffset));
      setSelection({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    onSelectionChange(); // the open-time select-all is itself a selection
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [nodeId, setSelection]);

  // A click outside the box commits — including after focus has moved into
  // the Character panel, where the box's own blur deliberately did not.
  useEffect(() => {
    if (!nodeId) return;
    const onPointerDown = (e: PointerEvent): void => {
      const box = boxRef.current;
      const target = e.target as Node | null;
      if (box && target && box.contains(target)) return;
      if (insideKeepZone(e.target)) return;
      commitRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [nodeId]);

  // The paragraph box (outline, reflow handles, overflow) also shows for the
  // Type tool on a selected paragraph layer, so it renders without an edit.
  if (!nodeId) return <TextBoxHandles />;

  const p = mergedProps(nodeId);
  const editedNode = defaultSceneGraph.getNode(nodeId);
  const box = editedNode ? measureTextNodeParagraphBox(editedNode, draft !== null ? { content: draft } : undefined) : null;
  // Fit Text to Box previews at the scale the canvas draws at.
  const fit = box?.fitScale ?? 1;
  const size = num(p.fontSize, 48) * fit;
  const family = strp(p.fontFamily) ?? 'Inter';
  const weight = strp(p.fontWeight) ?? (typeof p.fontWeight === 'number' ? String(p.fontWeight) : '600');
  const italic = p.fontStyle === 'italic' || p.fauxItalic === true;
  // Vertical type edits in a vertical-rl box (the caret walks down columns
  // flowing right to left); a right-to-left paragraph edits with dir="rtl", so
  // the caret, selection and bidi order follow the text. The stored alignment
  // reads from the START edge in RTL, exactly as the painter mirrors it.
  const vertical = p.orientation === 'vertical';
  const dirProp = readParagraphDirection(p.direction);
  const rtl = !vertical && dirProp === 'rtl';
  // 'auto': the browser resolves EACH paragraph's direction from its first
  // strong character (dir="auto" + unicode-bidi: plaintext — UAX #9 P2/P3, as
  // the painter does), and 'start' / 'end' alignment follow each paragraph.
  const auto = !vertical && dirProp === 'auto';
  const aligned = resolveAlignForDirection(strp(p.align), rtl ? 'rtl' : 'ltr');
  const cssAlign = (l: 'left' | 'center' | 'right'): 'left' | 'center' | 'right' | 'start' | 'end' =>
    auto && l !== 'center' ? (l === 'left' ? 'start' : 'end') : l;
  const color = strp(p.color) ?? strp(p.fill) ?? '#ffffff';
  const lineHeight = num(p.lineHeight, 1.2);
  const letterSpacing = num(p.letterSpacing, 0) * fit;
  const boxWidth = num(p.boxWidth, 0);
  const paragraph = boxWidth > 0;
  // A FIXED box previews the way the painter draws it: the line block sits
  // where `placeLinesInBox` puts it — its top at the box centre minus half the
  // block, plus the alignment offset (0 for top, and for any text that
  // overflows, which yields to top) — and nothing shows past the box.
  const fixedBox = !!box && box.fixedHeight;
  const boxPadTop = box && fixedBox
    ? Math.max(0, box.boxHeight / 2 - box.contentHeight / 2 + box.lineOffsetY)
    : 0;

  const cancel = (): void => {
    committedRef.current = true; // discard edits
    end();
  };

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
    const t = getPlayheadTime();
    // Every write goes through the engine API, which addresses a composition's
    // LAYERS. A text node that is not one (none exists in the editor: text is
    // only ever created as a layer) has no address, so its edit is not kept.
    // The overlay stays up until the edit has landed, so the layer's glyphs
    // never show the old text for a frame.
    if (!node || !textComp || !isLayer(node.id)) {
      end();
      return;
    }
    if (defaultAnimation.isDataAnimated(node.id, 'text.source')) {
      // Source Text is animated: `setProperty` at the playhead keys it (AE).
      // Compared with what the playhead shows, so an unchanged commit adds no key.
      if (next !== defaultAnimation.sampleData(node.id, 'text.source', getRemappedTime(node.id, t))) {
        void commitSourceTextEdit(node.id, next, { seconds: t, label: 'Edit Source Text keyframe' }).finally(end);
        return;
      }
      end();
      return;
    }
    if (next !== prev) {
      // Content (+ the auto-name that follows it, + the style runs re-indexed so
      // styling stays on its characters — `text/styleRuns`, G1) as ONE entry.
      // AE: a text layer is NAMED after what it says, until the user names it.
      // "Still ours to rename" = the name is the tool's default or is what the
      // previous content would have produced — anything else was typed by hand.
      // Runs address characters by index, so an edit that shifts characters
      // must shift the runs with them — otherwise typing a word at the front
      // slides the layer's whole styling one word to the right.
      const auto = isAutoTextLayerName(node.name, prev) ? textLayerNameFor(next) : null;
      const rename = auto && auto !== node.name ? auto : undefined;
      const runs = readRuns(node);
      void commitSourceTextEdit(node.id, next, {
        seconds: t, label: 'Edit Text', ...(rename ? { rename } : {}), ...(runs.length > 0 ? { runs: reindexRuns(runs, prev, next) } : {}),
      }).finally(end);
      return;
    }
    end();
  };
  commitRef.current = commit;

  return (
    <>
    <TextBoxHandles overflow={box ? box.overflow : undefined} />
    <div
      ref={boxRef}
      role="textbox"
      aria-label="Edit text"
      dir={auto ? 'auto' : rtl ? 'rtl' : 'ltr'}
      data-overflow={box?.overflow || undefined}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => setDraft(e.currentTarget.innerText ?? '')}
      // Clipped at the box: the caret may scroll the lines inside it (never
      // sideways), but nothing spills past its edges.
      onScroll={fixedBox ? (e) => { if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0; } : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // AE: right-click in the text while editing offers the conversions.
        // Choosing one clicks outside the editor, which commits first.
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, [
          paragraph
            ? { id: 'text-convert-point', commandId: TEXT_CONVERT_TO_POINT_COMMAND }
            : { id: 'text-convert-paragraph', commandId: TEXT_CONVERT_TO_PARAGRAPH_COMMAND },
        ]);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        // AE: Enter inserts a line; keypad Enter and Ctrl/Cmd+Enter commit.
        // Escape commits too (AE keeps the edits); Shift+Escape discards.
        const numpadEnter = e.key === 'Enter' && e.code === 'NumpadEnter';
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || numpadEnter)) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (e.shiftKey) cancel();
          else commit();
        }
      }}
      onBlur={(e) => {
        // Moving into the Character panel keeps the edit (and its selection)
        // alive; the document pointerdown listener commits on a real outside
        // click.
        if (insideKeepZone(e.relatedTarget)) return;
        commit();
      }}
      style={{
        position: 'absolute',
        // transform-origin at the layer's anchor so rotate/scale pivot there.
        transformOrigin: 'center',
        boxSizing: 'border-box',
        // pre-wrap: hard returns AND paragraph wrap inside the authored box.
        whiteSpace: paragraph ? 'pre-wrap' : 'pre',
        overflowWrap: paragraph ? 'break-word' : 'normal',
        minWidth: '1ch',
        minHeight: '1em',
        padding: 0,
        paddingTop: boxPadTop,
        margin: 0,
        ...(fixedBox ? { overflow: 'hidden' as const } : {}),
        // Paragraph text: TextBoxHandles draws AE's dashed box instead.
        outline: paragraph ? 'none' : '1px solid var(--color-primary, #4c8dff)',
        background: 'transparent',
        caretColor: color,
        color,
        // Justified paragraph text previews justified, with its last line
        // aligned per the variant — the browser's own text-align-last.
        textAlign: paragraph && aligned.justify ? 'justify' : cssAlign(aligned.line),
        textAlignLast: aligned.justifyLast ? 'justify' : cssAlign(aligned.line),
        ...(auto ? { unicodeBidi: 'plaintext' as const } : {}),
        // Japanese line breaking (kinsoku) close to the painter's lineBreak.ts,
        // so a CJK paragraph previews wrapped where it will be drawn.
        ...(paragraph ? { lineBreak: 'strict' as const } : {}),
        fontFamily: `"${family}", Inter, system-ui, sans-serif`,
        fontSize: `${size}px`,
        fontWeight: weight,
        fontStyle: italic ? 'italic' : 'normal',
        lineHeight,
        letterSpacing: `${letterSpacing}px`,
        ...(vertical
          ? { writingMode: 'vertical-rl' as const, textOrientation: p.verticalRomanAlignment === true ? 'upright' as const : 'mixed' as const }
          : {}),
        cursor: vertical ? 'vertical-text' : 'text',
        zIndex: 20,
      }}
    />
    </>
  );
}

export default TextEditOverlay;
