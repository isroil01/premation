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
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { api, isAuthenticated, type AiKeyStatus, type AiProviderId } from '@core/api/client';
import { useAiProviderStore, MODEL_SUGGESTIONS } from '@stores/aiProviderStore';
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

export function AiSettingsSection(): JSX.Element {
  const [status, setStatus] = useState<Record<AiProviderId, AiKeyStatus> | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<AiProviderId, string>>>({});
  const [busy, setBusy] = useState<AiProviderId | null>(null);
  const [error, setError] = useState<string>('');

  const provider = useAiProviderStore((s) => s.provider);
  const setProvider = useAiProviderStore((s) => s.setProvider);
  const models = useAiProviderStore((s) => s.models);
  const setModel = useAiProviderStore((s) => s.setModel);
  const refreshStore = useAiProviderStore((s) => s.refreshStatus);

  const refresh = useCallback(async () => {
    if (!isAuthenticated()) return;
    try {
      const keysResponse = await api.getAiKeys();
      const providers: AiProviderId[] = ['anthropic', 'openai', 'gemini'];
      let updated = false;

      for (const p of providers) {
        if (!keysResponse[p]?.present) {
          try {
            const localKey = localStorage.getItem(`motion_editor_local_ai_key_${p}`);
            if (localKey && localKey.trim()) {
              const saveRes = await api.saveAiKey(p, localKey.trim());
              if (saveRes.ok) {
                updated = true;
              }
            }
          } catch (e) {
            console.error(`Failed to auto-sync local key for ${p}`, e);
          }
        }
      }

      const finalKeys = updated ? await api.getAiKeys() : keysResponse;
      setStatus(finalKeys);
      // Keep the assistant's "has a key" gate in sync with what we just saved.
      void refreshStore();
    } catch {
      setError('Could not read your AI settings.');
    }
  }, [refreshStore]);

  useEffect(() => { void refresh(); }, [refresh]);

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
    setBusy(id);
    setError('');
    try {
      const res = await api.saveAiKey(id, key);
      if (!res.ok) {
        setError(
          res.reason === 'unavailable'
            ? 'The server cannot store keys right now (encryption is not configured). It has NOT been saved.'
            : 'Could not save that key.',
        );
        return;
      }
      try {
        localStorage.setItem(`motion_editor_local_ai_key_${id}`, key);
      } catch (e) {
        console.error('Failed to save key to localStorage', e);
      }
      // Drop the plaintext the moment it's handed off, and make the provider
      // you just connected the active one — that is why you connected it.
      setDrafts((d) => ({ ...d, [id]: '' }));
      setProvider(id);
      await refresh();
    } catch {
      setError('Could not reach the server to save the key.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: AiProviderId): Promise<void> => {
    setBusy(id);
    try {
      await api.clearAiKey(id);
      try {
        localStorage.removeItem(`motion_editor_local_ai_key_${id}`);
      } catch (e) {
        console.error('Failed to remove key from localStorage', e);
      }
      await refresh();
    } catch {
      setError('Could not reach the server to remove the key.');
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
                        {MODEL_SUGGESTIONS[p.id].map((m) => (
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
