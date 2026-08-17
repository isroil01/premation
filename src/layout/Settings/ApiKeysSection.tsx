/**
 * Developer / API keys — the dashboard's Developer page.
 *
 * Keys are minted server-side; the secret is shown once. Revoke is immediate.
 *
 * `onViewPlans` is a PROP rather than an internal `navigate('/dashboard…')`.
 * `/dashboard` is registered only under `cloudProjectsEnabled()`, and
 * `editionReachability.test.ts` forbids anything in `src/layout` from linking
 * to a route that does not exist in every edition — a local build would have
 * rendered a button that navigates nowhere. The owning page knows where its own
 * billing surface is; this component does not need to.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Pagination } from '@components/Pagination';
import { customConfirm } from '@components/Modal';
import {
  api,
  type ApiError,
  type ApiKeySummary,
  type ApiUsageSummary,
  type CreatedApiKey,
} from '@core/api/client';
import styles from '../../pages/DashboardPage.module.css';
import keyStyles from './ApiKeysSection.module.css';

const KEY_PAGE_SIZE = 10;

function formatDate(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '—';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', year: 'numeric', day: 'numeric' });
}

function readError(err: unknown): string {
  const apiErr = err as ApiError;
  if (apiErr?.status === 404) {
    return 'The server has no Automation API yet (POST /api/v1/keys). The backend needs the v1 keys route.';
  }
  if (apiErr?.status === 401) {
    return 'Sign-in expired. Refresh the dashboard and try again.';
  }
  const body = apiErr?.body as { message?: string | { message?: string } } | undefined;
  const nested = typeof body?.message === 'object' ? body.message?.message : body?.message;
  return (typeof nested === 'string' && nested) || (err instanceof Error ? err.message : 'Could not create the key.');
}

export interface ApiKeysSectionProps {
  /** Show a route to billing. Omitted when the build has no billing surface. */
  onViewPlans?: () => void;
}

