/**
 * AiChatPanel — the AI assistant, docked as a left-sidebar tab.
 *
 * Layout (top → bottom): header (new chat / history), scrolling thread
 * (messages, live plan checklist, result preview with Apply/Decline), and a
 * composer pinned at the bottom with the prompt textarea and a provider/model
 * picker row — the ChatGPT/Claude-style arrangement.
 *
 * All chat state lives in AiChatContext (hoisted above the dock tree), so
 * switching sidebar tabs mid-run neither cancels the run nor rolls back a
 * pending preview transaction.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { Icon } from '@components/Icon';
import { useAiProviderStore, MODEL_SUGGESTIONS } from '@stores/aiProviderStore';
import type { GatewayProviderId, AiProviderId } from '@core/api/client';
import { processImageFile, type PendingImage } from '@core/ai/imageAttachment';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAiChatContext } from './AiChatContext';
import styles from './AiChatPanel.module.css';

/** Providers offered in the picker, in display order. */
const PROVIDER_OPTIONS: { id: GatewayProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'motion', label: 'Motion AI' },
];

/** Fixed preview snapshot size (16:9), independent of sidebar width. */
const PREVIEW_W = 240;
const PREVIEW_H = 135;

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
          <path d="M22.28 9.82a5.984 5.984 0 0 0-.52-4.91 6.046 6.046 0 0 0-6.51-2.9 6.065 6.065 0 0 0-4.73-2.01 6.015 6.015 0 0 0-5.76 4.19 6.05 6.05 0 0 0-4.3 2.92 5.986 5.986 0 0 0 .74 6.55 5.984 5.984 0 0 0 .52 4.91 6.046 6.046 0 0 0 6.51 2.9 6.06 6.06 0 0 0 4.73 2.01 6.014 6.014 0 0 0 5.76-4.19 6.05 6.05 0 0 0 4.3-2.92 5.985 5.985 0 0 0-.74-6.55Zm-9.52 11.66a4.47 4.47 0 0 1-2.61-.84c.03-.02.09-.05.13-.08l3.41-1.97a.78.78 0 0 0 .39-.68v-4.8l1.44.83a.74.74 0 0 0 .38.1v4.06a4.502 4.502 0 0 1-3.14 3.38Zm-7.39-3.26a4.48 4.48 0 0 1-.58-2.67c.03.02.08.05.13.08l3.41 1.97a.78.78 0 0 0 .78 0l4.16-2.4v1.67a.77.77 0 0 0 .19.55l-3.52 2.03a4.505 4.505 0 0 1-4.57-.23Zm-1.46-8.03a4.48 4.48 0 0 1 2.03-1.83v4.11a.76.76 0 0 0 .39.67l4.16 2.4-1.44.83a.78.78 0 0 0-.39.68v4.06a4.5 4.5 0 0 1-4.75-1.49 4.46 4.46 0 0 1 0-9.43Zm14.62 3.26-4.16-2.4 1.44-.83a.78.78 0 0 0 .39-.68V5.48a4.5 4.5 0 0 1 4.75 1.49 4.46 4.46 0 0 1 0 9.43 4.48 4.48 0 0 1-2.03 1.83V14.1a.76.76 0 0 0-.39-.67Zm1.46-4.77c-.03-.02-.08-.05-.13-.08l-3.41-1.97a.78.78 0 0 0-.78 0l-4.16 2.4V7.59a.77.77 0 0 0-.19-.55l3.52-2.03a4.505 4.505 0 0 1 4.57.23 4.48 4.48 0 0 1 .58 2.67Zm-8.49-5.18a4.47 4.47 0 0 1 2.61.84c-.03.02-.09.05-.13.08l-3.41 1.97a.78.78 0 0 0-.39.68v4.8l-1.44-.83a.74.74 0 0 0-.38-.1V4.93a4.502 4.502 0 0 1 3.14-3.38Zm-1.5 6.27 2.5-1.44 2.5 1.44v2.89l-2.5 1.44-2.5-1.44V9.52Z" />
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

