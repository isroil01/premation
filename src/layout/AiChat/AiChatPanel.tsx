/**
 * AiChatPanel — the assistant, docked as a panel (Window ▸ Panels ▸ Assistant).
 *
 * Layout (top → bottom): the 28px strip (Assistant / History, new chat), the
 * scrolling thread, and the composer pinned at the bottom.
 *
 * The thread draws, in the order a run produces them:
 *   • the starting briefs on an empty thread (briefs.ts) — a brief seeds the
 *     concept stage, it never pins a look;
 *   • the user's brief (a quoted block with a rule, never a chat bubble) and
 *     the assistant's prose;
 *   • the CONCEPT STAGE while the run waits for a pick: three directions as
 *     rows of one list — name, swatches, the idea, type / motion / camera —
 *     then Build / Three more / Surprise me;
 *   • the RUN LEDGER while it works: the piece's name, the elapsed time, Stop;
 *     every stage of the run as a row with its own clock (done · active ·
 *     pending), the tool steps in flight folded under the active stage, and
 *     the live filmstrip once frames exist;
 *   • the RESULT: the still, a scrubber, the critique's five scores as a
 *     meter row, Apply / Another take / Decline.
 *
 * The composer is one well: the brief, then a row of key · value chips (Mode,
 * Look, Shape, and Alternatives in Library mode) with Send at its end. The
 * model and the review setting are quiet menus on the line under it — they
 * are session settings, not part of the brief.
 *
 * All chat state lives in AiChatContext (hoisted above the dock tree), so
 * switching panels mid-run neither cancels the run nor rolls back a pending
 * preview transaction. Hairline rows, the grey pressed state, mono values and
 * blue only for the primary action and the live stage are the editor's own
 * panel grammar (the 2026-10-19 sheet): a panel like the others, not a chat
 * app pasted into one.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useDismissOnOutside } from '@hooks/useDismissOnOutside';
import ReactMarkdown from 'react-markdown';
import type { ConceptOption } from '@motion/author';
import { CRITIQUE_AXES } from '@motion/author';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { RangeInput } from '@components/RangeInput';
import { useAiProviderStore } from '@stores/aiProviderStore';

import type { GatewayProviderId, AiProviderId } from '@core/api/client';
import { processImageFile, type PendingImage } from '@core/ai/imageAttachment';
import { goToStart, isTransportPlaying, pauseTransport, playheadSeconds, playTransport, seekPlayhead } from '@core/timeline/timelineView';
import { useAiChatContext } from './AiChatContext';
import { openAiSettings } from '@layout/Settings/openCustomizeDialog';
import styles from './AiChatPanel.module.css';
import { engineCompStill } from '@core/engine/engineStill';
import { activeCompIdNow } from '@hooks/useMirror';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds } from '@core/mirror/compFacts';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { authorModeDefault } from '@core/config/flags';
import { LIVE_FRAME_CELLS, type PipelineStage, type PlanItem } from '@layout/Workspace/useAiChat';
import { BRIEFS_SHOWN, startingBriefs } from './briefs';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';

/** BYOK providers offered in the picker, in display order. */
const PROVIDER_OPTIONS: { id: GatewayProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
];

const MAX_IMAGES = 3;

function renderProviderIcon(provider: GatewayProviderId): JSX.Element {
  switch (provider) {
    case 'gemini':
      // Google Gemini spark — the four curved lobes, brand blue→purple gradient.
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" style={{ flex: 'none' }}>
          <defs>
            <linearGradient id="ai-gemini-grad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#4796E3" />
              <stop offset="55%" stopColor="#9177C7" />
              <stop offset="100%" stopColor="#D3667C" />
            </linearGradient>
          </defs>
          <path
            fill="url(#ai-gemini-grad)"
            d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12"
          />
        </svg>
      );
    case 'anthropic':
      // Anthropic wordmark "A" — the official slanted double-stroke glyph, coral.
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ flex: 'none', color: '#d97757' }}>
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </svg>
      );
    case 'openai':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ flex: 'none', color: '#10a37f' }}>
          <path d="M22.28 9.82a5.984 5.984 0 0 0-.52-4.91 6.046 6.046 0 0 0-6.51-2.9 6.065 6.065 0 0 0-4.73-2.01 6.015 6.015 0 0 0-5.76 4.19 6.05 6.05 0 0 0-4.3 2.92 5.98 5.98 0 0 0 .74 7.04 5.98 5.98 0 0 0 .51 4.91 6.051 6.051 0 0 0 6.52 2.9 5.985 5.985 0 0 0 4.73 2.01 6.05 6.05 0 0 0 5.77-4.2 5.98 5.98 0 0 0 4.3-2.92 6.008 6.008 0 0 0-.75-7.03Zm-9 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.78.78 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5Zm-9.66-4.12a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.12-1.64ZM2.36 7.9a4.49 4.49 0 0 1 2.35-1.97v5.68a.77.77 0 0 0 .39.67l5.84 3.37-2.02 1.17a.08.08 0 0 1-.07 0L4.02 14.1A4.5 4.5 0 0 1 2.36 7.9Zm16.6 3.86-5.84-3.38 2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.69 8.1v-5.68a.78.78 0 0 0-.39-.67Zm2.01-3.03-.14-.09-4.78-2.76a.78.78 0 0 0-.78 0L9.43 9.25V6.92a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66Zm-12.64 4.16-2.02-1.17a.08.08 0 0 1-.04-.06V6.08a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.78.78 0 0 0-.39.68v6.74Zm1.1-2.36 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5Z" />
        </svg>
      );
    case 'motion':
    default:
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ flex: 'none', color: '#2988ff' }}>
          <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
        </svg>
      );
  }
}

