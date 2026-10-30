/**
 * The dashboard's Library page — the editor Library's premium shelves
 * (templates, transitions, Lottie animations, sounds) as a place to browse and
 * START a project, not a panel to drop things from.
 *
 * Same catalog and the same cards' rule as the editor's shelf (LibraryCards):
 * the poster at rest, the server's rendered loop while hovered or focused;
 * sounds audition before anything is added. "Use" asks the dashboard to create
 * a project (at a template's own size), and the editor inserts the item the
 * moment that project opens (core/project/pendingTemplate). Transitions key
 * onto layers, so they have nothing to land on in a new project: their sheet
 * points to the editor's Library instead.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Icon, type IconName } from '@components/Icon';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';
import { auditionState, auditionUrl, stopAudition } from '@core/library/audition';
import { libraryMediaUrl } from '@core/library/premium/catalog';
import type { PremiumCatalogItem, PremiumKind } from '@core/library/premium/packFormat';
import { transitionCategoryLabel } from '@core/library/transitionLibrary';
import type { PremiumAccess } from '@hooks/usePremiumAccess';
import {
  PremiumThumb, ProMark, Waveform, premiumLocked, useAuditioning, useHoverPlay, usePremiumShelf, type PremiumShelf,
} from '@layout/EditorLayout/LibraryCards';
import { useUIStore } from '@stores/uiStore';
import styles from './DashboardTemplates.module.css';

// ── Kinds ─────────────────────────────────────────────────────────

interface KindInfo {
  kind: PremiumKind;
  label: string;
  icon: IconName;
  /** Preferred category order; categories outside it are appended. */
  order: readonly string[];
  noun: string;
}

/** A function: `t()` runs at render time. */
function kinds(): readonly KindInfo[] {
  return [
    { kind: 'template', label: t('dashboard.library.templates', 'Templates'), icon: 'layout', noun: t('dashboard.library.nounTemplates', 'templates'),
      order: ['openers', 'titles', 'lower-thirds', 'social', 'promo', 'slideshow', 'logo', 'typography', 'data'] },
    { kind: 'transition', label: t('dashboard.library.transitions', 'Transitions'), icon: 'scissors', noun: t('dashboard.library.nounTransitions', 'transitions'),
      order: ['seamless', 'zoom', 'whip', 'slide', 'glitch', 'light', 'shape', 'wipe', 'fade'] },
    { kind: 'lottie', label: t('dashboard.library.lottie', 'Lottie'), icon: 'sparkles', noun: t('dashboard.library.nounLottie', 'animations'),
      order: ['feedback', 'loaders', 'icons', 'social', 'celebration'] },
    { kind: 'sfx', label: t('dashboard.library.sounds', 'Sounds'), icon: 'audio', noun: t('dashboard.library.nounSounds', 'sounds'),
      order: ['impact', 'whoosh', 'riser', 'ui', 'glitch', 'foley', 'magic', 'music'] },
  ];
}

function isKind(v: string | null): v is PremiumKind {
  return v === 'template' || v === 'transition' || v === 'lottie' || v === 'sfx';
}

const categoryId = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, '-');
const titleCase = (cat: string): string => cat.charAt(0).toUpperCase() + cat.slice(1).replace(/-/g, ' ');

function categoryLabel(kind: PremiumKind, cat: string): string {
  if (kind === 'transition') {
    return ['fade', 'slide', 'zoom', 'whip', 'glitch', 'wipe'].includes(cat) ? transitionCategoryLabel(cat) : titleCase(cat);
  }
  switch (cat) {
    case 'openers': return t('templates.gallery.cat.openers', 'Openers');
    case 'titles': return t('templates.gallery.cat.titles', 'Titles');
    case 'lower-thirds': return t('templates.gallery.cat.lowerThirds', 'Lower thirds');
    case 'social': return t('templates.gallery.cat.social', 'Social');
    case 'promo': return t('templates.gallery.cat.promo', 'Promo');
    case 'slideshow': return t('templates.gallery.cat.slideshow', 'Slideshow');
    case 'logo': return t('templates.gallery.cat.logo', 'Logo');
    case 'typography': return t('templates.gallery.cat.typography', 'Typography');
    case 'data': return t('templates.gallery.cat.data', 'Data');
    case 'feedback': return t('editor.library.lottie.catFeedback', 'Feedback');
    case 'loaders': return t('editor.library.lottie.catLoaders', 'Loaders');
    case 'icons': return t('editor.library.lottie.catIcons', 'Icons');
    case 'celebration': return t('editor.library.lottie.catCelebration', 'Celebration');
    case 'whoosh': return t('editor.library.sfx.catWhoosh', 'Whoosh');
    case 'impact': return t('editor.library.sfx.catImpact', 'Impact');
    case 'riser': return t('editor.library.sfx.catRiser', 'Riser');
    case 'ui': return t('editor.library.sfx.catUi', 'UI');
    case 'glitch': return t('editor.library.sfx.catGlitch', 'Glitch');
    case 'foley': return t('editor.library.sfx.catFoley', 'Foley');
    case 'music': return t('editor.library.sfx.catMusic', 'Music');
    case 'magic': return t('editor.library.sfx.catMagic', 'Magic');
    default: return titleCase(cat);
  }
}

