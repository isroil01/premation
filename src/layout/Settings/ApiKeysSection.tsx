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
import { apiBaseUrl } from '@core/api/transport';
import styles from '../../pages/DashboardPage.module.css';
import keyStyles from './ApiKeysSection.module.css';

const KEY_PAGE_SIZE = 10;

const KEY_PRESETS = [
  'n8n Workflow',
  'Zapier Sync',
  'CI/CD Pipeline',
  'Production Server',
  'Local Development',
] as const;

type CodeTab = 'curl' | 'nodejs' | 'python' | 'webhook';

/** Mirrors the server's scope vocabulary (api-keys.service.ts). The default
 *  grant matches the server's default: everything except templates:write. */
const SCOPE_OPTIONS = [
  { id: 'renders:read', label: 'Read renders', defaultOn: true },
  { id: 'renders:write', label: 'Create renders', defaultOn: true },
  { id: 'templates:read', label: 'Read templates', defaultOn: true },
  { id: 'templates:write', label: 'Publish templates', defaultOn: false },
  { id: 'usage:read', label: 'Read usage', defaultOn: true },
] as const;

const DEFAULT_SCOPES = SCOPE_OPTIONS.filter((s) => s.defaultOn).map((s) => s.id as string);

const EXPIRY_OPTIONS = [
  { id: 'never', label: 'Never expires', days: null },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '1y', label: '1 year', days: 365 },
] as const;