/**
 * Model id → display name.
 *
 * Ordered LONGEST-PREFIX-FIRST, because these are substring tests: `claude-opus-5`
 * must be checked before any shorter `claude-opus` prefix, and `gpt-4o-mini`
 * before `gpt-4o`. The ids come from the backend's capability matrix (with
 * `MODEL_SUGGESTIONS` as the offline fallback).
 */
const MODEL_LABELS: readonly [match: string, label: string][] = [
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  // Superseded but still served — a saved pick keeps its name.
  ['claude-opus-5', 'Claude Opus 5'],
  ['claude-opus-4-8', 'Claude Opus 4.8'],
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-luna', 'GPT-6 Luna'],
  ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-4o-mini', 'GPT-4o mini'],
  ['gpt-4o', 'GPT-4o'],
  ['o4-mini', 'o4-mini'],
];

function getModelLabel(val: string): string {
  if (val === 'motion') return 'Motion AI';
  const [, m] = val.split(':');
  if (!m) return t('aiChat.model.select', 'Select model');
  for (const [match, label] of MODEL_LABELS) {
    if (m.includes(match)) return label;
  }
  // The raw id, which is at least honest — a model this app offers should have
  // an entry above, and seeing the id is how that omission gets noticed.
  return m;
}

/** "00:14" from milliseconds. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** "03:02" from seconds, with a fraction as frames of a 30-frame second. */
function timecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  const frac = Math.round((s - whole) * 100);
  return `${String(whole).padStart(2, '0')}:${String(frac).padStart(2, '0')}`;
}

/** The elapsed time of the run in flight, ticking once a second. */

/** A clock that ticks once a second while `on`; the ledger and the elapsed time read it. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(performance.now());
    const id = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/** The playhead, sampled ten times a second while a result is on screen. */
function usePlayhead(on: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const id = window.setInterval(() => setSec(playheadSeconds()), 100);
    return () => window.clearInterval(id);
  }, [on]);
  return sec;
}

/** Called at render time: `t()` must not run at module scope. */
function axisLabels(): Record<(typeof CRITIQUE_AXES)[number], string> {
  return {
    contrast: t('aiChat.axis.contrast', 'Contrast'),
    hierarchy: t('aiChat.axis.hierarchy', 'Hierarchy'),
    rhythm: t('aiChat.axis.rhythm', 'Rhythm'),
    novelty: t('aiChat.axis.novelty', 'Novelty'),
    brief: t('aiChat.axis.brief', 'Brief'),
  };
}

/**
 * A translated sentence with one value drawn in bold: the template is resolved
 * with a marker in place of `{n}`, then split around it, so the sentence stays
 * whole for the translator and the number keeps its mono weight.
 */
const BOLD_MARK = '\u0001';
function boldSplit(sentence: string): [string, string] {
  const at = sentence.indexOf(BOLD_MARK);
  return at < 0 ? [sentence, ''] : [sentence.slice(0, at), sentence.slice(at + 1)];
}

/** The number of tool steps the active stage shows before folding the older ones. */
const STEPS_SHOWN = 3;

/** One concept as a row of the list: name, swatches, the idea, its language. */
function ConceptRow({ concept, selected, onSelect }: { concept: ConceptOption; selected: boolean; onSelect: () => void }): JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={selected} className={cn(styles.concept, selected && styles.conceptPicked)} onClick={onSelect}>
      <span className={styles.conceptHead}>
        <span className={styles.conceptName}>{concept.name}</span>
        {concept.swatches && concept.swatches.length > 0 && (
          <span className={styles.swatches} aria-hidden>
            {concept.swatches.map((hex, i) => <i key={i} style={{ background: hex }} />)}
          </span>
        )}
      </span>
      <span className={styles.conceptIdea}>{concept.idea}</span>
      <span className={styles.conceptMeta}>
        {concept.type && <span><em>{t('aiChat.concept.type', 'Type')}</em>{concept.type}</span>}
        {concept.motion && <span><em>{t('aiChat.concept.motion', 'Motion')}</em>{concept.motion}</span>}
        {concept.camera && <span><em>{t('aiChat.concept.camera', 'Camera')}</em>{concept.camera}</span>}
        {!concept.type && !concept.motion && <span><em>{t('aiChat.concept.frame', 'Frame')}</em>{t('aiChat.concept.frameValue', '{medium}-led, {value}', { medium: concept.medium, value: concept.value })}</span>}
      </span>
    </button>
  );
}

/**
 * The run ledger: every stage of the run as a row with its own clock, the
 * tool steps in flight under the active stage, the live filmstrip once the
 * build draws frames.
 */
