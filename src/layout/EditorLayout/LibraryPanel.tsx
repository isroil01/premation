/**
 * LibraryPanel — one left-rail tab holding every insertable library.
 *
 * Seven sections, one tab: Motion GFX, Transitions, Sound FX, Lottie UI,
 * Components, Shapes and Text. They were seven ideas for the same gesture —
 * pick a thing, drop it in the composition — and as seven tabs they filled the
 * rail with surfaces most users opened once.
 *
 * Every card here PLAYS OR DRAWS ITS OWN CONTENT rather than illustrating it:
 * the mograph cards run the same build and choreography the insert writes, the
 * transition cards replay the real keyframe recipe against an isolated engine,
 * the SFX bars are the synthesized clip's actual peak envelope, and the Lottie
 * cards render the document `applyImportPlan` will realise. A hand-drawn
 * impression of an item can keep looking right long after the item stopped
 * behaving that way; a card driven by the real thing cannot.
 *
 * `ComponentsPanel`, `ShapesPanel` and `TextPanel` are exported as components
 * but are NOT registered panels — they render as sections inside this one.
 */

import { useMemo, useState, useRef, useEffect } from 'react';
import { Panel } from '@components/Panel';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { EmptyState } from '@components/EmptyState';
import { Icon, type IconName } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { useComponentStore } from '@stores/componentStore';
import { useUIStore } from '@stores/uiStore';
import { getEventBus } from '@core/events/EventBus';
import { insertShape, insertText } from '@core/scene/sceneInsert';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { componentThumb, onComponentThumbReady } from '@core/rendering/componentThumbs';
import { MOGRAPH_ITEMS, insertMographItem, createMographPlayer, mographDuration, type MographItem, type MographCategory } from '@core/library/mographLibrary';
import { TRANSITION_ITEMS, applyTransitionItem, createTransitionPlayer, type TransitionItem, type TransitionCategory } from '@core/library/transitionLibrary';
import { SFX_ITEMS, insertSfxItem, sfxWaveform, type SfxItem, type SfxCategory } from '@core/library/sfxLibrary';
import { LOTTIE_ITEMS, insertLottieItem, importLottieFile, type LottieCategory } from '@core/library/lottieLibrary';
import { prepareLottiePreview, drawLottiePreview } from '@core/library/lottiePreview';
import { reportLottieImport, reportLottieImportFailure } from '@core/lottie/lottieImportReport';
import type { LottieJson } from '@core/lottie/lottieImport';
import { LibraryBrowser, FavoriteStar } from './LibraryBrowser';
import styles from './panels.module.css';

const SHAPE_PRESETS = [
  { id: 'rect',     label: 'Rectangle', svg: <rect x="4" y="4" width="24" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'rect' },
  { id: 'ellipse',  label: 'Ellipse',   svg: <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'ellipse' },
  { id: 'line',     label: 'Line',      svg: <line x1="4" y1="28" x2="28" y2="4" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'line' },
  { id: 'triangle', label: 'Triangle',  svg: <polygon points="16,4 28,26 4,26" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'triangle' },
  { id: 'arrow',    label: 'Arrow',     svg: <polygon points="16,4 28,16 20,16 20,28 12,28 12,16 4,16" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'arrow' },
  { id: 'heart',    label: 'Heart',     svg: <path d="M16,6.5 C16,6.5 12,2 6,2 C1,2 -2,7 2,14 C6,20 16,28 16,28 C16,28 26,20 30,14 C34,7 31,2 26,2 C20,2 16,6.5 16,6.5 Z" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'heart' },
  { id: 'cross',    label: 'Cross',     svg: <polygon points="12,4 20,4 20,12 28,12 28,20 20,20 20,28 12,28 12,20 4,20 4,12 12,12" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'cross' },
  { id: 'diamond',  label: 'Diamond',   svg: <polygon points="16,2 30,16 16,30 2,16" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'diamond' },
  { id: 'crescent', label: 'Crescent',  svg: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="none" stroke="currentColor" strokeWidth="2" transform="scale(1.1) translate(1, 1)" />, primitive: 'crescent' },
  { id: 'star',     label: 'Star',      svg: <polygon points="16,2 20,11 30,12 22,19 24,29 16,24 8,29 10,19 2,12 12,11" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'star' },
  { id: 'polygon',  label: 'Polygon',   svg: <polygon points="16,3 28,10 28,24 16,31 4,24 4,10" fill="none" stroke="currentColor" strokeWidth="2" />, primitive: 'polygon' },
] as const;

