/**
 * AI setup — lives in the Settings page, not a dialog.
 *
 * Two ways to power the assistant, presented as a choice:
 *   • Motion AI — our provider account, metered and billed to the user. No key
 *     to manage. (Disabled while in development; the server says so.)
 *   • Your own key — the user's OpenAI / Anthropic / Gemini account.
 *
 * A key is sent once to the backend gateway, stored encrypted against the
 * account, and used server-side when the assistant calls the provider. There is
 * no read path: what comes back is a masked hint, so this component never sees
 * a real key after saving one — and neither does any other client.
 *
 * **This file used to violate its own docstring.** `save()` mirrored the
 * plaintext key into `localStorage` and `refresh()` read it back and re-uploaded
 * it. That is removed; `core/api/purgeLocalKeys.ts` cleans up what earlier
 * builds wrote, and an ESLint rule now fails the build on any `localStorage`
 * write whose key name looks like a credential.
 *
 * Saving and removing go through `aiProviderStore`, not straight to `api`, so
 * that one place decides what a key change means for the assistant: refresh the
 * status, re-point the selection, and update the cross-launch cache. When this
 * component owned that logic, every other surface that changed a key (and the
 * assistant panel itself) saw a stale gate.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { isAuthenticated, type AiKeyStatus, type AiProviderId } from '@core/api/client';
import { useAiProviderStore } from '@stores/aiProviderStore';
import styles from './AiSettingsSection.module.css';

interface ProviderMeta {
  id: AiProviderId;
  label: string;
  /** Where a user actually gets a key — saves them a search. */
  href: string;
  placeholder: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', href: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', href: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  { id: 'gemini', label: 'Gemini (Google)', href: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza…' },
];

const EMPTY: AiKeyStatus = { present: false, hint: '' };

/**
 * Catch a key pasted into the wrong provider's box.
 *
 * The server stores any 8+ character string it is given, so a Claude key pasted
 * under OpenAI saves cleanly, marks OpenAI "Connected", and then fails on the
 * user's first prompt with an auth error from a provider they did not think
 * they were talking to. The prefixes here are unmistakable and stable enough to
 * be worth checking; anything unrecognised is allowed through, because a key
 * format we have not seen is far more likely to be new than wrong.
 */
/**
 * Which provider a key looks like it came from, or null for "no idea".
 *
 * Ordered most-specific-first: an Anthropic key also starts with `sk-`, so the
 * `sk-ant-` test has to run before the OpenAI one or every Claude key would be
 * classified as OpenAI.
 */
function classifyKey(key: string): AiProviderId | null {
  if (/^sk-ant-/.test(key)) return 'anthropic';
  if (/^AIza/.test(key)) return 'gemini';
  if (/^sk-/.test(key)) return 'openai';
  return null;
}