function getModelLabel(val: string): string {
  if (val === 'motion') return 'Motion AI';
  const [, m] = val.split(':');
  if (!m) return 'Select model';
  if (m.includes('gemini-1.5-pro')) return 'Gemini 1.5 Pro';
  if (m.includes('gemini-1.5-flash')) return 'Gemini 1.5 Flash';
  if (m.includes('gemini-2.0-flash')) return 'Gemini 2.0 Flash';
  if (m.includes('gemini-3.5-flash')) return 'Gemini 3.5 Flash';
  if (m.includes('gemini-3.1-pro')) return 'Gemini 3.1 Pro';
  if (m.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet';
  if (m.includes('claude-3-7-sonnet')) return 'Claude 3.7 Sonnet';
  if (m.includes('claude-sonnet-5')) return 'Claude Sonnet 5';
  if (m.includes('claude-opus-4-8') || m.includes('opus-4-8')) return 'Claude Opus 4.8';
  if (m.includes('claude-haiku-4-5') || m.includes('haiku-4-5')) return 'Claude Haiku 4.5';
  if (m.includes('gpt-4o-mini')) return 'GPT-4o mini';
  if (m.includes('gpt-4o')) return 'GPT-4o';
  return m;
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
  } = useAiChatContext();

  const [value, setValue] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [canvasSnapshot, setCanvasSnapshot] = useState<string | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // Provider + model selection (bottom of the composer, like other AI apps).
  const aiProvider = useAiProviderStore((s) => s.provider);
  const setAiProvider = useAiProviderStore((s) => s.setProvider);
  const aiModels = useAiProviderStore((s) => s.models);
  const setAiModel = useAiProviderStore((s) => s.setModel);
  const aiStatus = useAiProviderStore((s) => s.status);
  const aiMotion = useAiProviderStore((s) => s.motion);

  const providerReady = (id: GatewayProviderId): boolean =>
    id === 'motion' ? !!aiMotion?.present : !!aiStatus?.[id as AiProviderId]?.present;

  const dropdownValue =
    aiProvider === 'motion'
      ? 'motion'
      : `${aiProvider}:${aiModels[aiProvider] || MODEL_SUGGESTIONS[aiProvider]?.[0] || ''}`;

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
  }, [messages, streaming, planItems, pipelineStages, hasPendingTx]);

  // Capture a canvas snapshot when a preview transaction opens.
  useEffect(() => {
    if (!hasPendingTx) {
      setCanvasSnapshot(null);
      setIsPlayingPreview(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        const cvs = document.querySelector('canvas');
        if (cvs) setCanvasSnapshot(cvs.toDataURL('image/png'));
      } catch {
        /* cross-origin/empty canvas — show the card without a snapshot */
      }
    }, 150);
    return () => clearTimeout(timer);
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
      const tc = getTimelineController();
      if (tc.isPlaying) {
        tc.pause();
        setIsPlayingPreview(false);
      } else {
        tc.goToStart();
        tc.play();
        setIsPlayingPreview(true);
      }
    } catch {
      /* timeline not booted yet */
    }
  };

  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  };

  const showPlan = (busy || hasPendingTx) && planItems.length > 0;

  return (
    <div className={styles.root}>
      {/* ── Header: title + new chat + history ─────────────────────── */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <Icon name="sparkles" size={13} /> Assistant
        </span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            title="New chat"
            onClick={() => {
              setShowHistory(false);
              newChat();
            }}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${showHistory ? styles.iconButtonActive : ''}`}
            title="Chat history"
            onClick={() => setShowHistory((v) => !v)}
          >
            <Icon name="history" size={14} />
          </button>
        </div>
      </div>

      {showHistory ? (
        /* ── History list ─────────────────────────────────────────── */
        <div className={styles.history}>
          {conversations.length === 0 && <div className={styles.emptyNote}>No conversations yet.</div>}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`${styles.historyRow} ${c.id === activeConversationId ? styles.historyRowActive : ''}`}
              onClick={() => {
                setShowHistory(false);
                void openConversation(c.id);
              }}
            >
              <span className={styles.historyTitle}>{c.title || 'Untitled chat'}</span>
              <span className={styles.historyTime}>{formatTime(c.updatedAt)}</span>
              <button
                type="button"
                className={styles.iconButton}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeConversation(c.id);
                }}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        /* ── Thread ───────────────────────────────────────────────── */
        <div className={styles.thread} ref={threadRef}>
          {!ready && (
            <div className={styles.keyBanner}>
              Connect an AI provider to start.{' '}
              <a href="#/dashboard?tab=settings">Open AI settings →</a>
            </div>
          )}
          {messages.length === 0 && ready && (
            <div className={styles.emptyNote}>
              Describe the motion video you want — I plan it, build it, review it, and show you a
              preview to apply or decline.
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className={styles.userMsg}>
                {m.images?.map((src, j) => (
                  <img key={j} src={src} className={styles.msgThumb} alt="" />
                ))}
                {m.text}
              </div>
            ) : (
              <div key={i} className={`${styles.assistantMsg} ${m.error ? styles.errorMsg : ''}`}>
                <ReactMarkdown>{m.text}</ReactMarkdown>
              </div>
            ),
          )}

          {/* Director pipeline stages (generative prompts). */}
          {busy && pipelineStages && (
            <div className={styles.planCard}>
              <div className={styles.planTitle}>Production plan</div>
              {pipelineStages.map((s, i) => (
                <div key={i} className={styles.planRow} data-status={s.status}>
                  <span className={styles.planMark}>
                    {s.status === 'done' ? <Icon name="check" size={11} /> : s.status === 'active' ? <span className={styles.spinner} /> : ''}
                  </span>
                  {s.label}
                </div>
              ))}
            </div>
          )}

          {/* Concrete build steps — each flips to ✓ as the tool completes. */}
          {showPlan && (
            <div className={styles.planCard}>
              <div className={styles.planTitle}>Build steps</div>
              {planItems.map((it) => (
                <div key={it.id} className={styles.planRow} data-status={it.status}>
                  <span className={styles.planMark}>
                    {it.status === 'done' ? (
                      <Icon name="check" size={11} />
                    ) : it.status === 'error' ? (
                      <Icon name="close" size={11} />
                    ) : (
                      <span className={styles.spinner} />
                    )}
                  </span>
                  {it.label}
                </div>
              ))}
            </div>
          )}

          {busy && streaming && (
            <div className={styles.assistantMsg}>
              <ReactMarkdown>{streaming}</ReactMarkdown>
            </div>
          )}
          {/* Always show a live "working" line while busy and no prose is
              streaming — so a tool-heavy turn (which emits no text) never looks
              frozen. The pipeline/build cards above show the detail. */}
          {busy && !streaming && (
            <div className={styles.activityRow}>
              <span className={styles.spinner} />
              <span className={styles.activityText}>{activity || 'Working'}…</span>
            </div>
          )}

          {/* Result preview: Apply commits the transaction, Decline rolls it back. */}
          {hasPendingTx && (
            <div className={styles.previewCard}>
              <div className={styles.previewHeader}>Result preview</div>
              <div className={styles.previewFrame} style={{ width: PREVIEW_W, height: PREVIEW_H }}>
                {canvasSnapshot ? (
                  <img src={canvasSnapshot} alt="Result preview" />
                ) : (
                  <div className={styles.previewEmpty}>Preview on canvas</div>
                )}
                <button
                  type="button"
                  className={styles.previewPlay}
                  title={isPlayingPreview ? 'Pause' : 'Play preview'}
                  onClick={togglePlayPreview}
                >
                  <Icon name={isPlayingPreview ? 'pause' : 'play'} size={14} />
                </button>
              </div>
              {pendingChanges.length > 0 && (
                <div className={styles.previewChanges}>
                  {pendingChanges.length} change{pendingChanges.length > 1 ? 's' : ''} pending
                </div>
              )}
              <div className={styles.previewActions}>
                <button type="button" className={styles.applyButton} onClick={acceptPending}>
                  <Icon name="check" size={13} /> Apply
                </button>
                <button type="button" className={styles.declineButton} onClick={discardPending}>
                  <Icon name="close" size={13} /> Decline
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Composer (Pill Container matching screenshot) ────────── */}
      {!showHistory && (
        <div className={styles.composer}>
          <div className={styles.composerPill}>
            {pendingImages.length > 0 && (
              <div className={styles.attachStrip}>
                {pendingImages.map((img, i) => (
                  <span key={i} className={styles.attachThumbWrap}>
                    <img src={img.dataUrl} className={styles.attachThumb} alt="" />
                    <button
                      type="button"
                      className={styles.attachRemove}
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Icon name="close" size={9} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              className={styles.textarea}
              placeholder={ready ? 'Create a cinematic trailer for my brand…' : 'Connect an AI provider first'}
              value={value}
              rows={2}
              disabled={busy}
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
            <div className={styles.composerControls}>
              <div className={styles.controlsLeft}>
                <button
                  type="button"
                  className={styles.plusBtn}
                  title="Attach reference image"
                  onClick={() => fileRef.current?.click()}
                >
                  <Icon name="plus" size={14} />
                </button>
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

                <div className={styles.modelPickerWrap} title={`AI Model: ${getModelLabel(dropdownValue)}`}>
                  {renderProviderIcon(aiProvider)}
                  <Icon name="chevron-down" size={9} className={styles.chevron} />
                  <select
                    className={styles.hiddenSelect}
                    value={dropdownValue}
                    onChange={(e) => onChangeModel(e.target.value)}
                    title="AI model"
                  >
                    {PROVIDER_OPTIONS.map((p) =>
                      p.id === 'motion' ? (
                        <option key="motion" value="motion" disabled={!providerReady('motion')}>
                          ✦ Motion AI{providerReady('motion') ? '' : ' · no key'}
                        </option>
                      ) : (
                        <optgroup key={p.id} label={`${p.label}${providerReady(p.id) ? '' : ' · no key'}`}>
                          {(MODEL_SUGGESTIONS[p.id as AiProviderId] ?? []).map((m) => (
                            <option key={`${p.id}:${m}`} value={`${p.id}:${m}`}>
                              {getModelLabel(`${p.id}:${m}`)}
                            </option>
                          ))}
                        </optgroup>
                      ),
                    )}
                  </select>
                </div>
              </div>

              <div className={styles.controlsRight}>
                <div
                  className={styles.modePickerWrap}
                  title={`Execution mode: ${isManualMode ? 'Manual (Review preview)' : 'Auto (Direct apply)'}`}
                >
                  <Icon name={isManualMode ? 'eye' : 'sparkles'} size={13} className={styles.modeIcon} />
                  <Icon name="chevron-down" size={9} className={styles.chevron} />
                  <select
                    className={styles.hiddenSelect}
                    value={isManualMode ? 'manual' : 'auto'}
                    onChange={(e) => toggleManualMode(e.target.value === 'manual')}
                  >
                    <option value="auto">✦ Auto (Direct apply)</option>
                    <option value="manual">👁 Manual (Review preview)</option>
                  </select>
                </div>
                <button
                  type="button"
                  className={styles.neonSendBtn}
                  title={busy ? 'Stop' : 'Send prompt'}
                  onClick={busy ? cancel : send}
                  disabled={!busy && !value.trim() && pendingImages.length === 0}
                >
                  <Icon name={busy ? 'stop' : 'arrow-up'} size={15} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AiChatPanel;
