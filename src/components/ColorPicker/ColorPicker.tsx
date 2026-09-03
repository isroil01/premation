/**
 * ColorPicker — an inset swatch field that opens a real color picker popover
 * (react-colorful for the saturation/hue/alpha surface, Radix Popover for the
 * accessible, portalled, dismissable overlay). Styled entirely with our tokens
 * so it matches the dark pro chrome.
 *
 * Pro-grade surface: alpha slider (8-digit hex round-trips through the render
 * pipeline), eyedropper (Chromium's EyeDropper API — always available in the
 * Electron shell), numeric R/G/B/A fields, and recent-color swatches persisted
 * across sessions. One component — every color control in the app gets this.
 *
 * ── Three strips, three different promises ──────────────────────────────────
 *
 *   Swatches  the PROJECT palette — named, ordered, saved in the .motion file.
 *             Curated by the user; shared by every picker in the app.
 *   Document  every color the scene currently paints with. Derived, never
 *             stored, recomputed when this popover OPENS (walking every node's
 *             paint stack is cheap once and unaffordable per frame).
 *   Recent    what you touched last, on this machine. localStorage, per-user,
 *             deliberately not in the document — recents change on every drag,
 *             and a file that dirtied itself for that would be unusable.
 *
 * They are separate because they answer different questions ("what is our
 * brand red", "what is already in this comp", "what did I just use"). Merging
 * them into one strip was the tempting simplification and it destroys all
 * three answers at once.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { HexColorPicker, HexAlphaColorPicker, HexColorInput } from 'react-colorful';
import { cn } from '@utils/cn';
import { useSwatchStore } from '@stores/swatchStore';
import styles from './ColorPicker.module.css';

export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  className?: string;
  'aria-label'?: string;
  compact?: boolean;
  /** Allow an alpha channel (8-digit hex). On by default. */
  alpha?: boolean;
}

const RECENT_KEY = 'motion-editor.recentColors.v1';
const RECENT_MAX = 10;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((c): c is string => typeof c === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(color: string): string[] {
  const next = [color, ...readRecent().filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — recents are a convenience, not state */
  }
  return next;
}

/** #rgb/#rrggbb/#rrggbbaa → channels (0-255, alpha 0-1). */
function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const a = h.length >= 8 ? (parseInt(h.slice(6, 8), 16) || 0) / 255 : 1;
  return { r, g, b, a };
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const base = `#${c(r)}${c(g)}${c(b)}`;
  return a >= 1 ? base : `${base}${c(a * 255)}`;
}

/** A numeric channel field (R/G/B 0-255, A 0-100%). */
function ChannelField({
  label,
  value,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  onCommit: (v: number) => void;
}): JSX.Element {
  // Local text state so partially-typed numbers don't snap back mid-edit.
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onCommit(Math.max(0, Math.min(max, n)));
    else setText(String(value));
  };
  return (
    <label className={styles.channel}>
      <input
        className={styles.channelInput}
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        aria-label={`${label} channel`}
      />
      <span className={styles.channelLabel}>{label}</span>
    </label>
  );
}

