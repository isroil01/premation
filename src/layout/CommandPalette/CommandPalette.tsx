/**
 * CommandPalette — the universal, mode-aware launcher.
 *
 * Cmd/Ctrl+Shift+P opens it from anywhere (including while a field is focused).
 * Cmd/Ctrl+K belongs to Composition Settings, per AE. One
 * search box finds everything and switches mode by the first character:
 *   plain text → search all   ·   `>` commands   ·   `@` layers
 *   `#` compositions          ·   `:` timecode   ·   `?` docs
 *
 * These prefixes match VS Code / Linear conventions the target users know.
 *
 * A Radix Dialog, like `Modal`: focus is trapped inside (Tab cannot wander
 * off into the toolbar behind the scrim), Escape and outside-click close it,
 * and the trigger's focus is restored on close. The previous hand-rolled
 * portal had none of that.
 *
 * With an EMPTY query the list leads with what the user did last (the MRU in
 * `commandPaletteStore`) and the shortcuts that apply where they were
 * (`shortcutHints`); while they type, the MRU boosts the fuzzy score so a
 * recent command wins a near-tie.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon, type IconName } from '@components/Icon';
import { Kbd } from '@components/Kbd';
import { cn } from '@utils/cn';
import { useCommandPaletteStore } from '@stores/commandPaletteStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { framesToTimecode, displayFramesToDomainSeconds } from '@core/time/timecode';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSceneRevision } from '@stores/sceneStore';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
// The glyph table is `sceneDerive`'s, not a copy of it: this file used to keep
// its own, which had already drifted from the timeline's (a group drew a
// `layers` stack here and a `folder` there) for the same kind of object.
import { flattenScene, readNodeKind, KIND_COLOR, KIND_ICON } from '@core/scene/sceneDerive';
import { asCommandId } from '@app-types/common';
import { formatChord } from '@layout/Menu/formatChord';
import { resolveChord, getShortcutOverrides } from '@core/commands/shortcutOverrides';
import { parseQuery, fuzzyScore, parseTimecode } from './paletteSearch';
import { effectHits, presetHits } from './quickApply';
import { rankRecent, recencyBoost, type RecencyMap } from './paletteRecency';
import { CONTEXT_LABEL, shortcutHintsFor, type PaletteContext } from './shortcutHints';
import { sectionLabel, type DocSection } from './docsIndex';
import { openDocSection } from './DocsSectionDialog';
import styles from './CommandPalette.module.css';

/** Frames-per-second used to derive a frame number for timecode jumps. */
const FPS = 30;
const MAX_PER_GROUP = 8;

type Section =
  | 'Recent'
  | 'Shortcuts'
  | 'Commands'
  | 'Layers'
  | 'Compositions'
  | 'Go to time'
  | 'Effects'
  | 'Presets'
  | 'Docs';

interface Item {
  key: string;
  section: Section;
  /** Rendered header — `Shortcuts` carries the context in it. */
  sectionLabel?: string;
  label: string;
  /** Plain-text trailing note (a layer kind, "select a layer", a doc name). */
  hint?: string;
  /** A keyboard chord, drawn as keycaps — commands only. */
  chord?: string;
  icon: IconName;
  color?: string;
  disabled?: boolean;
  run: () => void;
}

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const chordOf = (c: Command): ReturnType<typeof resolveChord> =>
  resolveChord(c.id as unknown as string, c.shortcut, getShortcutOverrides());

interface BuildInput {
  query: string;
  closePalette: () => void;
  recent: RecencyMap;
  context: PaletteContext;
  docs: ReadonlyArray<DocSection> | null;
  now: number;
}

function commandItem(c: Command, section: Section, closePalette: () => void, sectionLabelText?: string): Item {
  const id = c.id as unknown as string;
  const disabled = c.enabled ? !c.enabled() : false;
  const chord = chordOf(c);
  return {
    key: `${section === 'Commands' ? 'cmd' : section.toLowerCase()}:${id}`,
    section,
    sectionLabel: sectionLabelText,
    label: c.label,
    chord: chord ? formatChord(chord) : undefined,
    icon: (c.icon as IconName) ?? 'crosshair',
    disabled,
    run: () => {
      closePalette();
      useCommandPaletteStore.getState().recordUse(id);
      void getCommandSystem().execute(asCommandId(id));
    },
  };
}