const TEXT_PRESETS = [
  { id: 'title',        label: 'Title',             fontSize: 72,  weight: 700 },
  { id: 'subtitle',     label: 'Subtitle',          fontSize: 48,  weight: 600 },
  { id: 'body',         label: 'Body',              fontSize: 36,  weight: 400 },
  { id: 'caption',      label: 'Caption',           fontSize: 24,  weight: 400 },
  { id: 'neon',         label: 'Neon Glow',         fontSize: 48,  weight: 700,  extra: { fill: '#38bdf8' } },
  { id: 'display',      label: 'Poster Headline',   fontSize: 84,  weight: 900,  extra: { letterSpacing: -2 } },
  { id: 'tag',          label: 'Uppercase Tag',     fontSize: 14,  weight: 700,  extra: { letterSpacing: 4, fill: '#f59e0b' } },
  { id: 'quote',        label: 'Quote',             fontSize: 32,  weight: 300,  extra: { fontStyle: 'italic', fill: '#94a3b8' } },
  { id: 'cyberpunk',    label: 'Cyber Accent',      fontSize: 20,  weight: 800,  extra: { fill: '#f43f5e', letterSpacing: 2 } },
  { id: 'mono',         label: 'Code Monospace',    fontSize: 28,  weight: 500,  extra: { fontFamily: 'monospace', fill: '#10b981' } },
] as const;

export function ComponentsPanel(): JSX.Element {
  const savedComponents = useComponentStore((s) => s.components);
  const saveComponent = useComponentStore((s) => s.saveFromSelection);
  const insertComponent = useComponentStore((s) => s.insert);
  const removeComponent = useComponentStore((s) => s.remove);
  const hasSelection = useSelectionStore((s) => s.ids.length > 0);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [componentName, setComponentName] = useState('My Component');
  // Thumbnails render async on the GPU engine — repaint the grid as each lands.
  const [, setThumbTick] = useState(0);
  useEffect(() => onComponentThumbReady(() => setThumbTick((t) => t + 1)), []);

  const handleSave = () => {
    if (!componentName.trim()) return;
    const id = saveComponent(componentName);
    useUIStore.getState().notify(
      id
        ? { level: 'success', message: `Saved “${componentName}”`, durationMs: 1800 }
        : { level: 'warning', message: 'Select layer(s) to save first', durationMs: 2000 },
    );
    setShowSaveInput(false);
    setComponentName('My Component');
  };

  return (
    <Panel
      id="components"
      title="Components"
      icon="box"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'components' })}
    >
      <div className={styles.libBody}>
        <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!showSaveInput ? (
            <button
              type="button"
              className={styles.libChip}
              style={{ flexDirection: 'row', gap: 8, justifyContent: 'center', opacity: hasSelection ? 1 : 0.5, cursor: hasSelection ? 'pointer' : 'not-allowed' }}
              disabled={!hasSelection}
              title={hasSelection ? 'Save the current selection as a reusable component' : 'Select layer(s) first'}
              onClick={() => setShowSaveInput(true)}
            >
              <Icon name="plus" size="md" /> Save selection as component
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={componentName}
                onChange={(e) => setComponentName(e.currentTarget.value)}
                autoFocus
                size="sm"
                fullWidth
                placeholder="Component name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setShowSaveInput(false);
                }}
              />
              <button
                type="button"
                className={styles.libChip}
                style={{ padding: '0 8px', minHeight: 'unset', width: 'auto', flexShrink: 0 }}
                onClick={handleSave}
              >
                Save
              </button>
            </div>
          )}
          {savedComponents.length === 0 ? (
            <EmptyState
              compact
              icon="component"
              message="No components yet. Select a layer or group and save it to reuse anywhere."
            />
          ) : (
            <div className={styles.libGrid}>
              {savedComponents.map((c) => (
                <div key={c.id} style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className={styles.libChip}
                    title={`Insert a copy of “${c.name}” — or drag onto the canvas`}
                    draggable
                    onDragStart={(e) => setCanvasDrag(e, { kind: 'component', componentId: c.id })}
                    onClick={() => { insertComponent(c.id); useUIStore.getState().notify({ level: 'success', message: `Inserted ${c.name}`, durationMs: 1500 }); }}
                  >
                    {(() => {
                      const thumb = componentThumb(c);
                      return thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          width={48}
                          height={32}
                          style={{ objectFit: 'contain', borderRadius: 4, background: 'var(--color-surface-0)' }}
                        />
                      ) : (
                        <Icon name="component" size="lg" />
                      );
                    })()}
                    <span className={styles.libChipLabel}>{c.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    title="Delete component"
                    onClick={() => removeComponent(c.id)}
                    style={{ position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-surface-0)', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 'var(--font-size-xs)', lineHeight: 1 }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function ShapesPanel(): JSX.Element {
  const handleShapeInsert = (preset: typeof SHAPE_PRESETS[number]) => {
    insertShape(preset.primitive, preset.label);
  };

  return (
    <Panel
      id="shapes"
      title="Shapes"
      icon="shape"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'shapes' })}
    >
      <div className={styles.libBody}>
        <div className={styles.libGrid}>
          {SHAPE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.libChip}
              title={`Insert ${p.label} — or drag onto the canvas`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'shape', primitive: p.primitive, label: p.label })}
              onClick={() => handleShapeInsert(p)}
            >
              <svg width="32" height="32" viewBox="0 0 32 32" style={{ color: '#bbb' }}>
                {p.svg}
              </svg>
              <span className={styles.libChipLabel}>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function TextPanel(): JSX.Element {
  const handleTextInsert = (preset: typeof TEXT_PRESETS[number]) => {
    insertText(preset.label, preset.fontSize, preset.weight, (preset as any).extra ?? {});
  };

  return (
    <Panel
      id="text"
      title="Text"
      icon="type"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'text' })}
    >
      <div className={styles.libBody}>
        <div className={styles.libList}>
          {TEXT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.libTextItem}
              title={`Insert ${p.label} text layer — or drag onto the canvas`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'text', label: p.label, fontSize: p.fontSize, weight: p.weight, extra: (p as any).extra ?? {} })}
              onClick={() => handleTextInsert(p)}
            >
              <span
                style={{
                  fontSize: Math.min(p.fontSize / 3, 20),
                  fontWeight: p.weight,
                  fontStyle: (p as any).extra?.fontStyle,
                  color: (p as any).extra?.fill || 'inherit',
                  fontFamily: (p as any).extra?.fontFamily || 'inherit',
                  letterSpacing: (p as any).extra?.letterSpacing ? `${(p as any).extra.letterSpacing}px` : 'normal',
                  textTransform: (p as any).extra?.transform || 'none',
                }}
              >
                {p.label}
              </span>
              <span className={styles.libTextMeta}>
                {p.fontSize}px · w{p.weight}
                {(p as any).extra?.fill && ' · styled'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}