export function ApiKeysSection({ onViewPlans }: ApiKeysSectionProps = {}): JSX.Element {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [usage, setUsage] = useState<ApiUsageSummary | null>(null);
  const [name, setName] = useState('My n8n workflow');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState({ limit: KEY_PAGE_SIZE, offset: 0 });
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<CreatedApiKey | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const result = await api.listApiKeys({ force, ...page });
      setKeys(result.items);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      setError(readError(err));
    }
    try {
      setUsage(await api.getApiUsage());
    } catch {
      /* usage is informational — a missing /v1/usage must not hide keys */
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (usage && !usage.limits.apiEnabled) {
      setError('API access is not included in your current plan.');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name the key so you can tell this workflow from another later.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await api.createApiKey(trimmed);
      if (!created?.secret) {
        throw new Error('The server created a key but did not return the secret.');
      }
      setFresh(created);
      setName('My n8n workflow');
      if (page.offset !== 0) {
        setPage((current) => ({ ...current, offset: 0 }));
      } else {
        await load(true);
      }
    } catch (err) {
      setError(readError(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (row: ApiKeySummary): Promise<void> => {
    const confirmed = await customConfirm(
      'Revoke API key',
      `Revoke “${row.name}”? Workflows using this key will stop immediately.`,
      { confirmLabel: 'Revoke', isDanger: true },
    );
    if (!confirmed) return;
    setPendingKeyId(row.id);
    setError(null);
    try {
      await api.revokeApiKey(row.id);
      setKeys((prev) =>
        prev.map((k) => (k.id === row.id ? { ...k, revokedAt: new Date().toISOString() } : k)),
      );
      await load(true);
    } catch (err) {
      setError(readError(err));
    } finally {
      setPendingKeyId(null);
    }
  };

  const copy = async (secret: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy the key. Select it and copy it manually.');
    }
  };

  const apiEnabled = usage?.limits.apiEnabled !== false;
  const activeKeys = keys.filter((key) => !key.revokedAt).length;
  const activeKeyLimit = usage?.limits.maxActiveApiKeys ?? null;

  const quota = (label: string, used: number, limit: number | null): JSX.Element => {
    const percent = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    return (
      <div className={keyStyles.quota}>
        <div className={keyStyles.quotaHeader}>
          <span>{label}</span>
          <span className={styles.monoValue}>
            {used.toLocaleString()} / {limit == null ? 'Unlimited' : limit.toLocaleString()}
          </span>
        </div>
        {limit != null ? (
          <div
            className={styles.storageBarTrack}
            role="progressbar"
            aria-label={`${label} usage`}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(used, limit)}
          >
            <div className={styles.storageBarFill} style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={styles.settingsCard}>
      <h3 className={styles.settingsLabel}>Developer / API</h3>
      <p className={styles.optionDesc}>
        Automate a saved template from n8n with a Bearer key. Create the animation
        in Premation once, then send new assets to <code>POST /api/v1/renders</code>.
      </p>

      {usage && (
        <div className={styles.storageBarSection}>
          <div className={styles.storageBarHeader}>
            <span>This month ({usage.period})</span>
            <span className={styles.monoValue}>{usage.renderJobs} render jobs</span>
          </div>
          <div className={keyStyles.quotas}>
            {quota('Render minutes', usage.renderedMinutes, usage.limits.monthlyRenderMinutes)}
            {quota('API requests', usage.apiRequests, usage.limits.monthlyApiRequests)}
            {activeKeyLimit != null ? (
              <div className={keyStyles.allowance}>
                Active key allowance: up to {activeKeyLimit.toLocaleString()}
                {total <= page.limit ? ` · ${activeKeys.toLocaleString()} active now` : ''}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {!apiEnabled ? (
        <div className={keyStyles.upgradeCallout} role="status">
          <div>
            <strong>Automation API access is not included in this plan.</strong>
            <p>Compare plans to enable API keys and automated rendering.</p>
          </div>
          {onViewPlans ? (
            <Button size="sm" variant="primary" onClick={onViewPlans}>
              View plans
            </Button>
          ) : null}
        </div>
      ) : null}

      {fresh && (
        <div role="status" className={keyStyles.secretCallout}>
          <strong>Copy this key now — it will not be shown again.</strong>
          <Input readOnly value={fresh.secret} aria-label="New API key secret" />
          <div className={keyStyles.rowActions}>
            <Button size="sm" variant="primary" onClick={() => void copy(fresh.secret)}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className={styles.optionDesc} style={{ color: 'var(--color-danger)', margin: 0 }}>
          {error}
        </p>
      )}

      <form
        className={styles.settingsRow}
        onSubmit={(e) => void create(e)}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <Input
            label="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My n8n workflow"
            fullWidth
            disabled={creating || !apiEnabled}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={creating || !apiEnabled || loading}
          leftIcon={<Icon name="plus" size="sm" />}
        >
          {creating ? 'Creating…' : 'Create API key'}
        </Button>
      </form>

      <div className={styles.tableCard} style={{ padding: 0, boxShadow: 'none' }}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Status</th>
              <th style={{ width: 88 }} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className={keyStyles.emptyCell}>
                  Loading API keys…
                </td>
              </tr>
            )}
            {!loading && keys.length === 0 && (
              <tr>
                <td colSpan={4} className={keyStyles.emptyCell}>
                  No API keys yet.
                </td>
              </tr>
            )}
            {!loading && keys.map((k) => (
              <tr key={k.id}>
                <td>
                  <div>{k.name}</div>
                  <div className={styles.monoValue} style={{ opacity: 0.7 }}>
                    {k.prefix}…
                  </div>
                  {k.scopes?.length ? (
                    <div className={keyStyles.meta}>Scopes: {k.scopes.join(', ')}</div>
                  ) : null}
                </td>
                <td>
                  <div>{formatDate(k.createdAt)}</div>
                  <div className={keyStyles.meta}>
                    {k.lastUsedAt ? `Last used ${formatDate(k.lastUsedAt)}` : 'Never used'} ·{' '}
                    {k.requestCount.toLocaleString()} requests
                  </div>
                </td>
                <td>
                  <div>{k.revokedAt ? 'Revoked' : 'Active'}</div>
                  {k.expiresAt ? <div className={keyStyles.meta}>Expires {formatDate(k.expiresAt)}</div> : null}
                </td>
                <td>
                  {!k.revokedAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pendingKeyId !== null}
                      onClick={() => void revoke(k)}
                    >
                      {pendingKeyId === k.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          total={total}
          limit={page.limit}
          offset={page.offset}
          busy={loading || pendingKeyId !== null}
          pageSizes={[10, 25, 50]}
          onChange={setPage}
          itemLabel="key"
        />
      </div>
    </div>
  );
}