function buildItems({ query, closePalette, recent, context, docs, now }: BuildInput): Item[] {
  const { mode, term } = parseQuery(query);
  const items: Item[] = [];

  const wantCommands = mode === 'all' || mode === 'commands';
  const wantLayers = mode === 'all' || mode === 'layers';
  const wantComps = mode === 'all' || mode === 'compositions';
  const wantTime = mode === 'timecode' || (mode === 'all' && term !== '');
  // Quick Apply sources. In `all` mode they only join once there is a term —
  // an empty palette listing 174 effects buries the commands it opened for.
  const wantEffects = mode === 'effects' || (mode === 'all' && term !== '');
  const wantPresets = mode === 'presets' || (mode === 'all' && term !== '');
  const wantHelp = mode === 'help';
  const emptyState = mode === 'all' && term === '';

  // ── Docs (`?`) — exclusive: nothing else joins a help search ─────
  if (wantHelp) {
    if (docs) {
      const scored = docs
        .map((s) => ({ s, score: fuzzyScore(term, sectionLabel(s)) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.s.level - b.s.level)
        .slice(0, MAX_PER_GROUP * 3);
      for (const { s } of scored) {
        items.push({
          key: `doc:${s.id}`,
          section: 'Docs',
          label: sectionLabel(s),
          hint: s.doc,
          icon: 'info',
          run: () => {
            closePalette();
            openDocSection(s);
          },
        });
      }
    }
    return items;
  }

  const registry = getCommandRegistry();

  // ── Empty state: Recent, then the shortcuts that apply here ──────
  if (emptyState) {
    const seen = new Set<string>();
    for (const id of rankRecent(recent, now)) {
      const c = registry.get(asCommandId(id));
      if (!c) continue;
      seen.add(id);
      items.push(commandItem(c, 'Recent', closePalette));
    }
    const hints = shortcutHintsFor(registry.all(), context, chordOf);
    const label = `Shortcuts · ${CONTEXT_LABEL[context]}`;
    for (const { command } of hints) {
      const id = command.id as unknown as string;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(commandItem(command, 'Shortcuts', closePalette, label));
    }
  }

  // ── Commands ──────────────────────────────────────────────────────
  if (wantCommands) {
    const listed = new Set(items.map((i) => i.key.slice(i.key.indexOf(':') + 1)));
    const scored = registry
      .all()
      .map((c) => ({ c, s: fuzzyScore(term, c.label) }))
      .filter((x) => x.s >= 0)
      // The boost is added AFTER the match filter: history reorders matches,
      // it never invents one.
      .map((x) => ({ c: x.c, s: x.s + (term ? recencyBoost(recent[x.c.id as unknown as string], now) : 0) }))
      .sort((a, b) => b.s - a.s)
      .filter((x) => !emptyState || !listed.has(x.c.id as unknown as string))
      .slice(0, mode === 'commands' ? MAX_PER_GROUP * 3 : MAX_PER_GROUP);
    for (const { c } of scored) items.push(commandItem(c, 'Commands', closePalette));
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
          icon: (KIND_ICON[kind] ?? 'shape') as IconName,
          color: KIND_COLOR[kind],
          run: () => {
            closePalette();
            useSelectionStore.getState().set([n.id]);
          },
        });
      }
    }
  }

  // ── Quick Apply: effects + animation presets ──────────────────────
  if (wantEffects) {
    for (const h of effectHits(term, mode === 'effects' ? MAX_PER_GROUP * 4 : MAX_PER_GROUP)) {
      items.push({
        key: h.key,
        section: 'Effects',
        label: h.label,
        hint: h.enabled ? h.hint : 'select a layer',
        icon: 'sparkles',
        disabled: !h.enabled,
        run: () => {
          closePalette();
          h.apply();
        },
      });
    }
  }
  if (wantPresets) {
    for (const h of presetHits(term, mode === 'presets' ? MAX_PER_GROUP * 4 : MAX_PER_GROUP)) {
      items.push({
        key: h.key,
        section: 'Presets',
        label: h.label,
        hint: h.enabled ? h.hint : 'select a layer this fits',
        icon: 'zap',
        disabled: !h.enabled,
        run: () => {
          closePalette();
          h.apply();
        },
      });
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
  const recent = useCommandPaletteStore((s) => s.recent);
  const context = useCommandPaletteStore((s) => s.context);
  const toggle = useCommandPaletteStore((s) => s.toggle);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [docs, setDocs] = useState<ReadonlyArray<DocSection> | null>(null);
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

  // Seed when opened. Focus is handled by the dialog's open-autofocus below.
  useLayoutEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setActive(0);
    }
  }, [open, initialQuery]);

  // The docs index loads the first time a `?` query is typed, then sticks.
  const wantDocs = open && parseQuery(query).mode === 'help';
  useEffect(() => {
    if (!wantDocs || docs) return;
    let cancelled = false;
    void import('./docsGlob').then(({ loadDocsIndex }) => loadDocsIndex()).then((index) => {
      if (!cancelled) setDocs(index);
    });
    return () => { cancelled = true; };
  }, [wantDocs, docs]);

  const items = useMemo(
    () => (open ? buildItems({ query, closePalette, recent, context, docs, now: Date.now() }) : []),
    [open, query, closePalette, recent, context, docs],
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

  let lastHeader: string | null = null;
  const helpLoading = wantDocs && !docs;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.scrim}>
          <Dialog.Content
            className={styles.palette}
            aria-label="Command palette"
            aria-describedby={undefined}
            // The search box, not the first focusable (which Radix would pick).
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              inputRef.current?.focus();
            }}
          >
            <Dialog.Title style={SR_ONLY}>Command palette</Dialog.Title>
            <div className={styles.searchRow}>
              <Icon name="search" size="md" className={styles.searchIcon} />
              <input
                ref={inputRef}
                className={styles.input}
                value={query}
                spellCheck={false}
                placeholder="Search commands, layers, effects, presets… (? for docs)"
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
                <div className={styles.empty}>
                  {helpLoading ? 'Loading documentation…' : wantDocs ? 'No matching doc section' : 'No results'}
                </div>
              ) : (
                items.map((item, i) => {
                  const headerText = item.sectionLabel ?? item.section;
                  const header = headerText !== lastHeader ? ((lastHeader = headerText), headerText) : null;
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
                          size="sm"
                          className={styles.rowIcon}
                          style={item.color ? { color: item.color } : undefined}
                        />
                        <span className={styles.rowLabel}>{item.label}</span>
                        {item.chord ? <Kbd size="sm" chord={item.chord} className={styles.rowChord} /> : null}
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
                <kbd className={styles.kbd}>+</kbd> effects
                <kbd className={styles.kbd}>*</kbd> presets
                <kbd className={styles.kbd}>?</kbd> docs
              </span>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default CommandPalette;
