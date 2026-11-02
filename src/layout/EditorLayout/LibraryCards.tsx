/**
 * The Library's card system — shared by Templates, Transitions, Sound FX and
 * Lottie, for bundled (free) items and the premium shelf alike.
 *
 * A premium card is visible to everyone: its preview is the server's rendered
 * loop (poster at rest, the video while hovered or focused — the same rule as
 * the engine-drawn free cards). Clicking one as a Premation Cloud account
 * downloads and inserts it; anyone else gets the Premium sheet — the loop
 * large, what the item is, what it lands as, and the way to get it. The
 * backend's 402 is the real gate; when the plan is not known yet the card
 * simply tries, and a refusal opens the sheet. Free-tier items (the template
 * tasters) are for everyone and carry no PRO mark.
 *
 * The sheet is ONE dialog over the app (`PremiumPromptHost`, opened through
 * `proPromptStore`), so the card, a canvas drop and a timeline drop all land
 * on the same "Get Premation Cloud" / "Sign in" prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { t } from '@core/i18n';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { auditionState, subscribeAudition } from '@core/library/audition';
import { libraryMediaUrl } from '@core/library/premium/catalog';
import type { PremiumCatalogItem, PremiumKind } from '@core/library/premium/packFormat';
import { usePremiumAccess, useOpenBilling, useOpenSignIn, type PremiumAccess } from '@hooks/usePremiumAccess';
import { useProSalesOpen } from '@hooks/useProSalesOpen';
import { useCloudOffer, useCloudTrialDays } from '@hooks/useCloudOffer';
import { markLayerTransitionDrag } from '@layout/Timeline/transitionDrag';
import { useEntitlementStore } from '@stores/entitlementStore';
import { usePremiumLibraryStore } from '@stores/premiumLibraryStore';
import { promptForPro, useProPromptStore } from '@stores/proPromptStore';
import { useUIStore } from '@stores/uiStore';
import { FavoriteStar } from './LibraryBrowser';
export { Segmented, tierOptions, type SegOption, type TierFilter } from './LibraryBrowser';
import { insertPremiumItem, insertPremiumWithToast, PREMIUM_TRANSITION_PREFIX } from './premiumInsertEdits';
import styles from './LibraryCards.module.css';

export { styles as libraryCardStyles };

/** How long a pointer must rest on a card before its loop starts (fly-overs load nothing). */
const HOVER_DELAY_MS = 140;

// ── The PRO mark ──────────────────────────────────────────────────

export function ProMark({ locked, onThumb = false }: { locked: boolean; onThumb?: boolean }): JSX.Element {
  return (
    <span
      className={onThumb ? styles.proOnThumb : styles.pro}
      title={locked
        ? t('editor.library.pro.lockedTitle', 'Included with Premation Cloud')
        : t('editor.library.pro.title', 'Premation Cloud')}
    >
      {locked && <Icon name="lock" size="sm" />}
      {t('editor.library.pro.mark', 'PRO')}
    </span>
  );
}

// ── Shelf state ───────────────────────────────────────────────────

export interface PremiumShelf {
  items: PremiumCatalogItem[];
  status: ReturnType<typeof usePremiumLibraryStore.getState>['status'];
  access: PremiumAccess;
  retry: () => void;
}

/** The premium items of `kind`, loading the catalog the first time any tab asks. */
export function usePremiumShelf(kind: PremiumKind): PremiumShelf {
  const signedAccess = usePremiumAccess();
  const status = usePremiumLibraryStore((s) => s.status);
  const all = usePremiumLibraryStore((s) => s.items);
  const load = usePremiumLibraryStore((s) => s.load);
  // The local edition has no server shelf, but a dev build may still serve packs from disk.
  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);
  const items = useMemo(() => all.filter((i) => i.kind === kind), [all, kind]);
  // Dev packs in the local edition: there is no account to gate them, so they insert.
  const access: PremiumAccess = signedAccess === 'local' && items.length > 0 ? 'pro' : signedAccess;
  return { items, status, access, retry: () => { void load({ force: true }); } };
}

