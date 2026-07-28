/**
 * CommandPalette — the universal, mode-aware launcher (spec §Command Palette).
 *
 * Cmd/Ctrl+Shift+P opens it from anywhere (including while a field is focused).
 * Cmd/Ctrl+K belongs to Composition Settings, per AE. One
 * search box finds everything and switches mode by the first character:
 *   plain text → search all   ·   `>` commands   ·   `@` layers
 *   `#` compositions          ·   `:` timecode
 *
 * These prefixes match VS Code / Linear conventions the target users know.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@components/Icon';
import { cn } from '@utils/cn';
import { useCommandPaletteStore } from '@stores/commandPaletteStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { framesToTimecode, displayFramesToDomainSeconds } from '@core/time/timecode';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSceneRevision } from '@stores/sceneStore';
import { getCommandRegistry } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind, KIND_COLOR } from '@core/scene/sceneDerive';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { asCommandId } from '@app-types/common';
import { formatChord } from '@layout/Menu/formatChord';
import { resolveChord, getShortcutOverrides } from '@core/commands/shortcutOverrides';
import { parseQuery, fuzzyScore, parseTimecode } from './paletteSearch';
import styles from './CommandPalette.module.css';

/** Frames-per-second used to derive a frame number for timecode jumps. */
const FPS = 30;
const MAX_PER_GROUP = 8;

type Section = 'Commands' | 'Layers' | 'Compositions' | 'Go to time';

interface Item {
  key: string;
  section: Section;
  label: string;
  hint?: string;
  icon: IconName;
  color?: string;
  disabled?: boolean;
  run: () => void;
}

const KIND_ICON: Record<SceneKind, IconName> = {
  group: 'layers',
  null: 'crosshair',
  shape: 'shape',
  text: 'type',
  image: 'image',
  video: 'video',
  svg: 'shape',
  audio: 'audio',
  camera: 'camera',
  light: 'light',
  adjustment: 'adjustment',
  particle: 'sparkles',
  comp: 'component',
};