// ── Motion Graphics Panel ─────────────────────────────────────────
// Real programmatic mograph elements — the card previews PLAY the same
// build + choreography the insert writes (shared gallery ticker).

function MographCard({ item }: { item: MographItem }): JSX.Element {
  const notify = useUIStore((s) => s.notify);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const player = createMographPlayer(canvas, item);
    return () => player.stop();
  }, [item]);
  return (
    <button
      type="button"
      className={styles.libMotionItem}
      title={`${item.name} — Drag onto canvas or click to insert`}
      draggable
      onDragStart={(e) => setCanvasDrag(e, { kind: 'mograph', mographId: item.id, name: item.name })}
      onClick={() => {
        const id = insertMographItem(item.id);
        if (id) notify({ level: 'success', message: `Inserted motion graphic: ${item.name}`, durationMs: 1500 });
        else notify({ level: 'warning', message: `Could not insert ${item.name}`, durationMs: 2000 });
      }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          width={224}
          height={126}
          style={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 6, background: '#101016', display: 'block' }}
        />
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 3, height: 22, borderRadius: 2, background: item.color, flexShrink: 0 }} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>
            <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-family-mono)' }}>
              {item.cat} · {item.loop ? '∞ loop' : `${mographDuration(item).toFixed(1)}s`}
            </span>
          </span>
          <FavoriteStar id={item.id} label={item.name} />
        </span>
      </span>
    </button>
  );
}

const MOGRAPH_CATEGORIES: readonly MographCategory[] =
  ['lower-thirds', 'callouts', 'titles', 'data', 'shapes', 'loops'];