export function ColorPicker({
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
  compact = false,
  alpha = true,
}: ColorPickerProps): JSX.Element {
  const color = value && /^#[0-9a-fA-F]{3,8}$/.test(value)
    ? value
    : value && /^[0-9a-fA-F]{3,8}$/.test(value)
      ? `#${value}`
      : '#5282b8';
  const [recent, setRecent] = useState<string[]>(readRecent);
  const rgba = useMemo(() => hexToRgba(color), [color]);

  const swatches = useSwatchStore((s) => s.swatches);
  const documentColors = useSwatchStore((s) => s.documentColors);
  const addSwatch = useSwatchStore((s) => s.addSwatch);
  const renameSwatch = useSwatchStore((s) => s.renameSwatch);
  const removeSwatch = useSwatchStore((s) => s.removeSwatch);
  const refreshDocumentColors = useSwatchStore((s) => s.refreshDocumentColors);

  /** Which project swatch has its rename/delete row open, if any. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const editing = swatches.find((s) => s.id === editingId) ?? null;
  // The row closes itself if its swatch is deleted from another surface (the
  // Swatches panel), rather than editing a swatch that is no longer there.
  useEffect(() => {
    if (editingId && !editing) setEditingId(null);
  }, [editingId, editing]);

  const openEditor = useCallback((id: string, name: string) => {
    setEditingId(id);
    setDraftName(name);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId) renameSwatch(editingId, draftName);
    setEditingId(null);
  }, [editingId, draftName, renameSwatch]);

  const setChannel = useCallback(
    (ch: 'r' | 'g' | 'b' | 'a', v: number) => {
      const next = { ...rgba, [ch]: ch === 'a' ? v / 100 : v };
      onChange(rgbaToHex(next.r, next.g, next.b, next.a));
    },
    [rgba, onChange],
  );

  const eyedrop = useCallback(async () => {
    type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
    const Ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!Ctor) return;
    try {
      const { sRGBHex } = await new Ctor().open();
      onChange(sRGBHex);
    } catch {
      /* user pressed Escape — not an error */
    }
  }, [onChange]);

  const hasEyeDropper = typeof (window as unknown as { EyeDropper?: unknown }).EyeDropper === 'function';
  const Surface = alpha ? HexAlphaColorPicker : HexColorPicker;

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) {
          // The one place the document strip is derived. Walking every node's
          // fill and stroke stack costs nothing once per open and would be
          // indefensible as a subscription that fires on every scene bump.
          refreshDocumentColors();
        } else {
          // Record on close so a saturation drag doesn't flood the recents.
          if (color) setRecent(pushRecent(color));
          setEditingId(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={cn(compact ? styles.compactTrigger : styles.trigger, className)} aria-label={ariaLabel ?? 'Pick a color'}>
          <span className={cn(styles.swatch, compact && styles.compactSwatch)} style={{ background: color }} />
          {!compact && <span className={styles.hex}>{color.toUpperCase()}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.content} sideOffset={6} align="start" collisionPadding={12}>
          <div className={styles.picker}>
            <Surface color={color} onChange={onChange} />

            <div className={styles.inputsRow}>
              {hasEyeDropper && (
                <button type="button" className={styles.eyedropBtn} onClick={eyedrop} title="Pick a color from the screen" aria-label="Eyedropper">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M10.3 1.9a2.1 2.1 0 0 1 3 3l-1.2 1.2.7.7a.75.75 0 1 1-1.06 1.06l-.35-.35-5.6 5.6c-.2.2-.45.33-.72.4l-2.02.5a.6.6 0 0 1-.73-.73l.5-2.02c.07-.27.2-.52.4-.72l5.6-5.6-.35-.35A.75.75 0 0 1 9.53 3.5l.7.7 1.2-1.2Zm-1.72 3.98-5.5 5.5-.3 1.2 1.2-.3 5.5-5.5-.9-.9Z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              )}
              <div className={styles.hexRow}>
                <span className={styles.hexHash}>#</span>
                <HexColorInput color={color} onChange={onChange} prefixed={false} alpha={alpha} className={styles.hexInput} aria-label="Hex value" />
              </div>
            </div>

            <div className={styles.channels}>
              <ChannelField label="R" value={rgba.r} max={255} onCommit={(v) => setChannel('r', v)} />
              <ChannelField label="G" value={rgba.g} max={255} onCommit={(v) => setChannel('g', v)} />
              <ChannelField label="B" value={rgba.b} max={255} onCommit={(v) => setChannel('b', v)} />
              {alpha && <ChannelField label="A%" value={Math.round(rgba.a * 100)} max={100} onCommit={(v) => setChannel('a', v)} />}
            </div>

            {/* ── Project palette ────────────────────────────────────── */}
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>Swatches</span>
                <button
                  type="button"
                  className={styles.sectionAdd}
                  onClick={() => {
                    const added = addSwatch(color);
                    if (added) openEditor(added.id, added.name);
                  }}
                  title="Save this color to the project palette"
                  aria-label="Add current color to project swatches"
                >
                  +
                </button>
              </div>
              {swatches.length > 0 ? (
                <div className={styles.recents} role="listbox" aria-label="Project swatches">
                  {swatches.map((sw) => (
                    <button
                      key={sw.id}
                      type="button"
                      className={cn(styles.recentSwatch, sw.id === editingId && styles.recentSwatchActive)}
                      style={{ background: sw.hex }}
                      title={`${sw.name} — ${sw.hex.toUpperCase()} (right-click to rename or delete)`}
                      aria-label={`Use ${sw.name}`}
                      onClick={() => onChange(sw.hex)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openEditor(sw.id, sw.name);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p className={styles.sectionEmpty}>No project swatches yet — + saves this color.</p>
              )}
              {editing && (
                <div className={styles.editRow}>
                  <span className={styles.editSwatch} style={{ background: editing.hex }} aria-hidden />
                  <input
                    className={styles.editInput}
                    value={draftName}
                    autoFocus
                    aria-label="Swatch name"
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                  <button
                    type="button"
                    className={styles.editDelete}
                    title="Delete this swatch"
                    aria-label={`Delete ${editing.name}`}
                    // `onMouseDown`, not `onClick`: the input's blur commits a
                    // rename and re-renders this row away before a click on a
                    // sibling ever lands.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      removeSwatch(editing.id);
                      setEditingId(null);
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* ── Colors already in this document ────────────────────── */}
            {documentColors.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>Document</span>
                </div>
                <div className={styles.recents} role="listbox" aria-label="Document colors">
                  {documentColors.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={styles.recentSwatch}
                      style={{ background: c }}
                      title={c.toUpperCase()}
                      aria-label={`Use ${c}`}
                      onClick={() => onChange(c)}
                    />
                  ))}
                </div>
              </div>
            )}

            {recent.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>Recent</span>
                </div>
                <div className={styles.recents} role="listbox" aria-label="Recent colors">
                  {recent.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={styles.recentSwatch}
                      style={{ background: c }}
                      title={c.toUpperCase()}
                      aria-label={`Use ${c}`}
                      onClick={() => onChange(c)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <Popover.Arrow className={styles.arrow} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default ColorPicker;