/** One line under the filters when the shelf is not what it should be. Null when all is well. */
export function ShelfNote({ shelf }: { shelf: PremiumShelf }): JSX.Element | null {
  if (shelf.access === 'local') return null;
  if (shelf.status === 'offline') {
    return (
      <p className={styles.shelfNote} role="status">
        <Icon name="info" size="sm" />
        <span>{t('editor.library.shelf.offline', 'You are offline. Premium items you have used before still work.')}</span>
      </p>
    );
  }
  if (shelf.status === 'error' && shelf.items.length === 0) {
    return (
      <p className={styles.shelfNote} role="status">
        <Icon name="warning" size="sm" />
        <span>{t('editor.library.shelf.error', 'The premium library did not load.')}</span>
        <Button size="sm" variant="ghost" onClick={shelf.retry}>{t('editor.library.shelf.retry', 'Retry')}</Button>
      </p>
    );
  }
  return null;
}

// ── Hover-to-play ─────────────────────────────────────────────────

/** True while the element is hovered (after a short rest) or holds keyboard focus. */
export function useHoverPlay(): {
  playing: boolean;
  bind: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  };
} {
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const start = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPlaying(true), delay);
  }, []);
  const stop = useCallback(() => {
    window.clearTimeout(timer.current);
    setPlaying(false);
  }, []);
  return {
    playing,
    bind: {
      onPointerEnter: () => start(HOVER_DELAY_MS),
      onPointerLeave: stop,
      onFocus: () => start(0),
      onBlur: stop,
    },
  };
}

/**
 * The server's rendered loop: the poster at rest, the video while `playing`.
 * The video's source is only set while playing, so a grid of forty cards loads
 * forty posters, not forty videos.
 */
export function PremiumThumb({ item, playing, autoPlay = false }: { item: PremiumCatalogItem; playing: boolean; autoPlay?: boolean }): JSX.Element {
  const video = useRef<HTMLVideoElement | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const poster = libraryMediaUrl(item.poster);
  const preview = libraryMediaUrl(item.preview);
  const live = (playing || autoPlay) && !!preview;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (live) {
      void v.play().catch(() => undefined);
    } else {
      v.pause();
      setVideoReady(false);
    }
  }, [live]);

  return (
    <>
      {poster && !posterFailed ? (
        <img className={styles.media} src={poster} alt="" draggable={false} loading="lazy" onError={() => setPosterFailed(true)} />
      ) : (
        <span className={styles.thumbEmpty} aria-hidden><Icon name={item.kind === 'sfx' ? 'audio' : 'video'} size="md" /></span>
      )}
      {live && (
        <video
          ref={video}
          className={videoReady ? styles.media : styles.mediaHidden}
          src={preview ?? undefined}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          aria-hidden
          onPlaying={() => setVideoReady(true)}
        />
      )}
    </>
  );
}

// ── Premium card ──────────────────────────────────────────────────

function metaLine(item: PremiumCatalogItem): string {
  const secs = item.durationSec;
  const time = secs >= 60 ? `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}` : `${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`;
  const parts: string[] = [];
  if (item.kind === 'template' && item.aspect) parts.push(item.aspect);
  parts.push(time);
  if (item.kind === 'template' && item.fieldCount) parts.push(t('editor.library.card.fields', '{count} fields', { count: item.fieldCount }));
  return parts.join(' · ');
}

/** A Pro item this viewer is known not to have (the PRO mark carries a lock; no drag). */
export function premiumLocked(item: Pick<PremiumCatalogItem, 'tier'>, access: PremiumAccess): boolean {
  return item.tier === 'cloud' && (access === 'free' || access === 'signedOut');
}

/**
 * Insert a premium item from a card, or open the Pro dialog when the account
 * may not. Shared by grid cards and sound rows.
 */
export function usePremiumActivate(item: PremiumCatalogItem, access: PremiumAccess): () => void {
  const notify = useUIStore((s) => s.notify);
  return useCallback(() => {
    if (premiumLocked(item, access)) {
      promptForPro(item);
      return;
    }
    void insertPremiumItem(item).then((r) => {
      if (r.ok) notify({ level: 'success', message: r.message, durationMs: 2200 });
      // A plan refusal has opened the Pro dialog already.
      else if (r.code !== 'plan-required' && r.code !== 'signed-out') notify({ level: 'warning', message: r.message, durationMs: 3400 });
    });
  }, [access, item, notify]);
}