function MotionGFXContent(): JSX.Element {
  return (
    <LibraryBrowser
      items={MOGRAPH_ITEMS}
      categories={MOGRAPH_CATEGORIES}
      categoryLabel={(c) => (c === 'lower-thirds' ? 'Lower 3rds' : c.charAt(0).toUpperCase() + c.slice(1))}
      noun="preset"
    >
      {(items) => (
        <div className={styles.libList}>
          {items.map((item) => (
            <MographCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </LibraryBrowser>
  );
}

// ── Transitions Panel ─────────────────────────────────────────────
// Real keyframe recipes: with a selection the recipe is keyframed onto the
// selected layers at the playhead; otherwise a choreographed solid covers
// the cut. Every write goes through the normal animation engine (undoable).

/** A transition card that PLAYS ITS OWN RECIPE.
 *
 *  The card used to be two colour swatches, which made "Whip Pan" and "Cross
 *  Fade" visually identical — you had to apply an item and undo it to find out
 *  what it did. This replays the real recipe against an isolated engine, so the
 *  card shows the move it will write. */
function TransitionCard({ item, onApply }: { item: TransitionItem; onApply: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const player = createTransitionPlayer(canvas, item);
    return () => player.stop();
  }, [item]);

  return (
    <button
      type="button"
      className={styles.libMotionItem}
      title={item.solidOnly
        ? `${item.name} — inserts a choreographed solid at the playhead`
        : `${item.name} — applies to the selected layers (or inserts a solid)`}
      draggable
      onDragStart={(e) => setCanvasDrag(e, { kind: 'transition', transId: item.id, name: item.name })}
      onClick={onApply}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          width={320}
          height={180}
          style={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 6, background: '#101016', display: 'block' }}
        />
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 3, height: 22, borderRadius: 2, background: item.a, flexShrink: 0 }} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{item.name}</span>
            <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-family-mono)' }}>
              {item.cat} · {item.duration.toFixed(1)}s{item.solidOnly ? ' · solid' : ''}
            </span>
          </span>
          <FavoriteStar id={item.id} label={item.name} />
        </span>
      </span>
    </button>
  );
}

const TRANSITION_CATEGORIES: readonly TransitionCategory[] =
  ['fade', 'slide', 'zoom', 'whip', 'glitch', 'wipe'];

function TransitionsContent(): JSX.Element {
  const notify = useUIStore((s) => s.notify);
  const apply = (id: string, name: string): void => {
    const result = applyTransitionItem(id);
    if (!result) {
      notify({ level: 'warning', message: `Could not apply ${name}`, durationMs: 2000 });
    } else if (result.mode === 'layer') {
      const n = result.nodeIds.length;
      const kinds = new Set(result.phases ?? []);
      const variant = kinds.size === 1 ? ` (${kinds.has('exit') ? 'exit' : 'entrance'})` : kinds.size > 1 ? ' (entrance + exit)' : '';
      notify({ level: 'success', message: `Keyframed ${name}${variant} onto ${n} layer${n > 1 ? 's' : ''}`, durationMs: 1800 });
    } else {
      const n = result.nodeIds.length;
      notify({ level: 'success', message: n > 1 ? `Inserted ${n} ${name} solids at the playhead` : `Inserted ${name} solid at the playhead`, durationMs: 1800 });
    }
  };
  return (
    <LibraryBrowser items={TRANSITION_ITEMS} categories={TRANSITION_CATEGORIES} noun="transition">
      {(items) => (
        <div className={styles.libList}>
          {items.map((item) => (
            <TransitionCard key={item.id} item={item} onApply={() => apply(item.id, item.name)} />
          ))}
        </div>
      )}
    </LibraryBrowser>
  );
}

// ── Sound FX Panel ────────────────────────────────────────────────
// Deterministic synthesized SFX — every item renders a real WAV through the
// normal asset pipeline and lands as a real audio layer at the playhead.

/** The item's REAL peak envelope, not a decorative bar pattern.
 *  Memoised per id: the synth is deterministic, so this is computed once and
 *  the same shape is reused for the life of the session. */
const waveformCache = new Map<string, number[]>();
function sfxBars(id: string): number[] {
  let bars = waveformCache.get(id);
  if (!bars) {
    bars = sfxWaveform(id, 26) ?? [];
    waveformCache.set(id, bars);
  }
  return bars;
}