type AspectFilter = 'all' | '16:9' | '9:16' | '1:1';

function duration(secs: number): string {
  if (secs >= 60) return `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
  return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`;
}

/** Aspect · length · fields — the card's one quiet line. */
function metaLine(item: PremiumCatalogItem): string {
  const parts: string[] = [];
  if (item.kind === 'template' && item.mode !== 'element' && item.aspect) parts.push(item.aspect);
  if (item.kind !== 'template') parts.push(categoryLabel(item.kind, categoryId(item.category)));
  parts.push(duration(item.durationSec));
  if (item.fieldCount) parts.push(t('dashboard.templates.fields', '{count} fields', { count: item.fieldCount }));
  return parts.join(' · ');
}

/** The thumb's frame: portrait and square items sit centred in a landscape well. */
function frameShape(item: PremiumCatalogItem): 'landscape' | 'portrait' | 'square' {
  if (item.kind === 'lottie' || item.aspect === '1:1') return 'square';
  if (item.aspect === '9:16') return 'portrait';
  return 'landscape';
}

// ── Cards ─────────────────────────────────────────────────────────

const LibraryCard = memo(function LibraryCard({ item, access, index, featured, onOpen }: {
  item: PremiumCatalogItem;
  access: PremiumAccess;
  index: number;
  featured: boolean;
  onOpen: (item: PremiumCatalogItem) => void;
}): JSX.Element {
  const { playing, bind } = useHoverPlay();
  return (
    <button
      type="button"
      className={cn(styles.card, featured && styles.cardFeatured)}
      // The reveal cascade: capped, so a long shelf does not keep arriving.
      style={{ '--i': Math.min(index, 12) } as CSSProperties}
      onClick={() => onOpen(item)}
      aria-label={t('dashboard.templates.openAria', 'Preview {name}', { name: item.name })}
      {...bind}
    >
      <span className={cn(styles.thumb, item.kind === 'lottie' && styles.thumbLottie)} data-shape={frameShape(item)}>
        <span className={styles.thumbFrame}>
          <PremiumThumb item={item} playing={playing} />
        </span>
        {item.tier === 'cloud' && <ProMark locked={premiumLocked(item, access)} onThumb />}
        <span className={styles.thumbHint} aria-hidden>
          <Icon name="play" size="sm" />
          {t('dashboard.templates.preview', 'Preview')}
        </span>
      </span>
      <span className={styles.cardText}>
        <span className={styles.cardName}>{item.name}</span>
        <span className={styles.cardMeta}>{metaLine(item)}</span>
      </span>
    </button>
  );
});

/** One sound: listen first, then start a project with it. */
const SoundRow = memo(function SoundRow({ item, access, index, creating, onToggle, onUse, onOpenBilling }: {
  item: PremiumCatalogItem;
  access: PremiumAccess;
  index: number;
  creating: boolean;
  onToggle: (item: PremiumCatalogItem) => void;
  onUse: (item: PremiumCatalogItem) => void;
  onOpenBilling: () => void;
}): JSX.Element {
  const playing = useAuditioning(item.id);
  const locked = premiumLocked(item, access);
  return (
    <div className={styles.soundRow} data-playing={playing} style={{ '--i': Math.min(index, 12) } as CSSProperties}>
      <button
        type="button"
        className={styles.playButton}
        aria-pressed={playing}
        aria-label={playing
          ? t('editor.library.sfx.stop', 'Stop {name}', { name: item.name })
          : t('editor.library.sfx.play', 'Play {name}', { name: item.name })}
        onClick={() => onToggle(item)}
      >
        <Icon name={playing ? 'stop' : 'play'} size="sm" />
      </button>
      <span className={styles.soundText}>
        <span className={styles.cardName}>{item.name}</span>
        <span className={styles.cardMeta}>{metaLine(item)}</span>
      </span>
      <span className={styles.soundWave}>
        <Waveform id={item.id} peaks={item.peaks ?? []} />
      </span>
      {item.tier === 'cloud' ? <ProMark locked={locked} /> : <span className={styles.soundSpacer} />}
      {locked ? (
        <button type="button" className={styles.rowAction} onClick={onOpenBilling}>
          {t('dashboard.library.unlock', 'Unlock')}
        </button>
      ) : (
        <button type="button" className={styles.rowAction} disabled={creating} onClick={() => onUse(item)}>
          {t('dashboard.library.useSound', 'Use')}
        </button>
      )}
    </div>
  );
});