function buildItems(query: string, closePalette: () => void): Item[] {
  const { mode, term } = parseQuery(query);
  const items: Item[] = [];

  const wantCommands = mode === 'all' || mode === 'commands';
  const wantLayers = mode === 'all' || mode === 'layers';
  const wantComps = mode === 'all' || mode === 'compositions';
  const wantTime = mode === 'timecode' || (mode === 'all' && term !== '');

  // ── Commands ──────────────────────────────────────────────────────
  if (wantCommands) {
    const scored = getCommandRegistry()
      .all()
      .map((c) => ({ c, s: fuzzyScore(term, c.label) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, mode === 'commands' ? MAX_PER_GROUP * 3 : MAX_PER_GROUP);
    for (const { c } of scored) {
      const disabled = c.enabled ? !c.enabled() : false;
      items.push({
        key: `cmd:${c.id}`,
        section: 'Commands',
        label: c.label,
        hint: (() => {
          const resolvedChord = resolveChord(c.id as unknown as string, c.shortcut, getShortcutOverrides());
          return resolvedChord ? formatChord(resolvedChord) : undefined;
        })(),
        icon: (c.icon as IconName) ?? 'crosshair',
        disabled,
        run: () => {
          closePalette();
          void getCommandSystem().execute(asCommandId(c.id as unknown as string));
        },
      });
    }
  }

  // ── Layers + Compositions (from the scene graph) ──────────────────
  if (wantLayers || wantComps) {
    const graph = defaultSceneGraph;
    const rootIds = new Set(graph.getRoots().map((n) => n.id));
    const all = flattenScene(graph);

    if (wantComps) {
      const comps = graph
        .getRoots()
        .map((n) => ({ n, s: fuzzyScore(term, n.name ?? 'Composition') }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s);
      for (const { n } of comps) {
        items.push({
          key: `comp:${n.id}`,
          section: 'Compositions',
          label: n.name ?? 'Composition',
          icon: 'layers',
          run: () => {
            closePalette();
            useSelectionStore.getState().set([n.id]);
          },
        });
      }
    }

    if (wantLayers) {
      const layers = all
        .filter((n) => !rootIds.has(n.id))
        .map((n) => ({ n, s: fuzzyScore(term, n.name ?? '') }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, mode === 'layers' ? MAX_PER_GROUP * 3 : MAX_PER_GROUP);
      for (const { n } of layers) {
        const kind = readNodeKind(n);
        items.push({
          key: `layer:${n.id}`,
          section: 'Layers',
          label: n.name ?? 'Layer',
          hint: kind,
          icon: KIND_ICON[kind] ?? 'shape',
          color: KIND_COLOR[kind],
          run: () => {
            closePalette();
            useSelectionStore.getState().set([n.id]);
          },
        });
      }
    }
  }

  // ── Timecode ──────────────────────────────────────────────────────
  if (wantTime) {
    const displaySec = parseTimecode(term);
    if (displaySec !== null) {
      const comp = useCompositionStore.getState();
      const fps = comp.fps || FPS;
      // The user types the DISPLAYED timecode, which includes the comp's start
      // offset — subtract it to land on the real playhead time. (Keyframes and
      // playback are 0-based; only the label is shifted.)
      const sec = displayFramesToDomainSeconds(displaySec, fps, comp.startFrame ?? 0);
      items.push({
        key: 'time',
        section: 'Go to time',
        label: `Go to ${framesToTimecode(sec, fps, comp.startFrame ?? 0)}`,
        hint: `${sec.toFixed(3)}s`,
        icon: 'skip-forward',
        run: () => {
          closePalette();
          // Seek through the timeline, not straight into the store: a direct
          // setTime leaves the engine playhead where it was, so the next
          // play/step jumps back.
          getTimelineController().seekSeconds(sec);
        },
      });
    }
  }

  return items;
}

export function CommandPalette(): JSX.Element | null {
  const open = useCommandPaletteStore((s) => s.open);
  const initialQuery = useCommandPaletteStore((s) => s.initialQuery);
  const toggle = useCommandPaletteStore((s) => s.toggle);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Subscribe to scene changes so the layer/comp lists stay fresh.
  useSceneRevision((s) => s.rev);

  // Global Cmd/Ctrl+Shift+P — works even when a form field is focused, which is
  // why this is a listener rather than a registry command (ShortcutManager
  // ignores keys typed into inputs). Keep this chord out of the command
  // registry: a registry binding would fire alongside this listener and the two
  // toggles would cancel out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, [toggle]);

  // Seed + focus when opened; reset when closed.
  useLayoutEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setActive(0);
      // Focus after the portal paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  const items = useMemo(
    () => (open ? buildItems(query, closePalette) : []),
    [open, query, closePalette],
  );

  // Keep the active index in range as results change.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items.length]);

  const runActive = useCallback(() => {
    const item = items[active];
    if (item && !item.disabled) item.run();
  }, [items, active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runActive();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  };

  // Scroll the active row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  let lastSection: Section | null = null;

  return createPortal(
    <div className={styles.scrim} onPointerDown={closePalette} role="presentation">
      <div
        className={styles.palette}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className={styles.searchRow}>
          <Icon name="search" size={16} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            spellCheck={false}
            placeholder="Search commands, layers, compositions…"
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            aria-label="Command palette search"
          />
        </div>

        <div className={styles.list} ref={listRef} role="listbox">
          {items.length === 0 ? (
            <div className={styles.empty}>No results</div>
          ) : (
            items.map((item, i) => {
              const header =
                item.section !== lastSection ? ((lastSection = item.section), item.section) : null;
              return (
                <div key={item.key}>
                  {header ? <div className={styles.sectionHeader}>{header}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    className={cn(styles.row, item.disabled && styles.rowDisabled)}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => {
                      if (!item.disabled) item.run();
                    }}
                  >
                    <Icon
                      name={item.icon}
                      size={15}
                      className={styles.rowIcon}
                      style={item.color ? { color: item.color } : undefined}
                    />
                    <span className={styles.rowLabel}>{item.label}</span>
                    {item.hint ? <span className={styles.rowHint}>{item.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className={styles.footer}>
          <span><kbd className={styles.kbd}>↑↓</kbd> navigate</span>
          <span><kbd className={styles.kbd}>↵</kbd> run</span>
          <span><kbd className={styles.kbd}>esc</kbd> close</span>
          <span className={styles.modeHints}>
            <kbd className={styles.kbd}>&gt;</kbd> commands
            <kbd className={styles.kbd}>@</kbd> layers
            <kbd className={styles.kbd}>#</kbd> comps
            <kbd className={styles.kbd}>:</kbd> time
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default CommandPalette;
