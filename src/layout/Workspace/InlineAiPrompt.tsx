/**
 * "AI in the flow, not in a panel" — `Ctrl+Enter` on a selection opens a small
 * prompt anchored to what is selected. Type "stagger these by 3f", press
 * Enter, and the preview transaction's Apply / Decline appears in the same
 * card. The panel stays for a conversation; this is for a sentence.
 *
 * ## The same path as the chat panel
 *
 * It runs `useAiChat()` — the same hook the AI panel uses, the same 65 tools,
 * the same preview transaction with `acceptPending` / `discardPending`. There
 * is no second AI code path here, and deliberately so: a second one would
 * drift from the first the week after it landed.
 *
 * The hook is heavy (a conversation store, a tool registry, several effects),
 * so the mounted component is a shell that renders NOTHING until the prompt
 * opens. `InlineAiPromptCard` — the half that calls the hook — is mounted only
 * while the card is on screen, which is what keeps this free in the 99% of
 * sessions where it is never used.
 *
 * ## Anchoring
 *
 * Under the union of the selected layers' screen rects, computed through
 * `layerScreenMapping` — the shared projection, so it follows parenting, 3D
 * and animation the same way the rig and effect handles do. Clamped into the
 * stage, because a selection can be half off screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Kbd } from '@components/Kbd';
import { aiEnabled } from '@core/config/edition';
import { secondsToFlicks, type OverlayKind } from '@motion/engine-api';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers, subscribeOverlayGeometry } from '@stores/overlayGeometry';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useInlineAiPromptStore } from './inlineAiPromptStore';
import { useAiChat } from './useAiChat';
import styles from './InlineAiPrompt.module.css';

/** Card width, mirroring `.card` — used only to clamp it inside the stage. */
const CARD_W = 340;
/** Gap between the selection's box and the card. */
const GAP = 8;
/** The overlay geometry the card anchors on: the targets' drawn boxes. */
const ANCHOR_KINDS: ReadonlyArray<OverlayKind> = ['bounds'];

export function InlineAiPrompt(): JSX.Element | null {
  const open = useInlineAiPromptStore((s) => s.open);
  const targetIds = useInlineAiPromptStore((s) => s.targetIds);
  if (!open || !aiEnabled() || targetIds.length === 0) return null;
  return <InlineAiPromptCard targetIds={targetIds} />;
}

function InlineAiPromptCard({ targetIds }: { targetIds: readonly string[] }): JSX.Element {
  const close = useInlineAiPromptStore((s) => s.close);
  const time = useCurrentTime();
  const comp = useActiveCompSize();
  const sceneTick = useMirrorRevisionFrame();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [prompt, setPrompt] = useState('');
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const ai = useAiChat();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setStage({ w: Math.round(r.width), h: Math.round(r.height) });
  }, [sceneTick]);

  // B4: the targets' drawn boxes arrive with the frame (the overlay geometry push).
  const [geoTick, setGeoTick] = useState(0);
  useEffect(() => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'inlineAi', targetIds, ANCHOR_KINDS).then(() => setGeoTick((t) => t + 1));
    const off = subscribeOverlayGeometry(MAIN_VIEWPORT, () => setGeoTick((t) => t + 1));
    return () => {
      off();
      void requestOverlayLayers(MAIN_VIEWPORT, 'inlineAi', [], ANCHOR_KINDS);
    };
  }, [targetIds]);

  const anchor = useMemo(
    () => selectionScreenRect(targetIds, time),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton; the tick is the push landing
    [targetIds, time, comp.width, comp.height, sceneTick, geoTick],
  );

  const submit = useCallback(() => {
    const text = prompt.trim();
    if (!text || ai.busy) return;
    // The selection IS the context — named, so the model does not have to
    // infer "these" from a screenshot it cannot see.
    const m = documentMirror();
    const names = targetIds
      .map((id) => m.layer(id)?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const context = names.length
      ? `Selected layers: ${names.map((n) => `“${n}”`).join(', ')}.`
      : `Selected layer ids: ${targetIds.join(', ')}.`;
    void ai.submit(`${context}\n\n${text}`);
    setPrompt('');
  }, [prompt, ai, targetIds]);

  // Escape closes — rolling back a pending transaction on the way out, so an
  // un-reviewed preview is never left applied to the scene by accident.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (ai.hasPendingTx) ai.discardPending();
      close();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };

  const left = anchor
    ? Math.max(GAP, Math.min(Math.max(GAP, stage.w - CARD_W - GAP), anchor.x + anchor.w / 2 - CARD_W / 2))
    : GAP;
  const top = anchor ? Math.max(GAP, Math.min(Math.max(GAP, stage.h - 60), anchor.y + anchor.h + GAP)) : GAP;

  return (
    <div ref={rootRef} className={styles.root} data-inline-ai-prompt="">
      <div
        className={styles.card}
        style={{ left, top }}
        role="dialog"
        aria-label="Ask AI about the selection"
        onKeyDown={onKeyDown}
      >
        <span className={styles.context}>
          {targetIds.length === 1 ? '1 layer selected' : `${targetIds.length} layers selected`}
        </span>
        <div className={styles.row}>
          <input
            ref={inputRef}
            className={styles.input}
            value={prompt}
            placeholder="stagger these by 3f…"
            aria-label="Prompt"
            disabled={ai.busy}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <Button size="sm" variant="primary" disabled={ai.busy || !prompt.trim()} onClick={submit}>
            Ask
          </Button>
        </div>

        {ai.busy && <span className={styles.activity}>{ai.activity || 'Working…'}</span>}

        {/* The preview transaction, inline. Same accept/discard the panel uses,
            so a change reviewed here and a change reviewed there are one thing. */}
        {ai.hasPendingTx && (
          <>
            <ul className={styles.changes}>
              {ai.pendingChanges.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={() => ai.discardPending()}>
                Decline
              </Button>
              <Button size="sm" variant="primary" onClick={() => { ai.acceptPending(); close(); }}>
                Apply
              </Button>
            </div>
          </>
        )}

        {!ai.busy && !ai.hasPendingTx && (
          <span className={styles.context}>
            <Kbd chord="Enter" size="sm" /> to ask · <Kbd chord="Esc" size="sm" /> to close
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The union of the selected layers' boxes in stage screen px, or null when
 * none of them can be projected (deleted, or a kind with no geometry).
 */
function selectionScreenRect(
  ids: readonly string[],
  time: number,
): { x: number; y: number; w: number; h: number } | null {
  const ws = getWorkspaceController().ws;
  const at = secondsToFlicks(time);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    // The drawn box's corners in comp space, through the 2D world chain (the
    // push's `bounds`): a 3D layer anchors on its unprojected footprint.
    const c = overlayLayer(MAIN_VIEWPORT, id, at)?.corners;
    if (!c || c.length < 8) continue;
    for (let i = 0; i < 8; i += 2) {
      const p = ws.worldToScreen({ x: c[i]!, y: c[i + 1]! });
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