export function PremiumCard({ item, access, square = false }: {
  item: PremiumCatalogItem;
  access: PremiumAccess;
  square?: boolean;
}): JSX.Element {
  const { playing, bind } = useHoverPlay();
  const busy = usePremiumLibraryStore((s) => s.busy.has(item.id));
  const activate = usePremiumActivate(item, access);
  const locked = premiumLocked(item, access);
  // An unknown plan may drag too: the drop goes through the same gate.
  const canDrag = !locked;
  return (
    <button
      type="button"
      className={styles.card}
      data-premium="true"
      aria-busy={busy}
      title={locked
        ? t('editor.library.card.lockedTitle', '{name} — Premation Cloud. Click to preview.', { name: item.name })
        : item.kind === 'transition'
          ? t('editor.library.card.transitionTitle', '{name} — drag onto a layer’s start or end, or click to apply to the selected layers', { name: item.name })
          : t('editor.library.card.title', '{name} — click to insert, or drag onto the canvas', { name: item.name })}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) { e.preventDefault(); return; }
        setCanvasDrag(e, { kind: 'premium', itemId: item.id, name: item.name });
        if (item.kind === 'transition') markLayerTransitionDrag(e.dataTransfer, `${PREMIUM_TRANSITION_PREFIX}${item.id}`);
      }}
      onClick={() => { if (!busy) activate(); }}
      {...bind}
    >
      <span className={square ? styles.thumbSquare : styles.thumb}>
        <PremiumThumb item={item} playing={playing} />
        {item.tier === 'cloud' && <ProMark locked={access !== 'pro'} onThumb />}
        {busy && (
          <span className={styles.busy} role="status">
            <span className={styles.spinner} aria-hidden />
            {t('editor.library.card.downloading', 'Getting…')}
          </span>
        )}
      </span>
      <span className={styles.metaRow}>
        <span className={styles.metaText}>
          <span className={styles.name}>{item.name}</span>
          <span className={styles.meta}>{metaLine(item)}</span>
        </span>
        <FavoriteStar id={item.id} label={item.name} />
      </span>
    </button>
  );
}

/** A bundled (free) item's card frame — the caller supplies the engine-drawn preview. */
export function FreeCard({ id, name, meta, title, preview, square = false, draggable = true, onDragStart, onActivate, hoverBind }: {
  id: string;
  name: string;
  meta: string;
  title: string;
  preview: ReactNode;
  square?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onActivate: () => void;
  hoverBind?: ReturnType<typeof useHoverPlay>['bind'];
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.card}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onActivate}
      {...hoverBind}
    >
      <span className={square ? styles.thumbSquare : styles.thumb}>{preview}</span>
      <span className={styles.metaRow}>
        <span className={styles.metaText}>
          <span className={styles.name}>{name}</span>
          <span className={styles.meta}>{meta}</span>
        </span>
        <FavoriteStar id={id} label={name} />
      </span>
    </button>
  );
}

// ── Waveform ──────────────────────────────────────────────────────

const WAVE_W = 88;
const WAVE_H = 24;

/**
 * Peaks as bars, with the audition's progress laid over in the accent colour.
 * Progress arrives through a subscription into a clip rect's width — no React
 * render while a sound plays.
 */