function RunLedger({
  title, now, startedAt, stages, planItems, activity, streaming, liveFrames, onStop,
}: {
  title: string | null;
  now: number;
  startedAt: number | null;
  stages: PipelineStage[] | null;
  planItems: PlanItem[];
  activity: string;
  streaming: string;
  liveFrames: string[];
  onStop: () => void;
}): JSX.Element {
  const rows = stages ?? [];
  const activeIndex = rows.findIndex((s) => s.status === 'active');
  const doneSteps = planItems.filter((it) => it.status !== 'active');
  const activeStep = planItems.find((it) => it.status === 'active');
  const failed = doneSteps.filter((it) => it.status === 'error').length;
  const recent = doneSteps.slice(-STEPS_SHOWN);
  const earlier = doneSteps.length - recent.length;
  const building = rows.some((s, i) => i >= 3 && s.status !== 'pending');
  const showFilm = liveFrames.some(Boolean) || (building && planItems.length > 0);
  const cells = liveFrames.length ? liveFrames : Array.from({ length: LIVE_FRAME_CELLS }, () => '');
  const working = streaming ? t('aiChat.run.writing', 'Writing') : activity || t('aiChat.run.working', 'Working');
  const earlierText = earlier === 1
    ? (failed > 0 ? t('aiChat.run.earlierOneFailed', '{n} earlier step · {failed} failed', { n: earlier, failed }) : t('aiChat.run.earlierOne', '{n} earlier step', { n: earlier }))
    : (failed > 0 ? t('aiChat.run.earlierOtherFailed', '{n} earlier steps · {failed} failed', { n: earlier, failed }) : t('aiChat.run.earlierOther', '{n} earlier steps', { n: earlier }));
  const [callsBefore, callsAfter] = boldSplit(planItems.length === 1
    ? t('aiChat.run.toolCallsOne', '{n} tool call', { n: BOLD_MARK })
    : t('aiChat.run.toolCallsOther', '{n} tool calls', { n: BOLD_MARK }));
  const steps = (
    <div className={styles.steps}>
      {earlier > 0 && <div className={cn(styles.step, styles.stepEarlier)}><span className={styles.stepMark} /><span className={styles.stepLabel}>{earlierText}</span></div>}
      {recent.map((it) => (
        <div key={it.id} className={cn(styles.step, it.status === 'error' && styles.stepError)}>
          <span className={cn(styles.stepMark, it.status === 'error' ? styles.stepMarkError : styles.stepMarkDone)}><Icon name={it.status === 'error' ? 'close' : 'check'} size="sm" /></span>
          <span className={styles.stepLabel}>{it.label}</span>
        </div>
      ))}
      <div className={cn(styles.step, styles.stepNow)}>
        <span className={cn(styles.stepMark, styles.stepMarkNow)} />
        <span className={styles.stepLabel}>{activeStep?.label ?? working}</span>
      </div>
    </div>
  );
  return (
    <section className={styles.run} aria-live="polite" aria-label={t('aiChat.run.label', 'Run')}>
      <div className={styles.runHead}>
        <span className={styles.runName}>{title ?? t('aiChat.run.working', 'Working')}</span>
        <span className={styles.runTime}>{startedAt === null ? '00:00' : clock(now - startedAt)}</span>
        <Button size="xs" variant="ghost" onClick={onStop}>{t('aiChat.run.stop', 'Stop')}</Button>
      </div>
      {rows.length > 0 ? (
        <ol className={styles.ledger}>
          {rows.map((s, i) => (
            <li key={s.label} className={styles.stage} data-status={s.status}>
              <span className={styles.stageMark}>{s.status === 'done' && <Icon name="check" size="sm" />}</span>
              <span className={styles.stageLabel}>{s.label}</span>
              <span className={styles.stageTime}>
                {s.status === 'done' && s.ms !== undefined ? clock(s.ms) : s.status === 'active' && s.startedAt !== undefined ? clock(now - s.startedAt) : ''}
              </span>
              {i === activeIndex && steps}
            </li>
          ))}
        </ol>
      ) : (
        steps
      )}
      {showFilm && (
        <div className={styles.film} aria-label={t('aiChat.run.framesSoFar', 'Frames so far')}>
          {cells.map((src, i) => (
            <span key={i} className={styles.filmCell}>{src ? <img src={src} alt="" /> : null}</span>
          ))}
        </div>
      )}
      <div className={styles.runFoot}>
        <span className={styles.runFootText}>{working}</span>
        <span>{callsBefore}<b className={styles.mono}>{planItems.length}</b>{callsAfter}</span>
      </div>
    </section>
  );
}