function SkeletonGrid({ rows = false }: { rows?: boolean }): JSX.Element {
  if (rows) {
    return (
      <div className={styles.soundList} aria-busy="true" aria-label={t('dashboard.templates.loadingAria', 'Loading templates')}>
        {Array.from({ length: 6 }, (_, i) => <span key={i} className={styles.skeletonRow} />)}
      </div>
    );
  }
  return (
    <div className={styles.grid} aria-busy="true" aria-label={t('dashboard.templates.loadingAria', 'Loading templates')}>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={styles.skeletonCard}>
          <span className={styles.skeletonThumb} />
          <span className={styles.skeletonLine} />
          <span className={cn(styles.skeletonLine, styles.skeletonLineShort)} />
        </div>
      ))}
    </div>
  );
}

// ── Sheet ─────────────────────────────────────────────────────────

function ItemSheet({ item, access, creating, onUse, onOpenBilling, onClose }: {
  item: PremiumCatalogItem;
  access: PremiumAccess;
  creating: boolean;
  onUse: (item: PremiumCatalogItem) => void;
  onOpenBilling: () => void;
  onClose: () => void;
}): JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null);
  const locked = premiumLocked(item, access);
  const usable = item.kind !== 'transition';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const size = item.width && item.height ? `${item.width} × ${item.height}` : null;
  const facts: Array<[string, string]> = [
    [t('dashboard.templates.factCategory', 'Category'), categoryLabel(item.kind, categoryId(item.category))],
    [t('dashboard.templates.factLength', 'Length'), duration(item.durationSec)],
  ];
  if (item.kind === 'template') {
    if (item.mode === 'element') facts.push([t('dashboard.templates.factFits', 'Fits'), t('dashboard.templates.anySize', 'Any size')]);
    else if (size) facts.push([t('dashboard.templates.factSize', 'Size'), size]);
  } else if (item.kind === 'lottie') {
    facts.push([t('dashboard.library.factLands', 'Lands as'), t('dashboard.library.shapeLayers', 'Shape layers')]);
  } else if (item.kind === 'transition') {
    facts.push([t('dashboard.library.factLands', 'Lands as'), t('dashboard.library.keyframes', 'Keyframes')]);
  }

  let note: string;
  if (locked) note = t('dashboard.library.lockedNote', 'Pro items come with Premation Cloud.');
  else if (item.kind === 'transition') note = t('dashboard.library.transitionNote', 'Open a project, then drag it onto a layer from the Library panel.');
  else if (item.kind === 'template' && item.mode !== 'element') note = t('dashboard.templates.sceneNote', 'Opens in a new project at its own size.');
  else note = t('dashboard.templates.elementNote', 'Opens in a new 1920 × 1080 project.');

  return createPortal(
    <div className={styles.scrim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-sheet-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={cn(styles.sheetStage, item.kind === 'lottie' && styles.thumbLottie)} data-shape={frameShape(item)}>
          <span className={styles.sheetFrame}>
            <PremiumThumb item={item} playing autoPlay />
          </span>
        </div>

        <div className={styles.sheetBody}>
          <div className={styles.sheetHead}>
            <h2 id="library-sheet-title" className={styles.sheetTitle}>{item.name}</h2>
            {item.tier === 'cloud' && <ProMark locked={locked} />}
            <button type="button" className={styles.iconButton} aria-label={t('dashboard.templates.close', 'Close')} onClick={onClose}>
              <Icon name="close" size="sm" />
            </button>
          </div>

          {item.description ? <p className={styles.sheetText}>{item.description}</p> : null}

          <dl className={styles.facts}>
            {facts.map(([k, v]) => (
              <div key={k} className={styles.fact}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>

          {item.fieldLabels && item.fieldLabels.length > 0 ? (
            <div className={styles.fieldBlock}>
              <span className={styles.fieldHeading}>{t('dashboard.templates.editable', 'Editable')}</span>
              <ul className={styles.fieldList}>
                {item.fieldLabels.map((label) => <li key={label} className={styles.fieldChip}>{label}</li>)}
              </ul>
            </div>
          ) : null}

          <div className={styles.sheetActions}>
            {locked ? (
              <button type="button" className={styles.primary} onClick={() => { onClose(); onOpenBilling(); }}>
                {t('dashboard.templates.getCloud', 'Get Premation Cloud')}
              </button>
            ) : usable ? (
              <button type="button" className={styles.primary} disabled={creating} onClick={() => onUse(item)}>
                {creating
                  ? t('dashboard.templates.creating', 'Creating project…')
                  : item.kind === 'template' ? t('dashboard.templates.use', 'Use template') : t('dashboard.library.useInProject', 'Use in a new project')}
              </button>
            ) : null}
            <button type="button" className={styles.secondary} onClick={onClose}>
              {t('dashboard.templates.close', 'Close')}
            </button>
          </div>
          <p className={styles.sheetNote}>{note}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Page ──────────────────────────────────────────────────────────

/** Every shelf, loaded once (the store holds the whole catalog), so the tabs can show counts. */
function useShelves(): Record<PremiumKind, PremiumShelf> {
  return {
    template: usePremiumShelf('template'),
    transition: usePremiumShelf('transition'),
    lottie: usePremiumShelf('lottie'),
    sfx: usePremiumShelf('sfx'),
  };
}

export function DashboardTemplates({ creating, onUse, onOpenBilling }: {
  creating: boolean;
  onUse: (item: PremiumCatalogItem) => void;
  onOpenBilling: () => void;
}): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawKind = searchParams.get('kind');
  const kind: PremiumKind = isKind(rawKind) ? rawKind : 'template';
  const info = kinds().find((k) => k.kind === kind)!;
  const shelves = useShelves();
  const shelf = shelves[kind];
  const notify = useUIStore((s) => s.notify);

  const [category, setCategory] = useState<string>('all');
  const [aspect, setAspect] = useState<AspectFilter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<PremiumCatalogItem | null>(null);

  const chooseKind = useCallback((next: PremiumKind): void => {
    if (next === kind) return;
    stopAudition();
    setCategory('all');
    setAspect('all');
    const params = new URLSearchParams(searchParams);
    if (next === 'template') params.delete('kind');
    else params.set('kind', next);
    setSearchParams(params, { replace: true });
  }, [kind, searchParams, setSearchParams]);

  // Leaving the page (or the Sounds tab) stops the audition.
  useEffect(() => () => stopAudition(), []);

  const toggleSound = useCallback((item: PremiumCatalogItem): void => {
    if (auditionState().id === item.id) {
      stopAudition();
      return;
    }
    const audio = libraryMediaUrl(item.audio);
    if (!audio) return;
    auditionUrl(item.id, audio, item.durationSec, () => notify({
      level: 'warning',
      message: t('editor.library.sfx.previewFailed', 'Could not play the preview of {name}', { name: item.name }),
      durationMs: 2400,
    }));
  }, [notify]);

  const categories = useMemo(() => {
    const present = new Set(shelf.items.map((i) => categoryId(i.category)));
    const out: string[] = info.order.filter((c) => present.has(c));
    for (const c of present) if (!out.includes(c)) out.push(c);
    return out;
  }, [shelf.items, info.order]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shelf.items.filter((i) =>
      (category === 'all' || categoryId(i.category) === category)
      // An element (a lower third) fits any composition, so it has no aspect.
      && (kind !== 'template' || aspect === 'all' || i.mode === 'element' || !i.aspect || i.aspect === aspect)
      && (!q || i.name.toLowerCase().includes(q) || i.tags.some((tag) => tag.toLowerCase().includes(q)) || i.category.toLowerCase().includes(q)));
  }, [shelf.items, category, aspect, query, kind]);

  const filtered = category !== 'all' || aspect !== 'all' || query.trim() !== '';
  const clearFilters = useCallback(() => { setCategory('all'); setAspect('all'); setQuery(''); }, []);
  const close = useCallback(() => setOpen(null), []);
  const loading = shelf.items.length === 0 && (shelf.status === 'loading' || shelf.status === 'idle');

  let body: JSX.Element;
  if (loading) {
    body = <SkeletonGrid rows={kind === 'sfx'} />;
  } else if (shelf.items.length === 0) {
    const failed = shelf.status === 'error' || shelf.status === 'offline';
    body = (
      <div className={styles.empty} role="status">
        <span className={styles.emptyMark} aria-hidden><Icon name={failed ? 'warning' : info.icon} size="lg" /></span>
        <h3>{failed ? t('dashboard.library.errorTitle', 'The library did not load') : t('dashboard.library.noneTitle', 'Nothing here yet')}</h3>
        <p>
          {shelf.access === 'local'
            ? t('dashboard.library.localBody', 'The library comes with a Premation account.')
            : failed
              ? t('dashboard.templates.errorBody', 'Check your connection, then try again.')
              : t('dashboard.library.noneBody', 'New {noun} appear here as they are published.', { noun: info.noun })}
        </p>
        {failed ? <button type="button" className={styles.secondary} onClick={shelf.retry}>{t('dashboard.templates.retry', 'Try again')}</button> : null}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className={styles.empty} role="status">
        <span className={styles.emptyMark} aria-hidden><Icon name="search" size="lg" /></span>
        <h3>{t('dashboard.templates.noMatchTitle', 'Nothing matches')}</h3>
        <p>{t('dashboard.library.noMatchBody', 'Try another category, or clear the search.')}</p>
        <button type="button" className={styles.secondary} onClick={clearFilters}>{t('dashboard.templates.clear', 'Clear filters')}</button>
      </div>
    );
  } else if (kind === 'sfx') {
    body = (
      <div className={styles.soundList}>
        {items.map((item, i) => (
          <SoundRow
            key={item.id}
            item={item}
            access={shelf.access}
            index={i}
            creating={creating}
            onToggle={toggleSound}
            onUse={onUse}
            onOpenBilling={onOpenBilling}
          />
        ))}
      </div>
    );
  } else {
    body = (
      <div className={cn(styles.grid, kind === 'lottie' && styles.gridTight)}>
        {items.map((item, i) => (
          <LibraryCard
            key={item.id}
            item={item}
            access={shelf.access}
            index={i}
            // The first card leads an unfiltered template shelf; a filtered list is a list.
            featured={kind === 'template' && !filtered && i === 0 && items.length > 4}
            onOpen={setOpen}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.kindTabs} role="tablist" aria-label={t('dashboard.library.kindsAria', 'Library sections')}>
        {kinds().map((k) => {
          const count = shelves[k.kind].items.length;
          return (
            <button
              key={k.kind}
              type="button"
              role="tab"
              aria-selected={kind === k.kind}
              className={cn(styles.kindTab, kind === k.kind && styles.kindTabActive)}
              onClick={() => chooseKind(k.kind)}
            >
              <Icon name={k.icon} size="sm" />
              <span>{k.label}</span>
              {count > 0 ? <span className={styles.kindCount}>{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.chips} role="group" aria-label={t('dashboard.templates.categoryAria', 'Category')}>
          {['all', ...categories].map((c) => (
            <button
              key={c}
              type="button"
              className={cn(styles.chip, category === c && styles.chipActive)}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c === 'all' ? t('dashboard.templates.all', 'All') : categoryLabel(kind, c)}
            </button>
          ))}
        </div>
        <div className={styles.toolbarRight}>
          <div className={styles.search}>
            <Icon name="search" size="sm" className={styles.searchIcon} />
            <input
              type="search"
              className={styles.searchInput}
              placeholder={t('dashboard.library.search', 'Search {noun}', { noun: info.noun })}
              aria-label={t('dashboard.library.search', 'Search {noun}', { noun: info.noun })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {kind === 'template' ? (
            <div className={styles.segmented} role="group" aria-label={t('dashboard.templates.aspectAria', 'Aspect ratio')}>
              {(['all', '16:9', '9:16', '1:1'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={cn(styles.segment, aspect === a && styles.segmentActive)}
                  aria-pressed={aspect === a}
                  onClick={() => setAspect(a)}
                >
                  {a === 'all' ? t('dashboard.templates.any', 'Any') : a}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {!loading && shelf.items.length > 0 ? (
        <p className={styles.count}>
          {filtered
            ? t('dashboard.templates.countFiltered', '{shown} of {total}', { shown: items.length, total: shelf.items.length })
            : t('dashboard.library.count', '{total} {noun}', { total: shelf.items.length, noun: info.noun })}
        </p>
      ) : null}

      <div key={kind} className={styles.body}>{body}</div>

      {open ? (
        <ItemSheet
          key={open.id}
          item={open}
          access={shelf.access}
          creating={creating}
          onUse={onUse}
          onOpenBilling={onOpenBilling}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