export function Waveform({ id, peaks }: { id: string; peaks: readonly number[] }): JSX.Element {
  const clip = useRef<SVGRectElement | null>(null);
  const clipId = useMemo(() => `wv-${id.replace(/[^a-z0-9]/gi, '')}-${Math.random().toString(36).slice(2, 7)}`, [id]);
  useEffect(() => {
    const apply = (s: { id: string | null; progress: number }): void => {
      clip.current?.setAttribute('width', String(s.id === id ? s.progress * WAVE_W : 0));
    };
    apply(auditionState());
    return subscribeAudition(apply);
  }, [id]);
  const bars = peaks.length > 0 ? peaks : [0.1];
  const bw = WAVE_W / bars.length;
  const rects = bars.map((p, i) => {
    const h = Math.max(1.5, Math.min(1, p) * WAVE_H);
    return <rect key={i} x={i * bw + 0.25} y={(WAVE_H - h) / 2} width={Math.max(0.5, bw - 0.5)} height={h} rx={0.5} />;
  });
  return (
    <svg className={styles.wave} viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <clipPath id={clipId}><rect ref={clip} x={0} y={0} width={0} height={WAVE_H} /></clipPath>
      </defs>
      <g className={styles.waveBase}>{rects}</g>
      <g className={styles.wavePlayed} clipPath={`url(#${clipId})`}>{rects}</g>
    </svg>
  );
}

/** Whether `id` is the sound auditioning right now (re-renders only on start / stop). */
export function useAuditioning(id: string): boolean {
  const [on, setOn] = useState(() => auditionState().id === id);
  useEffect(() => subscribeAudition((s) => setOn((prev) => (prev === (s.id === id) ? prev : s.id === id))), [id]);
  return on;
}

// ── The Premium sheet ─────────────────────────────────────────────

function landsAs(item: PremiumCatalogItem): string {
  switch (item.kind) {
    case 'template':
      return item.mode === 'element'
        ? t('editor.library.sheet.landsElement', 'Drops into your composition at the playhead, sized to it.')
        : t('editor.library.sheet.landsScene', 'Opens in a new composition — your current work stays as it is.');
    case 'lottie':
      return t('editor.library.sheet.landsLottie', 'Lands as editable shape layers: recolor, retime and rescale it like your own.');
    case 'sfx':
      return t('editor.library.sheet.landsSfx', 'A mixed stereo WAV, added as an audio layer at the playhead.');
    case 'transition':
      return t('editor.library.sheet.landsTransition', 'Keys onto any layer’s entrance or exit — drag it onto a layer’s start or end.');
  }
}

function kindNoun(item: PremiumCatalogItem): string {
  switch (item.kind) {
    case 'template': return t('editor.library.sheet.kindTemplate', 'template');
    case 'lottie': return t('editor.library.sheet.kindLottie', 'animation');
    case 'sfx': return item.category === 'music' ? t('editor.library.sheet.kindMusic', 'music track') : t('editor.library.sheet.kindSfx', 'sound');
    case 'transition': return t('editor.library.sheet.kindTransition', 'transition');
  }
}

/**
 * What a viewer without Premation Cloud sees on asking for a premium item: a
 * modal over the app. Esc, the close button or a click on the scrim dismiss
 * it; focus is kept inside while it is open and returned after. Opening it
 * re-asks the server for the plan, so an account upgraded a minute ago in the
 * browser gets "Insert" instead of a second sales pitch.
 */