export function AiChatPanel(): JSX.Element {
  const {
    messages,
    busy,
    streaming,
    activity,
    pipelineStages,
    planItems,
    ready,
    conversations,
    activeConversationId,
    submit,
    cancel,
    newChat,
    openConversation,
    removeConversation,
    hasPendingTx,
    pendingChanges,
    acceptPending,
    discardPending,
    isManualMode,
    toggleManualMode,
    direction,
    setDirection,
    packs,
    filmstrip,
    runStartedAt,
    runTitle,
    liveFrames,
    concepts,
    pickConcept,
    resultScores,
    resultConcept,
    anotherTake,
    lastApplied,
  } = useAiChatContext();

  const [value, setValue] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [allBriefs, setAllBriefs] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [canvasSnapshot, setCanvasSnapshot] = useState<string | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [conceptPick, setConceptPick] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const now = useNow(busy);
  const playhead = usePlayhead(!!hasPendingTx);

  // Provider + model selection (the line under the composer).
  const aiProvider = useAiProviderStore((s) => s.provider);
  const setAiProvider = useAiProviderStore((s) => s.setProvider);
  const aiModels = useAiProviderStore((s) => s.models);
  const setAiModel = useAiProviderStore((s) => s.setModel);
  const aiStatus = useAiProviderStore((s) => s.status);
  const aiMotion = useAiProviderStore((s) => s.motion);
  // False until a live /ai/keys answer has landed this session: the "connect
  // a provider" banner stays off the screen while the answer is in flight.
  const aiVerified = useAiProviderStore((s) => s.verified);
  const modelsFor = useAiProviderStore((s) => s.modelsFor);

  const providerReady = (id: GatewayProviderId): boolean =>
    id === 'motion' ? !!aiMotion?.present : !!aiStatus?.[id as AiProviderId]?.present;

  /** Whether the account has ANY usable provider, not just the selected one. */
  const anyProviderReady = !!aiMotion?.present || PROVIDER_OPTIONS.some((p) => providerReady(p.id));

  /** Which menu is open: a composer chip, the model, the review setting. */
  const [openMenu, setOpenMenu] = useState<'mode' | 'look' | 'shape' | 'variants' | 'review' | 'model' | null>(null);
  /** The generative mode the next run takes: the user's pick, else the default. */
  const mode = direction.mode ?? authorModeDefault();
  const composerRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  // Every menu renders INSIDE its trigger, and every trigger is inside the
  // composer: one ref covers them all. A click on another trigger is "inside"
  // (its own onClick swaps which menu is open); anything else closes.
  useDismissOnOutside(openMenu !== null, [composerRef], closeMenu);
  const toggleMenu = (m: NonNullable<typeof openMenu>) => (): void => setOpenMenu((c) => (c === m ? null : m));

  const dropdownValue =
    aiProvider === 'motion' ? 'motion' : `${aiProvider}:${aiModels[aiProvider] || modelsFor(aiProvider)[0] || ''}`;

  const onChangeModel = (val: string): void => {
    if (val === 'motion') {
      setAiProvider('motion');
      return;
    }
    const [p, m] = val.split(':');
    if (p && m) {
      setAiProvider(p as GatewayProviderId);
      setAiModel(p as AiProviderId, m);
    }
  };

  // Auto-scroll the thread as content streams in.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, planItems, pipelineStages, hasPendingTx, concepts, liveFrames]);

  // A fresh concept stage starts on its first card.
  useEffect(() => { setConceptPick(0); }, [concepts]);

  // The brief grows with its text, to six lines; a sent brief shrinks back.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 17;
    const max = line * 6;
    const h = Math.max(line * 2, Math.min(el.scrollHeight, max));
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  // Capture a canvas snapshot when a preview transaction opens.
  useEffect(() => {
    if (!hasPendingTx) {
      setCanvasSnapshot(null);
      setIsPlayingPreview(false);
      return undefined;
    }
    // The engine's still of the composition at the playhead. A short wait
    // lets the transaction's edits land first.
    let cancelled = false;
    let url: string | null = null;
    const timer = setTimeout(() => {
      const comp = activeCompIdNow();
      if (!comp) return;
      void engineCompStill(comp, playheadSeconds(), 480)
        .then((blob) => {
          if (cancelled || !blob) return;
          url = URL.createObjectURL(blob);
          setCanvasSnapshot(url);
        })
        .catch(() => { /* no still — the card shows without a snapshot */ });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [hasPendingTx]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const img = await processImageFile(f);
      if (img) setPendingImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, img]));
    }
  }, []);

  const send = useCallback(() => {
    if (busy) return;
    const text = value.trim();
    if (!text && !pendingImages.length) return;
    setValue('');
    const imgs = pendingImages;
    setPendingImages([]);
    void submit(text, imgs.length ? imgs : undefined);
  }, [busy, value, pendingImages, submit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const togglePlayPreview = (): void => {
    try {
      if (isTransportPlaying()) {
        pauseTransport();
        setIsPlayingPreview(false);
      } else {
        goToStart();
        playTransport();
        setIsPlayingPreview(true);
      }
    } catch {
      /* timeline not booted yet */
    }
  };

  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return t('aiChat.history.now', 'now');
    if (diff < 3_600_000) return t('aiChat.history.minutesAgo', '{n}m ago', { n: Math.floor(diff / 60_000) });
    if (diff < 86_400_000) return t('aiChat.history.hoursAgo', '{n}h ago', { n: Math.floor(diff / 3_600_000) });
    return d.toLocaleDateString();
  };

  const duration = settingsDurationSeconds(activeCompSettingsNow(), DEFAULT_COMPOSITION.durationSeconds);
  const showRun = busy && !concepts && (pipelineStages !== null || planItems.length > 0 || !!activity);
  const allStartingBriefs = startingBriefs();
  const briefsShown = allBriefs ? allStartingBriefs : allStartingBriefs.slice(0, BRIEFS_SHOWN);
  const lookLabel = packs.find((pk) => pk.id === direction.lookPackId)?.displayName ?? t('aiChat.look.propose', 'Propose');
  const shapeSet = direction.energy !== undefined || !!direction.totalDurationMs || !!direction.accent;
  const shapeLabel = direction.totalDurationMs ? `${Math.round(direction.totalDurationMs / 1000)} s` : direction.energy !== undefined ? t('aiChat.shape.energyValue', 'Energy {n}', { n: Math.round(direction.energy * 100) }) : null;
  const AXIS_LABEL = axisLabels();
  const canSend = busy || !!value.trim() || pendingImages.length > 0;

  return (
    <div className={styles.root}>
      {/* ── The strip: Assistant / History, new chat ───────────────── */}
      <div className={styles.strip} role="tablist" aria-label={t('aiChat.strip.assistant', 'Assistant')}>
        <button type="button" role="tab" aria-selected={!showHistory} className={cn(styles.stripTab, !showHistory && styles.stripTabActive)} onClick={() => setShowHistory(false)}>
          {t('aiChat.strip.assistant', 'Assistant')}
        </button>
        <button type="button" role="tab" aria-selected={showHistory} className={cn(styles.stripTab, showHistory && styles.stripTabActive)} onClick={() => setShowHistory(true)}>
          {t('aiChat.strip.history', 'History')}
        </button>
        <span className={styles.stripSpacer} />
        {busy && <span className={styles.stripLive} title={t('aiChat.strip.running', 'A run is in progress')} aria-hidden />}
        <button
          type="button"
          className={styles.stripButton}
          title={t('aiChat.strip.newChat', 'New chat')}
          aria-label={t('aiChat.strip.newChat', 'New chat')}
          onClick={() => {
            setShowHistory(false);
            newChat();
          }}
        >
          <Icon name="plus" size="sm" />
        </button>
      </div>

      {showHistory ? (
        /* ── History list ─────────────────────────────────────────── */
        <div className={styles.history}>
          {conversations.length === 0 && <div className={styles.quiet}>{t('aiChat.history.empty', 'No conversations yet.')}</div>}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={cn(styles.historyRow, c.id === activeConversationId && styles.historyRowActive)}
              onClick={() => {
                setShowHistory(false);
                void openConversation(c.id);
              }}
            >
              <span className={styles.historyTitle}>{c.title || t('aiChat.history.untitled', 'Untitled chat')}</span>
              <span className={styles.historyTime}>{formatTime(c.updatedAt)}</span>
              <button
                type="button"
                className={styles.stripButton}
                title={t('aiChat.history.delete', 'Delete')}
                aria-label={t('aiChat.history.deleteLabel', 'Delete conversation')}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeConversation(c.id);
                }}
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        /* ── Thread ───────────────────────────────────────────────── */
        <div className={styles.thread} ref={threadRef}>
          {!ready && aiVerified && (
            <div className={styles.keyBanner}>
              {anyProviderReady ? (
                <>{t('aiChat.banner.pickProvider', 'Pick a connected provider in the model menu below to start.')}</>
              ) : (
                <>
                  {t('aiChat.banner.connect', 'Connect an AI provider to start.')}{' '}
                  <button type="button" className={styles.keyBannerLink} onClick={() => openAiSettings()}>
                    {t('aiChat.banner.openSettings', 'Open AI settings →')}
                  </button>
                </>
              )}
            </div>
          )}

          {messages.length === 0 && ready && (
            <>
              <p className={styles.hello}>
                {t('aiChat.hello.lead', 'Describe the piece.')} <b>{t('aiChat.hello.body', 'Three concepts come back; pick one and it is built and shown frame by frame.')}</b>
              </p>
              <div className={styles.section}>
                <span>{t('aiChat.briefs.heading', 'Start from a brief')}</span>
                <button type="button" className={styles.sectionLink} onClick={() => setAllBriefs((v) => !v)}>
                  {allBriefs ? t('aiChat.briefs.fewer', 'Fewer') : t('aiChat.briefs.all', 'All {n}', { n: allStartingBriefs.length })}
                </button>
              </div>
              <div className={styles.list} role="list">
                {briefsShown.map((b) => (
                  <button key={b.id} type="button" role="listitem" className={styles.brief} onClick={() => void submit(b.prompt)} title={b.prompt}>
                    <span className={styles.swatches} aria-hidden>
                      {b.swatches.map((hex, i) => <i key={i} style={{ background: hex }} />)}
                    </span>
                    <span className={styles.briefText}>
                      <span className={styles.briefTitle}>{b.title}</span>
                      <span className={styles.briefBlurb}>{b.blurb}</span>
                    </span>
                    <span className={styles.briefLen}>{b.seconds}<em>s</em></span>
                  </button>
                ))}
              </div>
            </>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <blockquote key={i} className={styles.userMsg}>
                {m.images && m.images.length > 0 && (
                  <span className={styles.msgThumbs}>
                    {m.images.map((src, j) => <img key={j} src={src} className={styles.msgThumb} alt="" />)}
                  </span>
                )}
                {m.text}
              </blockquote>
            ) : (
              <div key={i} className={cn(styles.assistantMsg, m.error && styles.errorMsg)}>
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            ),
          )}

          {/* The concept stage: three directions, the user's pick. */}
          {concepts && (
            <section className={styles.conceptsBlock} aria-label={t('aiChat.concepts.label', 'Concepts')}>
              <p className={styles.assistantMsg}>
                {concepts.round === 0 ? t('aiChat.concepts.first', 'Three directions.') : t('aiChat.concepts.more', 'Three more.')} {t('aiChat.concepts.explain', 'Each has its own palette, type and motion language, and none repeats what was made here before.')}
              </p>
              <div className={styles.list} role="radiogroup" aria-label={t('aiChat.concepts.label', 'Concepts')}>
                {concepts.concepts.map((c, i) => (
                  <ConceptRow key={`${concepts.round}-${i}`} concept={c} selected={conceptPick === i} onSelect={() => setConceptPick(i)} />
                ))}
              </div>
              <div className={styles.row}>
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={concepts.concepts[conceptPick]?.name ? t('aiChat.concepts.buildNamed', 'Build {name}', { name: concepts.concepts[conceptPick]?.name ?? '' }) : t('aiChat.concepts.buildPick', 'Build the pick')}
                  title={concepts.concepts[conceptPick]?.name ? t('aiChat.concepts.buildNamed', 'Build {name}', { name: concepts.concepts[conceptPick]?.name ?? '' }) : t('aiChat.concepts.buildPick', 'Build the pick')}
                  onClick={() => pickConcept({ kind: 'pick', index: conceptPick })}
                >
                  {t('aiChat.concepts.build', 'Build')}
                </Button>
                <Button size="sm" onClick={() => pickConcept({ kind: 'more' })} disabled={concepts.round >= 2} title={concepts.round >= 2 ? t('aiChat.concepts.roundLimit', 'Three rounds is the limit for one brief') : t('aiChat.concepts.freshTitle', 'Three fresh directions')}>
                  {t('aiChat.concepts.threeMore', 'Three more')}
                </Button>
                <span className={styles.spacer} />
                <Button size="sm" variant="ghost" onClick={() => pickConcept({ kind: 'surprise' })}>
                  {t('aiChat.concepts.surprise', 'Surprise me')}
                </Button>
              </div>
            </section>
          )}

          {showRun && (
            <RunLedger
              title={runTitle}
              now={now}
              startedAt={runStartedAt ?? null}
              stages={pipelineStages}
              planItems={planItems}
              activity={activity}
              streaming={streaming}
              liveFrames={liveFrames}
              onStop={cancel}
            />
          )}

          {busy && streaming && (
            <div className={styles.assistantMsg}>
              <ReactMarkdown>{streaming}</ReactMarkdown>
            </div>
          )}

          {/* The result: the still, a scrubber, the scores, Apply / Another take / Decline. */}
          {hasPendingTx && (
            <section className={styles.result} aria-label={t('aiChat.result.label', 'Result')}>
              <div className={styles.resultFrame}>
                {canvasSnapshot ? <img src={canvasSnapshot} alt={t('aiChat.result.preview', 'Result preview')} /> : <div className={styles.resultEmpty}>{t('aiChat.result.onCanvas', 'Preview on canvas')}</div>}
              </div>
              {filmstrip.length > 1 && (
                <div className={styles.filmstrip}>
                  {filmstrip.map((src, i) => <img key={i} src={src} alt={t('aiChat.result.frame', 'Frame {n}', { n: i + 1 })} />)}
                </div>
              )}
              <div className={styles.scrub}>
                <button type="button" className={styles.scrubPlay} title={isPlayingPreview ? t('aiChat.result.pause', 'Pause') : t('aiChat.result.play', 'Play preview')} aria-label={isPlayingPreview ? t('aiChat.result.pause', 'Pause') : t('aiChat.result.play', 'Play preview')} onClick={togglePlayPreview}>
                  <Icon name={isPlayingPreview ? 'pause' : 'play'} size="sm" />
                </button>
                <div
                  className={styles.scrubTrack}
                  role="slider"
                  aria-label={t('aiChat.result.time', 'Preview time')}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration * 100) / 100}
                  aria-valuenow={Math.round(Math.min(playhead, duration) * 100) / 100}
                  tabIndex={0}
                  onPointerDown={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const f = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
                    try { seekPlayhead(f * duration); } catch { /* timeline not booted yet */ }
                  }}
                >
                  <i style={{ width: `${duration > 0 ? Math.min(100, (playhead / duration) * 100) : 0}%` }} />
                </div>
                <span className={styles.mono}>{timecode(playhead)} / {timecode(duration)}</span>
              </div>
              {resultScores && (
                <div className={styles.scores} aria-label={t('aiChat.result.scores', 'Review scores')}>
                  {CRITIQUE_AXES.map((a) => (
                    <span key={a} className={styles.score} data-low={resultScores[a] < 7 || undefined}>
                      <em>{AXIS_LABEL[a]}</em>
                      <b>{resultScores[a]}</b>
                      <i style={{ width: `${Math.max(0, Math.min(10, resultScores[a])) * 10}%` }} />
                    </span>
                  ))}
                </div>
              )}
              <div className={styles.resultActions}>
                <Button size="sm" variant="primary" onClick={acceptPending}>{t('aiChat.result.apply', 'Apply')}</Button>
                <Button size="sm" onClick={anotherTake} title={resultConcept ? t('aiChat.result.anotherTakeNamed', 'Build the brief again on a concept other than {name}', { name: resultConcept.name }) : t('aiChat.result.anotherTakeTitle', 'Build the brief again on another concept')}>
                  {t('aiChat.result.anotherTake', 'Another take')}
                </Button>
                <span className={styles.spacer} />
                <Button size="sm" variant="ghost" onClick={discardPending}>{t('aiChat.result.decline', 'Decline')}</Button>
              </div>
              {pendingChanges.length > 0 && (() => {
                const [before, after] = boldSplit(pendingChanges.length === 1
                  ? t('aiChat.result.pendingOne', '{n} change pending · one undo step', { n: BOLD_MARK })
                  : t('aiChat.result.pendingOther', '{n} changes pending · one undo step', { n: BOLD_MARK }));
                return <div className={styles.resultMeta}>{before}<b className={styles.mono}>{pendingChanges.length}</b>{after}</div>;
              })()}
            </section>
          )}

          {!busy && !hasPendingTx && lastApplied && (() => {
            const one = lastApplied.changes === 1;
            const sentence = lastApplied.title
              ? (one
                ? t('aiChat.applied.titledOne', 'Applied “{title}” as one undo step · {n} change · Edit ▸ Undo takes it back', { title: lastApplied.title, n: BOLD_MARK })
                : t('aiChat.applied.titledOther', 'Applied “{title}” as one undo step · {n} changes · Edit ▸ Undo takes it back', { title: lastApplied.title, n: BOLD_MARK }))
              : (one
                ? t('aiChat.applied.one', 'Applied as one undo step · {n} change · Edit ▸ Undo takes it back', { n: BOLD_MARK })
                : t('aiChat.applied.other', 'Applied as one undo step · {n} changes · Edit ▸ Undo takes it back', { n: BOLD_MARK }));
            const [before, after] = boldSplit(sentence);
            return (
              <div className={styles.applied}>
                {before}<b className={styles.mono}>{lastApplied.changes}</b>{after}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Composer ─────────────────────────────────────────────────── */}
      {!showHistory && (
        <div className={styles.composer} ref={composerRef}>
          <div className={styles.composerBox}>
            {pendingImages.length > 0 && (
              <div className={styles.attachStrip}>
                {pendingImages.map((img, i) => (
                  <span key={i} className={styles.attachThumbWrap}>
                    <img src={img.dataUrl} className={styles.attachThumb} alt="" />
                    <button
                      type="button"
                      className={styles.attachRemove}
                      aria-label={t('aiChat.composer.removeImage', 'Remove image')}
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Icon name="close" size="sm" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className={styles.composerMain}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              placeholder={
                ready || !aiVerified
                  ? t('aiChat.composer.placeholder', 'Describe the piece: subject, length, tone, the one thing that must land…')
                  : anyProviderReady
                    ? t('aiChat.composer.pickProvider', 'Pick a connected provider below')
                    : t('aiChat.composer.connectFirst', 'Connect an AI provider first')
              }
              value={value}
              rows={2}
              disabled={busy}
              aria-label={t('aiChat.composer.brief', 'Brief')}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
                if (files.length) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
            />
            <button
              type="button"
              className={cn(styles.send, busy && styles.sendStop)}
              title={busy ? t('aiChat.run.stop', 'Stop') : t('aiChat.composer.sendTitle', 'Send (Enter)')}
              aria-label={busy ? t('aiChat.run.stop', 'Stop') : t('aiChat.composer.send', 'Send')}
              onClick={busy ? cancel : send}
              disabled={!canSend}
            >
              <Icon name={busy ? 'stop' : 'arrow-up'} size="sm" />
            </button>
            </div>
            <div className={styles.composerBar}>
              <IconButton size="sm" title={t('aiChat.composer.attach', 'Attach a reference image')} aria-label={t('aiChat.composer.attach', 'Attach a reference image')} onClick={() => fileRef.current?.click()}>
                <Icon name="image" size="sm" />
              </IconButton>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />

              {/* Mode first: it decides what the other chips mean. In Author mode
                  the model writes the composition and a pinned look becomes a
                  mood for it; in Library mode the caster casts from the libraries. */}
              <div
                className={cn(styles.chip, direction.mode && styles.chipSet, openMenu === 'mode' && styles.chipOpen)}
                title={t('aiChat.mode.title', 'Author: the model proposes concepts, designs and animates the whole piece, then reviews and revises it. Library: picks from hand-made templates and techniques.')}
                data-testid="ai-mode-chip"
                onClick={toggleMenu('mode')}
              >
                <span className={styles.chipKey}>{t('aiChat.mode.key', 'Mode')}</span>
                <span className={styles.chipValue}>{mode === 'author' ? t('aiChat.mode.author', 'Author') : t('aiChat.mode.library', 'Library')}</span>
                <Icon name="chevron-down" size="sm" className={styles.chevron} />
                {openMenu === 'mode' && (
                  <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
                    <div className={styles.popoverHeader}>{t('aiChat.mode.header', 'How the piece is made')}</div>
                    {([
                      ['author', t('aiChat.mode.author', 'Author'), t('aiChat.mode.authorIntent', 'Proposes three concepts, designs the whole composition in the engine\'s own vocabulary — 3D, effects, type, motion — then looks at the frames and revises what fails.')],
                      ['library', t('aiChat.mode.library', 'Library'), t('aiChat.mode.libraryIntent', 'Casts layouts and techniques from the hand-made libraries. Faster and predictable; the range is the library\'s.')],
                    ] as const).map(([id, label, intent]) => (
                      <button
                        key={id}
                        type="button"
                        className={cn(styles.option, mode === id && styles.optionActive)}
                        onClick={() => { setDirection({ mode: id }); setOpenMenu(null); }}
                      >
                        <span>{label}</span>
                        <span className={styles.optionIntent}>{intent}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div
                className={cn(styles.chip, direction.lookPackId && styles.chipSet, openMenu === 'look' && styles.chipOpen)}
                title={t('aiChat.look.title', 'Look: Propose lets the concept stage decide; a pack fixes palette, type, shape language, pacing and motion vocabulary')}
                onClick={toggleMenu('look')}
              >
                <span className={styles.chipKey}>{t('aiChat.look.key', 'Look')}</span>
                <span className={styles.chipValue}>{lookLabel}</span>
                <Icon name="chevron-down" size="sm" className={styles.chevron} />
                {openMenu === 'look' && (
                  <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
                    <div className={styles.popoverHeader}>{t('aiChat.look.key', 'Look')}</div>
                    <button
                      type="button"
                      className={cn(styles.option, !direction.lookPackId && styles.optionActive)}
                      onClick={() => { setDirection({ lookPackId: undefined }); setOpenMenu(null); }}
                    >
                      <span>{t('aiChat.look.propose', 'Propose')}</span>
                      <span className={styles.optionIntent}>{t('aiChat.look.proposeIntent', 'Three concepts from the brief, each with its own palette, type and motion. Pick one.')}</span>
                    </button>
                    {packs.map((pk) => (
                      <button
                        key={pk.id}
                        type="button"
                        className={cn(styles.option, direction.lookPackId === pk.id && styles.optionActive)}
                        onClick={() => { setDirection({ lookPackId: pk.id }); setOpenMenu(null); }}
                      >
                        <span>{pk.displayName}</span>
                        <span className={styles.optionIntent}>{pk.intent}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div
                className={cn(styles.chip, shapeSet && styles.chipSet, openMenu === 'shape' && styles.chipOpen)}
                title={t('aiChat.shape.title', 'Energy, length and brand colour')}
                onClick={toggleMenu('shape')}
              >
                <span className={shapeLabel ? styles.chipKey : styles.chipValue}>{t('aiChat.shape.key', 'Shape')}</span>
                {shapeLabel && <span className={styles.chipValue}>{shapeLabel}</span>}
                {direction.accent && <i className={styles.chipDot} style={{ background: direction.accent }} aria-hidden />}
                <Icon name="chevron-down" size="sm" className={styles.chevron} />
                {openMenu === 'shape' && (
                  <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
                    <div className={styles.popoverHeader}>{t('aiChat.shape.energy', 'Energy')}</div>
                    <div className={styles.popoverRow}>
                      <RangeInput
                        className={styles.popoverRange}
                        min={0}
                        max={100}
                        aria-label={t('aiChat.shape.energy', 'Energy')}
                        value={Math.round((direction.energy ?? 0.5) * 100)}
                        onChange={(e) => setDirection({ energy: Number(e.target.value) / 100 })}
                      />
                      <span className={styles.popoverValue}>{direction.energy === undefined ? t('aiChat.shape.auto', 'auto') : direction.energy.toFixed(2)}</span>
                    </div>
                    <div className={styles.popoverHeader}>{t('aiChat.shape.length', 'Length')}</div>
                    <div className={styles.popoverRow}>
                      <RangeInput
                        className={styles.popoverRange}
                        min={4}
                        max={60}
                        aria-label={t('aiChat.shape.length', 'Length')}
                        value={Math.round((direction.totalDurationMs ?? 12000) / 1000)}
                        onChange={(e) => setDirection({ totalDurationMs: Number(e.target.value) * 1000 })}
                      />
                      <span className={styles.popoverValue}>{direction.totalDurationMs ? `${Math.round(direction.totalDurationMs / 1000)} s` : t('aiChat.shape.auto', 'auto')}</span>
                    </div>
                    <div className={styles.popoverHeader}>{t('aiChat.shape.brandColour', 'Brand colour')}</div>
                    <div className={styles.popoverRow}>
                      <input type="color" aria-label={t('aiChat.shape.brandColour', 'Brand colour')} value={direction.accent ?? '#2b7eff'} onChange={(e) => setDirection({ accent: e.target.value })} />
                      <span className={styles.popoverValue}>{direction.accent ?? t('aiChat.shape.auto', 'auto')}</span>
                    </div>
                    <button
                      type="button"
                      className={styles.option}
                      onClick={() => {
                        setDirection({ energy: undefined, totalDurationMs: undefined, accent: undefined });
                        setOpenMenu(null);
                      }}
                    >
                      <span>{t('aiChat.shape.reset', 'Reset to automatic')}</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Alternatives are re-seeded caster emits; an authored piece has none. */}
              {mode === 'library' && (
                <div
                  className={cn(styles.chip, direction.variants > 1 && styles.chipSet, openMenu === 'variants' && styles.chipOpen)}
                  title={t('aiChat.variants.title', 'Emit several alternatives and rank them — costs no extra model calls')}
                  onClick={toggleMenu('variants')}
                >
                  <span className={styles.chipValue}>{direction.variants > 1 ? t('aiChat.variants.directionsOther', '{n} directions', { n: direction.variants }) : t('aiChat.variants.directionsOne', '1 direction')}</span>
                  <Icon name="chevron-down" size="sm" className={styles.chevron} />
                  {openMenu === 'variants' && (
                    <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.popoverHeader}>{t('aiChat.variants.header', 'Alternatives')}</div>
                      {[1, 2, 3, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          className={cn(styles.option, direction.variants === n && styles.optionActive)}
                          onClick={() => { setDirection({ variants: n }); setOpenMenu(null); }}
                        >
                          <span>{n === 1 ? t('aiChat.variants.one', 'One') : t('aiChat.variants.alternatives', '{n} alternatives', { n })}</span>
                          <span className={styles.optionIntent}>
                            {n === 1 ? t('aiChat.variants.oneIntent', 'Emit a single piece.') : t('aiChat.variants.manyIntent', 'Same brief and casting, re-seeded. No extra model calls — the strongest by the linters is applied.')}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>

          {/* Session settings, not part of the brief: the model, and when a result lands. */}
          <div className={styles.foot}>
            <div
              className={cn(styles.footMenu, openMenu === 'model' && styles.footMenuOpen)}
              title={t('aiChat.model.title', 'AI model: {model}', { model: getModelLabel(dropdownValue) })}
              onClick={toggleMenu('model')}
            >
              {renderProviderIcon(aiProvider)}
              <span className={styles.footLabel}>{getModelLabel(dropdownValue)}</span>
              <Icon name="chevron-down" size="sm" className={styles.chevron} />
              {openMenu === 'model' && (
                <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.popoverHeader}>{t('aiChat.model.header', 'Model')}</div>
                  {PROVIDER_OPTIONS.map((p) => {
                    const pr = providerReady(p.id);
                    const suggestions = modelsFor(p.id as AiProviderId);
                    return (
                      <div key={p.id} className={styles.popoverGroup}>
                        <div className={styles.groupLabel}>
                          {p.label} {!pr && <span className={styles.noKeyTag}>{t('aiChat.model.noKey', 'no key')}</span>}
                        </div>
                        {suggestions.map((m) => {
                          const val = `${p.id}:${m}`;
                          const active = dropdownValue === val;
                          return (
                            <button
                              key={val}
                              type="button"
                              className={cn(styles.option, styles.optionRow, active && styles.optionActive)}
                              disabled={!pr}
                              onClick={() => {
                                onChangeModel(val);
                                setOpenMenu(null);
                              }}
                            >
                              <span>{getModelLabel(val)}</span>
                              {active && <Icon name="check" size="sm" />}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <span className={styles.spacer} />
            <div
              className={cn(styles.footMenu, openMenu === 'review' && styles.footMenuOpen)}
              title={isManualMode ? t('aiChat.review.manualTitle', 'The result waits on the canvas for Apply') : t('aiChat.review.autoTitle', 'The result is applied when the run finishes, as one undo step')}
              onClick={toggleMenu('review')}
            >
              <span className={styles.footLabel}>{isManualMode ? t('aiChat.review.manual', 'Review first') : t('aiChat.review.auto', 'Apply as it lands')}</span>
              <Icon name="chevron-down" size="sm" className={styles.chevron} />
              {openMenu === 'review' && (
                <div className={cn(styles.popover, styles.popoverRight)} onClick={(e) => e.stopPropagation()}>
                  <div className={styles.popoverHeader}>{t('aiChat.review.header', 'When it lands')}</div>
                  <button type="button" className={cn(styles.option, isManualMode && styles.optionActive)} onClick={() => { toggleManualMode(true); setOpenMenu(null); }}>
                    <span>{t('aiChat.review.manual', 'Review first')}</span>
                    <span className={styles.optionIntent}>{t('aiChat.review.manualIntent', 'The result waits on the canvas with Apply, Another take and Decline.')}</span>
                  </button>
                  <button type="button" className={cn(styles.option, !isManualMode && styles.optionActive)} onClick={() => { toggleManualMode(false); setOpenMenu(null); }}>
                    <span>{t('aiChat.review.auto', 'Apply as it lands')}</span>
                    <span className={styles.optionIntent}>{t('aiChat.review.autoIntent', 'One undo step; Edit ▸ Undo takes it back.')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AiChatPanel;