type ExpiryId = (typeof EXPIRY_OPTIONS)[number]['id'];

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
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [page, setPage] = useState({ limit: KEY_PAGE_SIZE, offset: 0 });
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<CreatedApiKey | null>(null);
  const [activeCodeTab, setActiveCodeTab] = useState<CodeTab>('curl');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [expiry, setExpiry] = useState<ExpiryId>('never');

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
    if (!usage?.limits.apiEnabled) {
      setError('API access is not included in your current plan. Upgrade your plan to create and use API keys.');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please provide a name for this API key so you can identify its purpose later.');
      return;
    }
    if (scopes.length === 0) {
      setError('Select at least one scope — a key that can do nothing cannot be used.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const days = EXPIRY_OPTIONS.find((o) => o.id === expiry)?.days ?? null;
      const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      const created = await api.createApiKey(trimmed, { scopes, expiresAt });
      if (!created?.secret) {
        throw new Error('The server created a key but did not return the secret.');
      }
      setFresh(created);
      setName('');
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
      `Revoke “${row.name}”? Any external workflows or servers using this key will stop working immediately.`,
      { confirmLabel: 'Revoke key', isDanger: true },
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

  const copySecret = async (secret: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedSecret(true);
      window.setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      setError('Could not copy the key. Select it and copy manually.');
    }
  };

  const copyCodeSnippet = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedSnippet(true);
      window.setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      // ignore
    }
  };

  // STRICT: unlocked only when the server has said so. The old check
  // (`!== false`) rendered the full developer console while usage was still
  // loading or when the usage call failed — a free user saw an open page whose
  // every action the server would 403. Unknown now renders as locked-pending,
  // and `locked` (server-confirmed) is what shows the upgrade pitch.
  const apiEnabled = usage?.limits.apiEnabled === true;
  const locked = usage !== null && !apiEnabled;
  const activeKeys = keys.filter((key) => !key.revokedAt).length;
  const activeKeyLimit = usage?.limits.maxActiveApiKeys ?? null;

  const getCodeSnippet = (tab: CodeTab): string => {
    const keyPlaceholder = fresh?.secret || 'pm_live_your_api_key_here';
    // The endpoint this deployment actually serves — not a hardcoded prod
    // host, which made every copy-pasted snippet wrong on local/self-hosted
    // builds. `apiBaseUrl()` may be relative (`/api` behind the dev proxy), so
    // resolve it against the page origin: an external caller needs an
    // absolute URL.
    const base = apiBaseUrl();
    const absolute = /^https?:\/\//i.test(base)
      ? base
      : new URL(base, window.location.origin).toString();
    const rendersUrl = `${absolute.replace(/\/+$/, '')}/v1/renders`;
    switch (tab) {
      case 'curl':
        return `# 1. Trigger a template render\ncurl -X POST ${rendersUrl} \\\n  -H "Authorization: Bearer ${keyPlaceholder}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "templateId": "tpl_7f8a9b",\n    "inputs": {\n      "headline": "Launch Special 2026",\n      "accentColor": "#2988ff"\n    }\n  }'`;
      case 'nodejs':
        return `// Render video using Node.js / Fetch\nconst response = await fetch('${rendersUrl}', {\n  method: 'POST',\n  headers: {\n    'Authorization': 'Bearer ${keyPlaceholder}',\n    'Content-Type': 'application/json',\n  },\n  body: JSON.stringify({\n    templateId: 'tpl_7f8a9b',\n    inputs: {\n      headline: 'Automated Export',\n      accentColor: '#2988ff',\n    },\n  }),\n});\nconst job = await response.json();\nconsole.log('Render Job ID:', job.jobId);`;
      case 'python':
        return `# Render video using Python requests\nimport requests\n\nresponse = requests.post(\n    '${rendersUrl}',\n    headers={\n        'Authorization': f'Bearer ${keyPlaceholder}',\n        'Content-Type': 'application/json',\n    },\n    json={\n        'templateId': 'tpl_7f8a9b',\n        'inputs': {\n            'headline': 'Weekly Highlights',\n            'accentColor': '#2988ff',\n        },\n    },\n)\njob = response.json()\nprint(f"Render Job queued: {job['jobId']}")`;
      case 'webhook':
        return `// Webhook / n8n HTTP Request node\nMethod: POST\nURL: ${rendersUrl}\nAuthentication: Header Auth\nHeader Name: Authorization\nHeader Value: Bearer ${keyPlaceholder}\nBody Parameters: {\n  "templateId": "{{ $json.templateId }}",\n  "inputs": {{ $json.dynamicInputs }},\n  "callbackUrl": "{{ $json.webhookUrl }}"  // optional: POSTed once when the render finishes\n}\n\n// When it completes, download the file (302 to the mp4):\n// GET ${rendersUrl}/{{ jobId }}/download`;
    }
  };

  return (
    <div className={keyStyles.developerContainer}>
      {/* 1. Header Banner */}
      <div className={keyStyles.headerHero}>
        <div className={keyStyles.headerHeroContent}>
          <div className={keyStyles.headerTitleRow}>
            <div className={keyStyles.headerIconBadge}>
              <Icon name="code" size="md" />
            </div>
            <div>
              <h2 className={keyStyles.headerTitle}>Developer &amp; Automation API</h2>
              <p className={keyStyles.headerDesc}>
                Programmatically render video templates, automate batch exports from n8n or Zapier, and trigger video generations from webhooks.
              </p>
            </div>
          </div>
        </div>
        {apiEnabled && (
          <div className={keyStyles.apiStatusBadge}>
            <span className={keyStyles.statusDotActive} />
            <span>API Access Active</span>
          </div>
        )}
      </div>

      {/* 2. Gated Callout (if plan doesn't include API) */}
      {locked && (
        <div className={keyStyles.upgradeHeroCard} role="status">
          <div className={keyStyles.upgradeHeroLeft}>
            <div className={keyStyles.lockIconWrap}>
              <Icon name="lock" size="lg" />
            </div>
            <div className={keyStyles.upgradeHeroText}>
              <h3 className={keyStyles.upgradeHeroTitle}>Automation API access is not included in this plan</h3>
              <p className={keyStyles.upgradeHeroDesc}>
                Upgrade your subscription to get secret API keys, trigger automated video renders via REST endpoints, and connect n8n, Zapier, or your backend pipeline.
              </p>
              <div className={keyStyles.featureList}>
                <span className={keyStyles.featureItem}>
                  <Icon name="check" size="sm" className={keyStyles.featureTick} /> REST endpoints for template rendering
                </span>
                <span className={keyStyles.featureItem}>
                  <Icon name="check" size="sm" className={keyStyles.featureTick} /> Dynamic text, image &amp; color variables
                </span>
                <span className={keyStyles.featureItem}>
                  <Icon name="check" size="sm" className={keyStyles.featureTick} /> High-throughput cloud render queue
                </span>
              </div>
            </div>
          </div>
          {onViewPlans && (
            <div className={keyStyles.upgradeHeroAction}>
              <Button size="md" variant="primary" onClick={onViewPlans} leftIcon={<Icon name="sparkles" size="sm" />}>
                View plans
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 2b. Access still unknown (loading, or /v1/usage unreachable) — say so
          rather than flashing either the open console or the upgrade pitch. */}
      {usage === null && (
        <div className={keyStyles.card}>
          <div className={keyStyles.emptyWrap} role="status">
            {loading ? (
              <>
                <Icon name="refresh" size="md" className={keyStyles.spinningIcon} />
                <span>Checking your plan&apos;s API access…</span>
              </>
            ) : (
              <>
                <Icon name="warning" size="md" className={keyStyles.emptyIcon} />
                <span>Could not load your plan&apos;s API access. Reload to try again.</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 3. Monthly Usage & Quotas (locked plans have no quotas to show) */}
      {apiEnabled && usage && (
        <div className={keyStyles.usageGrid}>
          <div className={keyStyles.metricCard}>
            <div className={keyStyles.metricHeader}>
              <span className={keyStyles.metricLabel}>Render Minutes</span>
              <span className={keyStyles.metricValue}>
                {usage.renderedMinutes.toLocaleString()} / {usage.limits.monthlyRenderMinutes == null ? 'Unlimited' : `${usage.limits.monthlyRenderMinutes.toLocaleString()} min`}
              </span>
            </div>
            {usage.limits.monthlyRenderMinutes != null && (
              <div
                className={keyStyles.progressBarTrack}
                role="progressbar"
                aria-label="Render minutes usage"
                aria-valuemin={0}
                aria-valuemax={usage.limits.monthlyRenderMinutes}
                aria-valuenow={Math.min(usage.renderedMinutes, usage.limits.monthlyRenderMinutes)}
              >
                <div
                  className={keyStyles.progressBarFill}
                  style={{
                    '--fill': Math.min(1, usage.renderedMinutes / Math.max(1, usage.limits.monthlyRenderMinutes)),
                  } as React.CSSProperties}
                />
              </div>
            )}
            <span className={keyStyles.metricSubtext}>Period: {usage.period} · {usage.renderJobs} jobs processed</span>
          </div>

          <div className={keyStyles.metricCard}>
            <div className={keyStyles.metricHeader}>
              <span className={keyStyles.metricLabel}>API Requests</span>
              <span className={keyStyles.metricValue}>
                {usage.apiRequests.toLocaleString()} / {usage.limits.monthlyApiRequests == null ? 'Unlimited' : usage.limits.monthlyApiRequests.toLocaleString()}
              </span>
            </div>
            {usage.limits.monthlyApiRequests != null && (
              <div
                className={keyStyles.progressBarTrack}
                role="progressbar"
                aria-label="API requests usage"
                aria-valuemin={0}
                aria-valuemax={usage.limits.monthlyApiRequests}
                aria-valuenow={Math.min(usage.apiRequests, usage.limits.monthlyApiRequests)}
              >
                <div
                  className={keyStyles.progressBarFill}
                  style={{
                    '--fill': Math.min(1, usage.apiRequests / Math.max(1, usage.limits.monthlyApiRequests)),
                  } as React.CSSProperties}
                />
              </div>
            )}
            <span className={keyStyles.metricSubtext}>Monthly request quota</span>
          </div>

          <div className={keyStyles.metricCard}>
            <div className={keyStyles.metricHeader}>
              <span className={keyStyles.metricLabel}>Active API Keys</span>
              <span className={keyStyles.metricValue}>
                {activeKeys} / {activeKeyLimit == null ? 'Unlimited' : activeKeyLimit}
              </span>
            </div>
            <div className={keyStyles.allowanceInfo}>
              {activeKeyLimit != null
                ? `Active key allowance: up to ${activeKeyLimit.toLocaleString()}`
                : 'Unlimited active API keys'}
            </div>
            <span className={keyStyles.metricSubtext}>{total} total keys generated</span>
          </div>
        </div>
      )}

      {/* 4. One-Time Secret Reveal Callout */}
      {fresh && (
        <div role="status" className={keyStyles.secretCallout}>
          <div className={keyStyles.secretHeader}>
            <div className={keyStyles.secretIconBadge}>
              <Icon name="lock" size="sm" />
            </div>
            <div>
              <strong className={keyStyles.secretTitle}>Save your new API key</strong>
              <p className={keyStyles.secretDesc}>
                Copy this key now. For your security, it will not be shown again.
              </p>
            </div>
          </div>
          <div className={keyStyles.secretInputRow}>
            <input
              type="text"
              readOnly
              value={fresh.secret}
              aria-label="New API key secret"
              className={keyStyles.secretField}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button
              size="md"
              variant="primary"
              onClick={() => void copySecret(fresh.secret)}
              leftIcon={<Icon name={copiedSecret ? 'check' : 'copy'} size="sm" />}
            >
              {copiedSecret ? 'Copied!' : 'Copy key'}
            </Button>
            <Button size="md" variant="secondary" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {/* 5. Key Creation Form Card */}
      {/* 5. Create form — only on an API-enabled plan. Rendering it disabled
          made the page read as available-but-broken; locked plans get the
          upgrade hero instead. */}
      {apiEnabled && (
      <div className={keyStyles.card}>
        <div className={keyStyles.cardHeader}>
          <div>
            <h3 className={keyStyles.cardTitle}>Create New Secret Key</h3>
            <p className={keyStyles.cardDesc}>
              Secret keys grant full programmatic access to render templates and inspect render jobs.
            </p>
          </div>
        </div>

        {error && (
          <div className={keyStyles.errorAlert} role="alert">
            <Icon name="warning" size="sm" className={keyStyles.errorIcon} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={(e) => void create(e)} className={keyStyles.createForm}>
          <div className={keyStyles.formInputRow}>
            <div className={keyStyles.inputWrapper}>
              <label htmlFor="api-key-name-input" className={keyStyles.inputLabel}>
                Key Name &amp; Purpose
              </label>
              <Input
                id="api-key-name-input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="e.g. Production CI/CD, Zapier Sync, Backend Service"
                fullWidth
                disabled={creating || !apiEnabled}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={creating || !apiEnabled || loading}
              leftIcon={<Icon name="plus" size="sm" />}
              className={keyStyles.createBtn}
            >
              {creating ? 'Creating…' : 'Create API key'}
            </Button>
          </div>

          {/* Scopes + expiry. Sent with the create; the server enforces both. */}
          {apiEnabled && (
            <div className={keyStyles.optionsRow}>
              <fieldset className={keyStyles.scopesGroup} disabled={creating}>
                <legend className={keyStyles.inputLabel}>Permissions</legend>
                <div className={keyStyles.scopeChips}>
                  {SCOPE_OPTIONS.map((scope) => {
                    const on = scopes.includes(scope.id);
                    return (
                      <label
                        key={scope.id}
                        className={on ? keyStyles.scopeChipOn : keyStyles.scopeChip}
                        title={scope.id}
                      >
                        <input
                          type="checkbox"
                          className={keyStyles.scopeCheckbox}
                          checked={on}
                          onChange={() =>
                            setScopes((prev) =>
                              on ? prev.filter((s) => s !== scope.id) : [...prev, scope.id],
                            )
                          }
                        />
                        {scope.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <div className={keyStyles.expiryGroup}>
                <label htmlFor="api-key-expiry" className={keyStyles.inputLabel}>
                  Expiration
                </label>
                <select
                  id="api-key-expiry"
                  className={keyStyles.expirySelect}
                  value={expiry}
                  disabled={creating}
                  onChange={(e) => setExpiry(e.currentTarget.value as ExpiryId)}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Quick preset suggestion chips */}
          {apiEnabled && (
            <div className={keyStyles.presetsRow}>
              <span className={keyStyles.presetsLabel}>Suggestions:</span>
              {KEY_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset}
                  className={keyStyles.presetChip}
                  onClick={() => {
                    setName(preset);
                    if (error) setError(null);
                  }}
                  disabled={creating || !apiEnabled}
                >
                  {preset}
                </button>
              ))}
            </div>
          )}
        </form>
      </div>
      )}

      {/* 6. Active & Revoked Keys Table. Also shown on a LOCKED plan when keys
          exist: a downgraded user must still be able to see and revoke keys
          minted under the old plan. */}
      {(apiEnabled || keys.length > 0) && (
      <div className={keyStyles.card}>
        <div className={keyStyles.cardHeader}>
          <div>
            <h3 className={keyStyles.cardTitle}>Your API Keys</h3>
            <p className={keyStyles.cardDesc}>
              Manage and revoke existing authentication keys. Revoking immediately terminates workflow access.
            </p>
          </div>
        </div>

        <div className={keyStyles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Key Name</th>
                <th>Created</th>
                <th>Status</th>
                <th style={{ width: 100, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={4} className={keyStyles.emptyCell}>
                    <div className={keyStyles.emptyWrap}>
                      <Icon name="refresh" size="md" className={keyStyles.spinningIcon} />
                      <span>Loading API keys…</span>
                    </div>
                  </td>
                </tr>
              )}
              {!loading && keys.length === 0 && (
                <tr>
                  <td colSpan={4} className={keyStyles.emptyCell}>
                    <div className={keyStyles.emptyWrap}>
                      <Icon name="code" size="lg" className={keyStyles.emptyIcon} />
                      <span>No API keys created yet. Enter a key name above to generate one.</span>
                    </div>
                  </td>
                </tr>
              )}
              {!loading &&
                keys.map((k) => {
                  const isRevoked = Boolean(k.revokedAt);
                  return (
                    <tr key={k.id} className={isRevoked ? keyStyles.revokedRow : undefined}>
                      <td>
                        <div className={keyStyles.keyNameRow}>
                          <span className={keyStyles.keyNameText}>{k.name}</span>
                          <span className={keyStyles.keyPrefixBadge}>{k.prefix}…</span>
                        </div>
                        {k.scopes?.length ? (
                          <div className={keyStyles.meta}>Scopes: {k.scopes.join(', ')}</div>
                        ) : null}
                      </td>
                      <td>
                        <div className={keyStyles.dateText}>{formatDate(k.createdAt)}</div>
                        <div className={keyStyles.meta}>
                          {k.lastUsedAt ? `Last used ${formatDate(k.lastUsedAt)}` : 'Never used'} ·{' '}
                          {k.requestCount.toLocaleString()} requests
                        </div>
                      </td>
                      <td>
                        <span className={isRevoked ? keyStyles.statusPillRevoked : keyStyles.statusPillActive}>
                          <span className={isRevoked ? keyStyles.dotRevoked : keyStyles.dotActive} />
                          {isRevoked ? 'Revoked' : 'Active'}
                        </span>
                        {k.expiresAt ? <div className={keyStyles.meta}>Expires {formatDate(k.expiresAt)}</div> : null}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!isRevoked && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pendingKeyId !== null}
                            onClick={() => void revoke(k)}
                            className={keyStyles.revokeBtn}
                          >
                            {pendingKeyId === k.id ? 'Revoking…' : 'Revoke'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
      )}

      {/* 7. Quickstart & Interactive Code Snippets — unlocked plans only. */}
      {apiEnabled && (
      <div className={keyStyles.card}>
        <div className={keyStyles.cardHeader}>
          <div>
            <h3 className={keyStyles.cardTitle}>Quickstart &amp; API Reference</h3>
            <p className={keyStyles.cardDesc}>
              Send a <code>POST</code> request with your template ID and custom inputs to start rendering immediately.
            </p>
          </div>
        </div>

        <div className={keyStyles.codeSection}>
          <div className={keyStyles.codeTabs}>
            <button
              type="button"
              className={`${keyStyles.codeTab} ${activeCodeTab === 'curl' ? keyStyles.codeTabActive : ''}`}
              onClick={() => setActiveCodeTab('curl')}
            >
              cURL
            </button>
            <button
              type="button"
              className={`${keyStyles.codeTab} ${activeCodeTab === 'nodejs' ? keyStyles.codeTabActive : ''}`}
              onClick={() => setActiveCodeTab('nodejs')}
            >
              Node.js
            </button>
            <button
              type="button"
              className={`${keyStyles.codeTab} ${activeCodeTab === 'python' ? keyStyles.codeTabActive : ''}`}
              onClick={() => setActiveCodeTab('python')}
            >
              Python
            </button>
            <button
              type="button"
              className={`${keyStyles.codeTab} ${activeCodeTab === 'webhook' ? keyStyles.codeTabActive : ''}`}
              onClick={() => setActiveCodeTab('webhook')}
            >
              n8n / Webhook
            </button>
            <div className={keyStyles.codeTabSpacer} />
            <button
              type="button"
              className={keyStyles.copyCodeBtn}
              onClick={() => void copyCodeSnippet(getCodeSnippet(activeCodeTab))}
              title="Copy snippet"
            >
              <Icon name={copiedSnippet ? 'check' : 'copy'} size="sm" />
              <span>{copiedSnippet ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className={keyStyles.codeBlock}>
            <code>{getCodeSnippet(activeCodeTab)}</code>
          </pre>
        </div>
      </div>
      )}
    </div>
  );
}