export function PremiumSheet({ item, access, onClose }: {
  item: PremiumCatalogItem;
  access: PremiumAccess;
  onClose: () => void;
}): JSX.Element {
  const sheet = useRef<HTMLDivElement | null>(null);
  const openBilling = useOpenBilling();
  const openSignIn = useOpenSignIn();
  const salesOpen = useProSalesOpen();
  const offerLine = useCloudOffer();
  const trialDays = useCloudTrialDays();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);

  useEffect(() => {
    void useEntitlementStore.getState().refresh({ force: true });
  }, [item.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !sheet.current) return;
    const focusable = Array.from(sheet.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // Leave for sign-in or billing with the dialog closed, so it is not waiting on return.
  const leaveVia = (go: () => void) => () => { onClose(); go(); };
  const unlocked = !premiumLocked(item, access) && access !== 'unknown';

  let primary: ReactNode = null;
  if (unlocked) {
    primary = (
      <Button variant="primary" size="sm" onClick={() => { onClose(); void insertPremiumWithToast(item); }}>
        {t('editor.library.sheet.insert', 'Insert')}
      </Button>
    );
  } else if (access === 'signedOut' && openSignIn) {
    primary = <Button variant="primary" size="sm" onClick={leaveVia(openSignIn)}>{t('editor.library.sheet.signIn', 'Sign in')}</Button>;
  } else if (openBilling && salesOpen) {
    primary = (
      <Button variant="primary" size="sm" onClick={leaveVia(openBilling)}>
        {trialDays > 0
          ? t('editor.library.sheet.startTrial', 'Try Premation Cloud free')
          : t('editor.library.sheet.getCloud', 'Get Premation Cloud')}
      </Button>
    );
  } else if (openBilling) {
    primary = <Button variant="secondary" size="sm" onClick={leaveVia(openBilling)}>{t('editor.library.sheet.seePlans', 'See plans')}</Button>;
  }

  const pitch = unlocked
    ? t('editor.library.sheet.unlocked', 'Your plan includes this {kind}.', { kind: kindNoun(item) })
    : access === 'signedOut'
      ? t('editor.library.sheet.pitchSignIn', 'This is a Pro {kind}. Sign in with a Premation Cloud account to use it.', { kind: kindNoun(item) })
      : t('editor.library.sheet.pitch', 'This is a Pro {kind}. Upgrade to Premation Cloud to use it in your projects.', { kind: kindNoun(item) });

  const square = item.aspect === '1:1' || item.kind === 'lottie';
  const audio = item.kind === 'sfx' ? libraryMediaUrl(item.audio) : null;

  return (
    <div className={styles.scrim} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={sheet}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="premium-sheet-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={square ? styles.sheetPreviewSquare : styles.sheetPreview}>
          {item.kind === 'sfx' ? (
            <span className={styles.thumbEmpty}>
              {audio ? <audio controls src={audio} preload="none" style={{ width: '88%' }} /> : <Icon name="audio" size="lg" />}
            </span>
          ) : (
            <PremiumThumb item={item} playing autoPlay />
          )}
          <button type="button" className={styles.sheetClose} aria-label={t('editor.library.sheet.close', 'Close')} onClick={onClose}>
            <Icon name="close" size="sm" />
          </button>
        </div>
        <div className={styles.sheetBody}>
          <div className={styles.sheetTitleRow}>
            <h3 id="premium-sheet-title" className={styles.sheetTitle}>{item.name}</h3>
            <ProMark locked={!unlocked} />
          </div>
          <p className={styles.sheetText}>{pitch}</p>
          <p className={styles.sheetHelp}>
            {[item.category, item.kind === 'template' && item.width && item.height ? `${item.width}×${item.height}` : null, metaLine(item)].filter(Boolean).join(' · ')}
          </p>
          {item.description && <p className={styles.sheetText}>{item.description}</p>}
          <p className={styles.sheetText}>{landsAs(item)}</p>
          {item.fieldLabels && item.fieldLabels.length > 0 && (
            <p className={styles.sheetHelp}>
              {t('editor.library.sheet.editable', 'You can edit: {fields}', { fields: item.fieldLabels.join(', ') })}
            </p>
          )}
          <div className={styles.sheetActions}>
            {primary}
            <Button variant="ghost" size="sm" onClick={onClose}>{t('editor.library.sheet.close', 'Close')}</Button>
          </div>
          <p className={styles.sheetHelp}>
            {!openBilling
              ? t('editor.library.sheet.noBilling', 'Premium items come with Premation Cloud.')
              : !salesOpen
                ? t('editor.library.sheet.salesClosed', 'Premation Cloud is not on sale right now — check back soon.')
                : t('editor.library.sheet.included', 'Every Pro template, transition, sound and Lottie comes with Premation Cloud.')}
          </p>
          {!unlocked && access !== 'signedOut' && openBilling && salesOpen && offerLine ? (
            <p className={styles.sheetHelp}>{offerLine}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The editor's one Pro dialog (proPromptStore), mounted once beside the layout. */
export function PremiumPromptHost(): JSX.Element | null {
  const item = useProPromptStore((s) => s.item);
  const close = useProPromptStore((s) => s.close);
  const access = usePremiumAccess();
  if (!item) return null;
  return createPortal(<PremiumSheet key={item.id} item={item} access={access} onClose={close} />, document.body);
}
