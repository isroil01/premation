/**
 * A native plugin's viewer tool (SDK 1.4, U) — the on-canvas half.
 *
 * While a plugin tool is active (`activeTool === 'plugin-tool'`, `pluginTool`
 * says which), this layer claims the pointer like the Roto Brush does. A drag
 * is collected as one stroke in COMPOSITION pixels and drawn as a trail; on
 * release it goes to the tool's command (`runPluginCommand`), so the whole
 * drag is ONE undo entry. Escape drops the stroke in flight.
 *
 *   args: { tool, stroke: [[x, y], …], shift, alt, ctrl }
 *
 * Between, the tool hears the pointer (hover and drag), the wheel and keys
 * (`pluginToolEvent`, PR_COMMAND_TOOL_EVENT, never an edit) and answers with
 * what to draw over the viewer — its brush, a preview of what a release would
 * make — and a status line. Events go one at a time, the latest kept while one
 * is in flight, so a fast pointer never queues a backlog.
 *
 * The plugin decides what a stroke means (the `scatter` sample stamps layers
 * along it); nothing here knows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginToolDrawItem } from '@motion/engine-api';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { engine } from '@core/engine/engineInstance';
import { runPluginCommand } from '@core/nativePlugins/pluginContrib';
import { useDisplayedCamera2D } from './useOverlayView';
import styles from './PluginToolOverlay.module.css';

type Pt = { x: number; y: number };

/** Samples closer than this (comp px) to the last one are jitter, not path. */
const MIN_STEP_PX = 1;
/** The most points one stroke carries to the plugin. */
const MAX_POINTS = 4000;

function activeComp(): string | undefined {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
}

export function PluginToolOverlay(): JSX.Element | null {
  const active = useUIStore((s) => s.activeTool === 'plugin-tool' && s.pluginTool !== null);
  return active ? <PluginToolOverlayActive /> : null;
}

function PluginToolOverlayActive(): JSX.Element {
  const tool = useUIStore((s) => s.pluginTool)!;
  const cam = useDisplayedCamera2D();
  const rootRef = useRef<HTMLDivElement>(null);
  const stroke = useRef<Pt[] | null>(null);
  const pointer = useRef<Pt | null>(null);
  const [trail, setTrail] = useState<Pt[]>([]);
  const [items, setItems] = useState<PluginToolDrawItem[]>([]);
  const [status, setStatus] = useState('');
  // One event in flight; the latest waiting one replaces any older.
  const inFlight = useRef(false);
  const pending = useRef<Record<string, unknown> | null>(null);

  const send = useCallback(
    (event: Record<string, unknown>) => {
      const go = (args: Record<string, unknown>): void => {
        inFlight.current = true;
        const comp = activeComp();
        void engine()
          .query({
            type: 'pluginToolEvent',
            plugin: tool.plugin,
            command: tool.command,
            ...(comp ? { comp } : {}),
            args: JSON.stringify({ tool: tool.tool, ...args }),
          })
          .then((res) => {
            if (res.ok) {
              setItems(res.value.items);
              setStatus(res.value.message);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            inFlight.current = false;
            const next = pending.current;
            pending.current = null;
            if (next) go(next);
          });
      };
      const p = pointer.current;
      const args = {
        ...event,
        ...(p ? { pointer: [p.x, p.y] } : {}),
        ...(stroke.current ? { stroke: stroke.current.map((q) => [q.x, q.y]) } : {}),
      };
      if (inFlight.current) pending.current = args;
      else go(args);
    },
    [tool],
  );

  const toComp = useCallback(
    (e: { clientX: number; clientY: number }): Pt | null => {
      const el = rootRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return cam.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    },
    [cam],
  );

  const add = useCallback((p: Pt | null) => {
    const s = stroke.current;
    if (!p || !s || s.length >= MAX_POINTS) return;
    const last = s[s.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP_PX) return;
    s.push(p);
  }, []);

  const mods = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => ({
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey || e.metaKey,
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    stroke.current = [];
    pointer.current = toComp(e);
    add(pointer.current);
    setTrail([...stroke.current]);
    send({ event: 'move', ...mods(e) });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    pointer.current = toComp(e);
    if (stroke.current) {
      // Every coalesced sample: a fast drag keeps its curve.
      const samples = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
      for (const s of samples.length > 0 ? samples : [e.nativeEvent]) add(toComp(s));
      setTrail([...stroke.current]);
    }
    send({ event: 'move', ...mods(e) });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const points = stroke.current;
    stroke.current = null;
    setTrail([]);
    send({ event: 'move', ...mods(e) });  // the hover again: the preview of the drag goes
    if (!points || points.length === 0) return;
    const comp = activeComp();
    void runPluginCommand(engine(), tool.plugin, tool.command, {
      ...(comp ? { comp } : {}),
      layers: [...useSelectionStore.getState().ids],
      args: { tool: tool.tool, stroke: points.map((p) => [p.x, p.y]), ...mods(e) },
    }).then((res) => {
      if (!res.ok) useUIStore.getState().notify({ level: 'error', message: `${tool.name}: ${res.error}`, durationMs: 6000 });
    });
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    // Ctrl / Cmd + wheel stays the viewer's zoom; a plain wheel is the tool's.
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    pointer.current = toComp(e);
    send({ event: 'wheel', deltaY: e.deltaY, ...mods(e) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape' && stroke.current) {
        stroke.current = null;
        setTrail([]);
        e.stopPropagation();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ event: 'key', key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: false });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    send({ event: 'move' });  // what the tool shows before the pointer moves (its status)
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [send]);

  const path = trail
    .map((p, i) => {
      const q = cam.worldToScreen(p);
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    })
    .join(' ');

  const colour = (it: PluginToolDrawItem): string | undefined => {
    const [r = 0, g = 0, b = 0, a = 0] = it.rgba;
    if (r === 0 && g === 0 && b === 0 && a === 0) return undefined;  // the editor's accent (CSS)
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-plugin-tool={tool.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onPointerCancel={() => {
        stroke.current = null;
        setTrail([]);
      }}
    >
      <svg className={styles.svg}>
        {path && <path className={styles.trail} d={path} />}
        {items.map((it, i) => {
          const c = colour(it);
          if (it.kind === 1 && it.xy.length >= 3) {
            const q = cam.worldToScreen({ x: it.xy[0]!, y: it.xy[1]! });
            return <circle key={i} className={styles.item} cx={q.x} cy={q.y} r={it.xy[2]! * cam.zoom} strokeWidth={it.width} style={c ? { stroke: c } : undefined} />;
          }
          if (it.kind === 2 && it.xy.length >= 2) {
            const q = cam.worldToScreen({ x: it.xy[0]!, y: it.xy[1]! });
            return <circle key={i} className={styles.dot} cx={q.x} cy={q.y} r={it.width / 2} style={c ? { fill: c } : undefined} />;
          }
          const pts: string[] = [];
          for (let k = 0; k + 1 < it.xy.length; k += 2) {
            const q = cam.worldToScreen({ x: it.xy[k]!, y: it.xy[k + 1]! });
            pts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
          }
          return <polyline key={i} className={styles.item} points={pts.join(' ')} strokeWidth={it.width} style={c ? { stroke: c } : undefined} />;
        })}
      </svg>
      {status ? <div className={styles.status}>{status}</div> : null}
    </div>
  );
}