function SfxCard({ item, busy, onInsert }: { item: SfxItem; busy: string | null; onInsert: () => void }): JSX.Element {
  const bars = sfxBars(item.id);
  return (
    <button
      type="button"
      className={styles.libMotionItem}
      disabled={busy !== null}
      style={busy === item.id ? { opacity: 0.6 } : undefined}
      title={`${item.name} — synthesized ${item.duration.toFixed(2)}s WAV, added as an audio layer`}
      draggable
      onDragStart={(e) => setCanvasDrag(e, { kind: 'sfx', sfxId: item.id, name: item.name })}
      onClick={onInsert}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        {/* The envelope of the actual audio — a click reads as a spike, an
            ambient pad as a slow swell. Every item used to draw the same
            seven bars. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 1, height: 26, width: 72, flexShrink: 0 }} aria-hidden>
          {bars.map((v, i) => (
            <span key={i} style={{
              flex: 1,
              height: `${Math.max(8, v * 100)}%`,
              borderRadius: 1,
              background: item.color,
              opacity: 0.45 + v * 0.55,
              display: 'block',
            }} />
          ))}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{busy === item.id ? 'Rendering…' : item.name}</span>
          <span style={{ fontSize: '0.68rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-family-mono)' }}>
            {item.cat} · {item.duration.toFixed(2)}s
          </span>
        </span>
        <FavoriteStar id={item.id} label={item.name} />
      </span>
    </button>
  );
}

const SFX_CATEGORIES: readonly SfxCategory[] = ['click', 'whoosh', 'impact', 'ambient'];

function SoundFXContent(): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const notify = useUIStore((s) => s.notify);
  const insert = async (id: string, name: string): Promise<void> => {
    if (busy) return;
    setBusy(id);
    try {
      const nodeId = await insertSfxItem(id);
      if (nodeId) notify({ level: 'success', message: `Added Sound FX: ${name}`, durationMs: 1500 });
      else notify({ level: 'warning', message: `Could not add ${name}`, durationMs: 2000 });
    } finally {
      setBusy(null);
    }
  };
  return (
    <LibraryBrowser items={SFX_ITEMS} categories={SFX_CATEGORIES} noun="sound">
      {(items) => (
        <div className={styles.libList}>
          {items.map((item) => (
            <SfxCard key={item.id} item={item} busy={busy}
              onInsert={() => { void insert(item.id, item.name); }} />
          ))}
        </div>
      )}
    </LibraryBrowser>
  );
}

// ── Lottie Micro UI Panel ─────────────────────────────────────────
// Advanced Apple-style UI micro-interactions (Pill Stepper, Dynamic Island, Fluid Switch, Face ID, etc.)

/**
 * A library card that PLAYS ITS OWN DOCUMENT.
 *
 * Each card used to be a hand-drawn SVG impression of its item, with nothing
 * tying it to the Lottie document the card actually inserts — so a card could
 * keep looking right long after the document stopped landing that way. This
 * draws the same plan applyImportPlan realises, which is why inserting an item
 * now reproduces its card.
 *
 * Still by default (one frame is the honest contract for "what you get"), and
 * it plays while hovered so the motion is still visible before you commit.
 */
function LottieCardPreview({ doc, playing }: { doc: LottieJson; playing: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Planning is pure and cheap, but it is per-document work — do it once.
  const scene = useMemo(() => prepareLottiePreview(doc), [doc]);
  const restT = scene.restSec;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 44;
    const h = canvas.clientHeight || 30;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Resizing the canvas above CLEARS it, so paint before yielding: an rAF
    // that never arrives (hidden pane, background window) would otherwise leave
    // the card blank for as long as the throttle lasts.
    drawLottiePreview(ctx, scene, playing ? 0 : restT, w, h);
    if (!playing) return;

    let raf = 0;
    const started = performance.now();
    const tick = (): void => {
      const elapsed = (performance.now() - started) / 1000;
      drawLottiePreview(ctx, scene, scene.durationSec > 0 ? elapsed % scene.durationSec : 0, w, h);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene, playing, restT]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}

const LOTTIE_CATEGORIES: readonly LottieCategory[] = ['micro-ui', 'widgets', 'controls'];

function LottieContent(): JSX.Element {
  const notify = useUIStore((s) => s.notify);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      reportLottieImport(file.name, await importLottieFile(file));
    } catch (err) {
      reportLottieImportFailure(file.name, err);
    }
  };

  const importButton = (
    <div style={{ padding: '6px 8px 2px' }}>
      <Button size="sm" variant="secondary" style={{ width: '100%', fontWeight: 600 }}
        leftIcon={<Icon name="download" size="sm" />}
        onClick={() => fileRef.current?.click()}>
        Import .json / .lottie File…
      </Button>
      <input ref={fileRef} type="file" accept=".json,.lottie,application/json,application/x-lottie" style={{ display: 'none' }}
        onChange={(e) => { void onPickFile(e); }} />
    </div>
  );

  return (
    <LibraryBrowser
      items={LOTTIE_ITEMS}
      categories={LOTTIE_CATEGORIES}
      categoryLabel={(c) => (c === 'micro-ui' ? 'Micro UI' : c.charAt(0).toUpperCase() + c.slice(1))}
      noun="animation"
      toolbar={importButton}
    >
      {(items) => (
        <div className={styles.libGrid}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.libChip}
              title={`${item.name} — ${item.frames}f @ 30fps. Hover to play, drag onto canvas or click to insert`}
              draggable
              onDragStart={(e) => setCanvasDrag(e, { kind: 'lottie', lottieId: item.id, name: item.name })}
              onMouseEnter={() => setHovered(item.id)}
              onMouseLeave={() => setHovered((h) => (h === item.id ? null : h))}
              onClick={() => {
                const ids = insertLottieItem(item.id);
                if (ids.length > 0) notify({ level: 'success', message: `Inserted ${item.name} (${ids.length} layer${ids.length > 1 ? 's' : ''})`, durationMs: 1800 });
                else notify({ level: 'warning', message: `Could not insert ${item.name}`, durationMs: 2000 });
              }}>
              <span className={styles.libChipThumb}
                style={{ background: `radial-gradient(circle at 50% 45%, ${item.color}22 0%, transparent 70%), #09090b`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <LottieCardPreview doc={item.doc} playing={hovered === item.id} />
                <span style={{ position: 'absolute', bottom: 2, right: 3, fontSize: '0.52rem', fontWeight: 800,
                  color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em' }}>LOTTIE</span>
                <span className={styles.libChipStar}>
                  <FavoriteStar id={item.id} label={item.name} />
                </span>
              </span>
              <span className={styles.libChipLabel}>{item.name}</span>
            </button>
          ))}
        </div>
      )}
    </LibraryBrowser>
  );
}

// ── Library Panel — ONE home for asset libraries ──────────────────
// Motion GFX / Transitions / Sound FX / Lottie live as sections inside a single sidebar tab.

type LibrarySection = 'mograph' | 'transitions' | 'sfx' | 'lottie' | 'components' | 'shapes' | 'text';

const LIBRARY_SECTIONS: ReadonlyArray<{ id: LibrarySection; label: string; icon: IconName }> = [
  { id: 'mograph',     label: 'Motion GFX',  icon: 'sparkles' },
  { id: 'transitions', label: 'Transitions', icon: 'scissors' },
  { id: 'sfx',         label: 'Sound FX',    icon: 'voice' },
  { id: 'lottie',      label: 'Lottie UI',   icon: 'video' },
  { id: 'components',  label: 'Components',  icon: 'component' },
  { id: 'shapes',      label: 'Shapes',      icon: 'shape' },
  { id: 'text',        label: 'Text',        icon: 'type' },
];

export function LibraryPanel(): JSX.Element {
  const [section, setSection] = useState<LibrarySection>('mograph');
  return (
    <Panel id="library" title="Library" icon="sparkles" hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'library' })}>
      {/* The bottom rule lives in `.libTabs`. The inline copy that was here
          drew a SECOND hairline under the stylesheet's, and carried a
          `var(--color-border, rgba(255,255,255,0.08))` fallback for a token
          that has always been defined — a white-ish line hardcoded for dark. */}
      <div className={styles.libTabs} role="tablist">
        {LIBRARY_SECTIONS.map((s) => (
          <button key={s.id} type="button"
            role="tab"
            aria-selected={section === s.id}
            // Was `libTab` PLUS `libTabActive`, but `libTabActive` already
            // `composes: libTab` — so the base class landed twice.
            className={section === s.id ? styles.libTabActive : styles.libTab}
            title={s.label}
            onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size="sm" />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      {section === 'mograph' && <MotionGFXContent />}
      {section === 'transitions' && <TransitionsContent />}
      {section === 'sfx' && <SoundFXContent />}
      {section === 'lottie' && <LottieContent />}
      {section === 'components' && <ComponentsPanel />}
      {section === 'shapes' && <ShapesPanel />}
      {section === 'text' && <TextPanel />}
    </Panel>
  );
}
