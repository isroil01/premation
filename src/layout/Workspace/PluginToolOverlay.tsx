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
 * The plugin decides what a stroke means (the `scatter` sample stamps layers
 * along it); nothing here knows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

export function PluginToolOverlay(): JSX.Element | null {
  const active = useUIStore((s) => s.activeTool === 'plugin-tool' && s.pluginTool !== null);
  return active ? <PluginToolOverlayActive /> : null;
}

function PluginToolOverlayActive(): JSX.Element {
  const tool = useUIStore((s) => s.pluginTool)!;
  const cam = useDisplayedCamera2D();
  const rootRef = useRef<HTMLDivElement>(null);
  const stroke = useRef<Pt[] | null>(null);
  const [trail, setTrail] = useState<Pt[]>([]);

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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    stroke.current = [];
    add(toComp(e));
    setTrail([...stroke.current]);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!stroke.current) return;
    // Every coalesced sample: a fast drag keeps its curve.
    const samples = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    for (const s of samples.length > 0 ? samples : [e.nativeEvent]) add(toComp(s));
    setTrail([...stroke.current]);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const points = stroke.current;
    stroke.current = null;
    setTrail([]);
    if (!points || points.length === 0) return;
    const s = useProjectStore.getState();
    const comp = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
    void runPluginCommand(engine(), tool.plugin, tool.command, {
      ...(comp ? { comp } : {}),
      layers: [...useSelectionStore.getState().ids],
      args: { tool: tool.tool, stroke: points.map((p) => [p.x, p.y]), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey },
    }).then((res) => {
      if (!res.ok) useUIStore.getState().notify({ level: 'error', message: `${tool.name}: ${res.error}`, durationMs: 6000 });
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !stroke.current) return;
      stroke.current = null;
      setTrail([]);
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  const path = trail
    .map((p, i) => {
      const q = cam.worldToScreen(p);
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-plugin-tool={tool.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        stroke.current = null;
        setTrail([]);
      }}
    >
      <svg className={styles.svg}>{path && <path className={styles.trail} d={path} />}</svg>
    </div>
  );
}