export function AiSettingsSection(): JSX.Element {
  const [drafts, setDrafts] = useState<Partial<Record<AiProviderId, string>>>({});
  const [busy, setBusy] = useState<AiProviderId | null>(null);
  const [error, setError] = useState<string>('');

  const provider = useAiProviderStore((s) => s.provider);
  const setProvider = useAiProviderStore((s) => s.setProvider);
  const models = useAiProviderStore((s) => s.models);
  const setModel = useAiProviderStore((s) => s.setModel);
  const modelsFor = useAiProviderStore((s) => s.modelsFor);
  // The store is the single copy of key state, so this panel and the assistant
  // can never disagree about which providers are connected. It used to hold its
  // own `useState` fetched separately, which is how "Connected" here and "no
  // key" in the chat could both be on screen at once.
  const status = useAiProviderStore((s) => s.status);
  const refresh = useAiProviderStore((s) => s.refreshStatus);
  const saveKey = useAiProviderStore((s) => s.saveKey);
  const clearKey = useAiProviderStore((s) => s.clearKey);

  const reload = useCallback(async () => {
    if (!isAuthenticated()) return;
    // The server is the ONLY source of key state. This used to also read a
    // plaintext `localStorage` mirror and re-upload from it — see
    // core/api/purgeLocalKeys.ts for why that is gone.
    await refresh({ force: true });
  }, [refresh]);

  useEffect(() => { void reload(); }, [reload]);

  if (!isAuthenticated()) {
    return (
      <div className={styles.section}>
        <p className={styles.intro}>
          Sign in to set up the assistant.
        </p>
      </div>
    );
  }

  const save = async (id: AiProviderId): Promise<void> => {
    const key = (drafts[id] ?? '').trim();
    if (!key) return;
    setError('');

    const looksLike = classifyKey(key);
    if (looksLike && looksLike !== id) {
      // Refused here rather than saved and discovered at the first prompt: the
      // server takes any string, so the mistake would surface as an auth error
      // from a provider the user did not think they were using.
      setError(
        `That looks like a ${PROVIDERS.find((p) => p.id === looksLike)?.label ?? looksLike} key. ` +
          `Paste it in that provider's field instead.`,
      );
      return;
    }

    setBusy(id);
    try {
      // The store uploads it, marks the provider connected, and selects it —
      // the selection matters, because a key saved for a provider nobody is
      // pointed at leaves the assistant saying "connect a provider".
      const res = await saveKey(id, key);
      if (!res.ok) {
        setError(
          res.reason === 'unavailable'
            ? 'The server cannot store keys right now (encryption is not configured). It has NOT been saved.'
            : res.reason === 'network'
              ? 'Could not reach the server to save the key.'
              : 'Could not save that key.',
        );
        return;
      }
      // NO local mirror. The key exists in this process only for the duration of
      // this call; the encrypted server store is the only copy that persists.
      // Drop the plaintext the moment it's handed off.
      setDrafts((d) => ({ ...d, [id]: '' }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: AiProviderId): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      const res = await clearKey(id);
      if (!res.ok) setError('Could not reach the server to remove the key.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.section}>
      <p className={styles.intro}>
        Connect your own AI API keys (Anthropic, OpenAI, or Gemini). Your prompts go straight to your provider account with no added fees.
      </p>

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.providers}>
        {PROVIDERS.map((p) => {
          const s = status?.[p.id] ?? EMPTY;
            const draft = drafts[p.id] ?? '';
            const isActive = provider === p.id;
            return (
              <div
                key={p.id}
                className={`${styles.row} ${s.present ? styles.rowConnected : ''} ${
                  isActive && s.present ? styles.rowOn : ''
                }`}
              >
                <div className={styles.rowInfo}>
                  <span className={styles.rowLabel}>
                    <Icon name={s.present ? 'lock' : 'keyframe'} size={14} className={s.present ? styles.lockIconSecure : styles.lockIconInactive} />
                    {p.label}
                  </span>
                  {s.present ? (
                    <span className={styles.hint} title="Encrypted at rest">
                      Connected · {s.hint || '••••'}
                    </span>
                  ) : (
                    <span className={styles.notConnectedHint}>Not configured</span>
                  )}
                </div>

                <div className={styles.rowRight}>
                  {s.present ? (
                    <>
                      <select
                        className={styles.select}
                        aria-label={`${p.label} model`}
                        value={models[p.id] ?? ''}
                        onChange={(e) => setModel(p.id, e.target.value)}
                      >
                        <option value="">Default Model</option>
                        {modelsFor(p.id).map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                      {isActive ? (
                        <span className={styles.activeMark}>
                          <span className={styles.greenDot} /> Active
                        </span>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => setProvider(p.id)}>
                          Use this
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" disabled={busy === p.id} onClick={() => void remove(p.id)}>
                        Remove
                      </Button>
                    </>
                  ) : (
                    <>
                      <input
                        type="password"
                        className={styles.input}
                        value={draft}
                        placeholder={p.placeholder}
                        aria-label={`${p.label} API key`}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void save(p.id); }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!draft.trim() || busy === p.id}
                        onClick={() => void save(p.id)}
                      >
                        Save
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          <p className={styles.links}>
            Your keys are stored encrypted on your Motion account and only used by our server to call
            the provider. Get a key: {PROVIDERS.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? ' · ' : ''}
                <a href={p.href} target="_blank" rel="noreferrer">{p.label.split(' ')[0]}</a>
              </span>
            ))}
          </p>
        </div>
    </div>
  );
}

export default AiSettingsSection;
