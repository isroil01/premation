/**
 * Motion backend API client.
 *
 * A thin fetch wrapper that talks to motion-back (NestJS). Auth is a bearer JWT
 * kept in localStorage; every request carries it when present. The client is
 * intentionally dependency-free so it can be used from stores, adapters, and the
 * assistant alike.
 *
 * Reads that repeat go through `cachedGet` (see./cache): deduped, served
 * stale-then-revalidated, and revalidated conditionally so an unchanged
 * response costs a 304 and no re-render. Writes declare the cache tags they
 * dirty — that declaration, not a timeout, is what keeps the UI honest.
 */

import { BACKEND_ORIGIN, IS_ELECTRON } from './env';
import {
  apiBaseUrl,
  conditionalGet,
  getToken,
  isAuthenticated,
  query,
  request,
  setToken,
  type ApiError,
  type PageQuery,
  type Paginated,
} from './transport';
import { cachedGet, clear as clearCache, invalidate } from './cache';
import { clearSession, clientNameHeader, signIn } from './session';

export {
  apiBaseUrl,
  conditionalGet,
  getToken,
  isAuthenticated,
  request,
  setToken,
  type ApiError,
  type PageQuery,
  type Paginated,
};
export { clearCache };
export * as apiCache from './cache';

/**
 * Freshly signed `/files/...` URLs from this session's API responses, keyed by
 * their bare path (no query).
 *
 * Locally stored backend files are served behind expiring HMAC signatures
 * (`?exp=…&sig=…`). Project documents persist asset `src` strings, so a
 * reloaded document holds yesterday's signature — dead on arrival. Every asset
 * list/upload response registers its fresh URL here, and `assetUrl` swaps a
 * stale persisted URL for the fresh one by path. The library is loaded at
 * sign-in (assetStore.loadFromCloud), so the map is warm before any document
 * renders.
 */
const freshFileUrls = new Map<string, string>();

/** Remember the freshly signed form of a served `/files` URL. */
export function registerFileUrl(src: string | null | undefined): void {
  if (!src) return;
  const m = src.match(/^(?:https?:\/\/[^/]+)?(\/files\/[^?]+)(\?.*)?$/);
  if (m) freshFileUrls.set(m[1]!, m[1]! + (m[2] ?? ''));
}

/**
 * Rewrite a backend-served asset URL to a same-origin relative path.
 *
 * The backend hands back absolute URLs like `http://localhost:4000/files/<key>`.
 * In the browser build those are cross-origin and blocked by the page CSP
 * (`default-src 'self'`), so images/video/audio never load. Collapsing them to
 * `/files/<key>` routes the request through the same-origin dev proxy (see
 * vite.config.ts) so it satisfies `'self'`. Blob/data URLs pass through
 * untouched. `/files` URLs also trade any stale persisted signature for the
 * freshest one this session has seen (see `registerFileUrl`).
 */
export function assetUrl(src: string | null | undefined): string {
  if (!src) return src ?? '';
  if (src.startsWith('blob:') || src.startsWith('data:')) return src;
  // Reduce any absolute backend URL to its `/files/...` path first.
  const m = src.match(/^https?:\/\/[^/]+(\/files\/.*)$/);
  const path = m ? m[1]! : src;
  if (path.startsWith('/files')) {
    // A persisted URL carries the signature it was saved with; prefer the
    // fresh one from this session's asset list.
    const bare = path.split('?')[0]!;
    const resolved = freshFileUrls.get(bare) ?? path;
    // Electron has no dev proxy → the asset must be an absolute backend URL.
    // The browser uses the same-origin proxied path (satisfies CSP 'self').
    return IS_ELECTRON ? `${BACKEND_ORIGIN}${resolved}` : resolved;
  }
  return path;
}

// ── Types (mirror the backend contracts) ────────────────────────────────────

/**
 * Platform privilege, as opposed to plan. Reported by the backend so the app can
 * tell operators apart from users; the desktop app itself exposes no admin
 * surface — the admin console lives in the motion-landing web app.
 */
export type UserRole = 'user' | 'admin';

export interface AuthResult {
  /** Short-lived access JWT. Held in memory only — never persisted. */
  token: string;
  /**
   * Long-lived, single-use refresh token. Stored in the OS keystore on
   * desktop (see core/api/session); rotated on every exchange, so this exact
   * value works exactly once.
   */
  refreshToken: string;
  /** Seconds until `token` expires. Drives the silent refresh schedule. */
  expiresIn: number;
  refreshExpiresAt: string;
  user: { id: string; email: string; name: string | null; role: UserRole; emailVerified: boolean };
}

/** One device holding a live session, for "where am I signed in?". */
export interface SessionRecord {
  id: string;
  family: string;
  device: string | null;
  ip: string | null;
  lastUsedAt: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * The signed-in account: identity, commercial state, and usage.
 *
 * Usage totals are computed server-side. The dashboard used to sum every
 * asset's bytes itself, which only works while there is no pagination.
 */
export interface AccountRecord {
  id: string;
  email: string;
  name: string | null;
  /**
   * Re-read from the database on every authenticated request server-side, so
   * this is current rather than whatever was true when the token was minted.
   * Informational in the desktop app — it gates nothing here, and the admin
   * console it used to reveal now lives in motion-landing.
   */
  role: UserRole;
  plan: string;
  /**
   * What this account may do with the cloud, decided server-side by the same
   * function the write guards use. The renderer renders it; it never recomputes
   * it. Replaced `aiCredits`/`aiCreditsUsed`, which are gone: the assistant is
   * BYOK in both editions, so there is nothing metered to report.
   */
  access: CloudAccess;
  emailVerified: boolean;
  trialEndsAt: string | null;
  storageBytes: number;
  assetCount: number;
  projectCount: number;
  createdAt: string;
}

/**
 * A project as the list needs it — the comp facts included, so a card can show
 * what a project actually IS without downloading its whole document. The
 * dashboard used to invent these from the revision counter.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  layerCount: number;
  /**
   * Poster frame URL, or null when there isn't one. A URL, not a storage key:
   * how a key becomes a URL is a storage-driver detail the server owns.
   */
  thumbnailUrl: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord extends ProjectSummary {
  document: unknown;
}

/** A project in the trash, with the server's own countdown to purge. */
export interface TrashedProject extends ProjectSummary {
  deletedAt: string;
  purgesInDays: number;
}

export interface ImportedAssetDto {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  src: string;
  size: number;
  metadata?: { width?: number; height?: number; duration?: number };
}

export interface RenderJobDto {
  id: string;
  /** Only mp4 is created now; the others exist on historical rows. */
  format: 'webm' | 'png' | 'json' | 'lottie' | 'mp4';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  progress: number;
  projectId: string | null;
  resultUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** API key row for the dashboard. The secret is never returned after creation. */
export interface ApiKeySummary {
  id: string;
  name: string;
  /** Visible prefix, e.g. `pm_live_ab12`. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
  revokedAt: string | null;
  /** Present on newer API-key contracts. Older servers omit both fields. */
  scopes?: string[];
  expiresAt?: string | null;
}

/** One-time response when a key is minted. Store `secret` now; it is not shown again. */
export interface CreatedApiKey extends ApiKeySummary {
  secret: string;
}

export interface AutomationTemplateInput {
  id: string;
  label: string;
  kind: 'text' | 'color' | 'number' | 'image' | 'media';
  required?: boolean;
}

export interface AutomationTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  inputs: AutomationTemplateInput[];
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTemplateRecord extends AutomationTemplateSummary {
  projectId: string | null;
}

export interface PublishTemplateRequest {
  name: string;
  description?: string;
  document: unknown;
  inputs: AutomationTemplateInput[];
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  projectId?: string;
}

export interface AnimationTemplateSummary {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnimationTemplateRecord extends AnimationTemplateSummary {
  animationData: unknown;
}

export type AutomationRenderStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AutomationRenderRequest {
  templateId: string;
  inputs: Record<string, string | number>;
  output?: {
    format?: 'mp4';
    width?: number;
    height?: number;
    fps?: number;
  };
}

export interface AutomationRenderJob {
  jobId: string;
  status: AutomationRenderStatus;
  progress?: number;
  videoUrl?: string | null;
  error?: string | null;
  createdAt?: string;
}

export interface ApiUsageSummary {
  period: string;
  renderJobs: number;
  renderDurationMs: number;
  renderedMinutes: number;
  reservedRenderMinutes?: number;
  apiRequests: number;
  assetProcessingBytes: number;
  /** Optional until the backend exposes key allowances alongside usage. */
  activeApiKeys?: number;
  limits: {
    apiEnabled: boolean;
    monthlyRenderMinutes: number | null;
    monthlyApiRequests: number | null;
    maxActiveApiKeys?: number | null;
    maxUploadBytes?: number | null;
  };
}

/**
 * What `GET /render?status=` accepts. `'active'` is queued-or-running — the
 * question a queue view actually asks, answered by the server's `total` rather
 * than by counting a page.
 */
export type RenderStatusFilter = 'active' | RenderJobDto['status'];

export type VersionKind = 'autosave' | 'manual' | 'recovery';

export interface ProjectVersionSummary {
  id: string;
  revision: number;
  label: string | null;
  kind: VersionKind;
  time: number;
  createdAt: string;
}

export interface ProjectVersionRecord extends ProjectVersionSummary {
  projectId: string;
  document: unknown;
}

/** A plan, exactly as the server describes it. The client renders, not decides. */
export interface PlanDto {
  id: string;
  name: string;
  priceCents: number;
  priceLabel: string;
  currency: 'usd';
  features: string[];
  interval?: string;
  description?: string;
  highlighted?: boolean;
  apiEnabled?: boolean;
  monthlyRenderMinutes?: number;
  monthlyApiRequests?: number;
  maxUploadBytes?: number;
  maxActiveApiKeys?: number;
  cloudWrite?: boolean;
}

/** Why the server says this account may or may not write. See backend entitlement.ts. */
export type EntitlementReason =
  /** Payments aren't open yet — the cloud is free for everyone (write: true). */
  | 'beta'
  | 'active'
  | 'grace'
  | 'trial'
  | 'unverified'
  | 'trial_not_started'
  | 'trial_expired'
  | 'lapsed'
  | 'staff';

/**
 * What this account may do with the cloud, decided server-side.
 *
 * The client renders this; it never computes it. A second implementation of
 * "am I inside my trial?" in the renderer would disagree with the guard the first
 * time either was edited, and the disagreement would either lock out a paying
 * customer or give the product away.
 */
export interface CloudAccess {
  /** Open, list and export. True for any live account, in every state. */
  read: boolean;
  /** Save, sync, hosted render, upload. The thing being sold. */
  write: boolean;
  reason: EntitlementReason;
  /** Whole days until write access ends. Null when not on a clock. */
  daysRemaining: number | null;
  writeEndsAt: string | null;
}

export interface BillingSummary {
  plan: PlanDto;
  access: CloudAccess;
  /** The sentence to show. Server-authored so every surface agrees. */
  statusMessage: string;
  emailVerified: boolean;
  trialEndsAt: string | null;
  trialDays: number;
  /** Raw Lemon Squeezy status: active | past_due | cancelled | … */
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  /** Whether there is a subscription to manage — gates the portal button. */
  hasSubscription: boolean;
  /** True when Lemon has accepted a cancel-at-period-end. Access may still be live. */
  subscriptionCancelled?: boolean;
  memberSince: string;
  /** False until an operator turns payments on. Checkout then talks to Lemon. */
  paymentsEnabled: boolean;
}

export interface BillingChangeResult {
  action: 'checkout' | 'upgraded' | 'downgraded' | 'cancelled' | 'resumed' | 'unchanged';
  url?: string;
  planId?: string;
  already?: boolean;
}

export interface AiConversationSummary {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One stored turn. Prose only — the assistant's tool traffic is deliberately
 * not persisted, since a tool result describes a document that has since moved
 * on and would mislead the model if replayed.
 */
export interface AiMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** A failed turn — rehydrates as a warning, never replayed as real prose. */
  isError: boolean;
  createdAt: string;
}

/** A provider the user can hold their own key for. */
export type AiProviderId = 'openai' | 'anthropic' | 'gemini';

/** What the assistant can be pointed at: a BYOK provider, or our metered AI. */
export type GatewayProviderId = AiProviderId | 'motion';

export interface AiKeyStatus {
  present: boolean;
  /** Masked tail for display, e.g. "sk-…4f2a". Never the full key. */
  hint: string;
  key?: string | null;
}

/**
 * Motion AI = our provider account, used on the user's behalf. `dialect` says
 * which wire format our key speaks, so the editor knows which adapter to build
 * the request with. `present` means "this user can run a prompt on it right
 * now" — false when the server has it off, or the plan doesn't allow it.
 */
export interface AiMotionStatus {
  present: boolean;
  hint: string;
  dialect: AiProviderId;
  model: string | null;
  /** True while it's free for everyone; false once it's a paid tier. */
  free: boolean;
  /** Whether THIS user's plan allows it. */
  entitled: boolean;
  /** Motion AI credits left. BYOK never spends these. */
  credits: number;
  creditsUsed: number;
  /** What one assistant run costs. */
  creditsPerRun: number;
}

export type AiKeysResponse = Record<AiProviderId, AiKeyStatus> & { motion: AiMotionStatus };

/**
 * One row of the backend's capability matrix — the models it can actually route
 * to.
 *
 * Loose on the tail because the matrix carries routing metadata the picker does
 * not need, and pinning fields the editor never reads would make every backend
 * addition a breaking change here.
 */
export interface AiModelCapability {
  provider: AiProviderId;
  model: string;
  contextWindowTokens?: number;
  reasoningDepthScore?: number;
}

export interface AiModelsResponse {
  models: AiModelCapability[];
}

export interface AiConversationRecord extends AiConversationSummary {
  messages: AiMessageRecord[];
}

/**
 * A call that MINTS a session, routed so its tokens never reach this realm.
 *
 * On desktop these four routes deliberately do not go through `api.request`:
 * their responses carry the very tokens Track A moved out of the renderer, so
 * proxying them generically would hand them straight back. Main posts them,
 * keeps what it minted, and answers with a status.
 *
 * The result returned here is token-FREE on purpose. Every caller does
 * `setSession(result)` next, and on desktop `setSession` ignores its argument
 * and re-reads the status — so the two builds stay one code path and the
 * desktop one has nothing to leak. `apiProxy` refuses these paths too, so a
 * future caller cannot quietly route around this.
 *
 * `user`, though, is NOT a credential, and dropping it broke sign-in outright.
 * Main answers `signIn` with an `AuthStatus` — signedIn, an id, an email — not
 * with the account record, so this used to return a shim with no `user` at all
 * and a cast that made the compiler agree it was an `AuthResult`. Every caller
 * reads `res.user.id` immediately, so every desktop sign-in threw
 * "Cannot read properties of undefined (reading 'id')" — *after* main had
 * already adopted the tokens. That is why the app both refused to sign in and
 * came back signed in on the next launch: the session was real, only the store
 * never learned whose it was. So fetch the account over the session that was
 * just minted and hand back a complete record.
 */
async function authRequest(path: string, body: unknown): Promise<AuthResult> {
  if (!IS_ELECTRON) {
    return request<AuthResult>(path, {
      method: 'POST',
      // Names this device in the account's session list, so a user can tell
      // their laptop from a machine they no longer have.
      headers: clientNameHeader(),
      body: JSON.stringify(body),
    });
  }

  const result = await signIn(path, body);
  if (!result.ok) {
    const err = new Error(
      (result.body as { message?: string })?.message || `Sign-in failed (${result.status}).`,
    ) as ApiError;
    err.status = result.status;
    err.body = result.body;
    throw err;
  }
  // The session exists now, so this call is authenticated — main attaches the
  // token it just kept. `force`, because a cached /auth/me on this machine
  // belongs to whoever was signed in before.
  const me = await api.me({ force: true });
  return {
    token: '',
    refreshToken: '',
    expiresIn: 0,
    refreshExpiresAt: '',
    user: {
      id: me.id,
      email: me.email,
      name: me.name,
      role: me.role,
      emailVerified: me.emailVerified,
    },
  };
}

export const api = {
  // auth
  register: (email: string, password: string, name?: string) =>
    authRequest('/auth/register', { email, password, name }),
  login: (email: string, password: string) =>
    authRequest('/auth/login', { email, password }),
  /**
   * End this device's session.
   *
   * `clearSession` is the whole operation now, not a local half of it: on
   * desktop it calls through to main, which revokes server-side and THEN drops
   * the stored credential — and drops it even if that call fails, because a
   * sign-out that leaves a usable refresh token behind because the network was
   * down is not a sign-out. This side never held the token to present, which is
   * exactly why the request could not stay here.
   */
  logout: async (): Promise<{ ok: true }> => {
    await clearSession();
    return { ok: true };
  },
  /**
   * Which social sign-in providers this server can actually use.
   *
   * The sign-in screen renders this list and nothing else, so an unconfigured
   * provider produces no button. It replaced two hardcoded buttons that called
   * `alert('placeholder')`.
   */
  authProviders: () =>
    cachedGet<{ providers: { id: 'google' | 'github'; label: string }[] }>('/auth/providers', {
      // Deployment config: it cannot change without a restart.
      ttlMs: 3_600_000,
    }),
  /**
   * Where to send the browser to begin a provider sign-in.
   *
   * `client=desktop` tells the backend to return the one-time code via the
   * premation:// deep link instead of the web app — used when the Electron shell
   * opens this URL in the system browser.
   */
  oauthStartUrl: (provider: 'google' | 'github', client: 'web' | 'desktop' = 'web') =>
    `${apiBaseUrl()}/auth/oauth/${provider}/start${client === 'desktop' ? '?client=desktop' : ''}`,
  /** Swap the one-time code from the OAuth redirect for a real session. */
  oauthExchange: (code: string) => authRequest('/auth/oauth/exchange', { code }),

  /** Devices with a live session. */
  listSessions: () => request<SessionRecord[]>('/auth/sessions'),
  /** Sign out everywhere, including here. */
  revokeAllSessions: () =>
    request<{ revoked: number }>('/auth/sessions', { method: 'DELETE' }),
  /**
   * The account. Cached, because it is requested on boot, on every return to
   * the dashboard, and by the account panel — and because it costs the server
   * two aggregates over everything the user owns.
   */
  me: (opts: { force?: boolean } = {}) =>
    cachedGet<AccountRecord>('/auth/me', { tags: ['account'], force: opts.force }),

  /**
   * Ask for a reset link. Always resolves the same way whether or not the
   * address has an account — the server refuses to be a membership oracle, so
   * the UI must not promise "sent", only "if that address has an account".
   */
  forgotPassword: (email: string) =>
    request<{ ok: true }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  /**
   * Spend the emailed token. Signs in on success; every old session dies.
   *
   * Through `authRequest`, like the other routes whose response is a session:
   * it used to use the generic `request`, which on desktop meant the tokens
   * came back to the renderer and main never adopted them — so the app showed
   * the user as signed in and then 401'd on every call it made.
   */
  resetPassword: (token: string, password: string) =>
    authRequest('/auth/reset-password', { token, password }),

  // projects
  /**
   * A page of projects. `q` and `orientation` filter server-side — they must,
   * because filtering a single page in the browser is filtering the wrong set.
   */
  listProjects: (
    params: PageQuery & { q?: string; orientation?: 'landscape' | 'portrait' | 'square' } = {},
  ) =>
    cachedGet<Paginated<ProjectSummary>>(`/projects${query({ ...params })}`, {
      tags: ['projects'],
    }),
  createProject: (name: string, document?: unknown) =>
    request<ProjectRecord>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, document }),
    }).then(tap(['projects', 'account'])),
  /**
   * The full document. Deliberately NOT cached: it is megabytes, the editor
   * takes ownership of it the moment it loads, and a second copy in the cache
   * would be both dead weight and a chance to hand back a stale document to a
   * later open.
   */
  getProject: (id: string) => request<ProjectRecord>(`/projects/${id}`),
  updateProject: (
    id: string,
    patch: { name?: string; document?: unknown; tags?: string[]; baseRevision?: number },
  ) =>
    request<ProjectRecord>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then(tap(['projects'])),
  /**
   * Autosave. Deliberately does NOT invalidate: it fires every few seconds and
   * changes a project's contents, not the summary fields any cached list is
   * showing. Invalidating here would mean a refetch of the project list on
   * every keystroke-driven save.
   */
  autosave: (id: string, document: unknown, time?: number, baseRevision?: number) =>
    request<{ id: string; revision: number; updatedAt: string }>(`/projects/${id}/autosave`, {
      method: 'PUT',
      body: JSON.stringify({ document, time, baseRevision }),
    }),
  /** Upload the project's poster frame, rendered by the editor. */
  setProjectThumbnail: (id: string, image: Blob) => {
    const form = new FormData();
    form.append('file', image, 'thumbnail.jpg');
    return request<ProjectSummary>(`/projects/${id}/thumbnail`, {
      method: 'PUT',
      body: form,
    }).then(tap(['projects']));
  },
  /** Move to the trash — recoverable for `retentionDays`. */
  deleteProject: (id: string) =>
    request<{ deleted: boolean; recoverable: boolean; retentionDays: number }>(`/projects/${id}`, {
      method: 'DELETE',
    }).then(tap(['projects', 'trash', 'account'])),
  listTrash: (params: PageQuery = {}) =>
    cachedGet<Paginated<TrashedProject>>(`/projects/trash${query({ ...params })}`, {
      tags: ['trash'],
    }),
  restoreProject: (id: string) =>
    request<ProjectSummary>(`/projects/${id}/restore`, { method: 'POST' }).then(
      tap(['projects', 'trash', 'account']),
    ),
  /** Irreversible. Only works on a project already in the trash. */
  destroyProject: (id: string) =>
    request<{ deleted: boolean; recoverable: boolean }>(`/projects/${id}/permanent`, {
      method: 'DELETE',
    }).then(tap(['projects', 'trash', 'account'])),

  // project versions / history
  listVersions: (projectId: string, params: PageQuery = {}) =>
    cachedGet<Paginated<ProjectVersionSummary>>(
      `/projects/${projectId}/versions${query({ ...params })}`,
      { tags: ['versions'], ttlMs: 15_000 },
    ),
  getVersion: (projectId: string, versionId: string) =>
    request<ProjectVersionRecord>(`/projects/${projectId}/versions/${versionId}`),
  saveVersion: (
    projectId: string,
    body: { label?: string; kind?: VersionKind; time?: number } = {},
  ) =>
    request<ProjectVersionSummary>(`/projects/${projectId}/versions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(tap(['versions'])),
  restoreVersion: (projectId: string, versionId: string) =>
    request<ProjectRecord>(`/projects/${projectId}/versions/${versionId}/restore`, {
      method: 'POST',
    }).then(tap(['projects', 'versions'])),

  // assets
  /**
   * Uncached on purpose: every item's `src` is rewritten on the way through
   * (a fresh signature, a same-origin path), so a cached copy would either
   * hold URLs that expire out from under it or force the rewrite to re-run and
   * allocate a new array on every read — losing the identity that makes
   * caching worth having.
   */
  listAssets: (projectId?: string, params: PageQuery = {}) =>
    request<Paginated<ImportedAssetDto>>(`/assets${query({ projectId, ...params })}`).then(
      (page) => ({
        ...page,
        items: page.items.map((a) => {
          registerFileUrl(a.src);
          return { ...a, src: assetUrl(a.src) };
        }),
      }),
    ),
  uploadAsset: (file: File, projectId?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (projectId) form.append('projectId', projectId);
    return request<ImportedAssetDto>('/assets', { method: 'POST', body: form }).then((a) => {
      registerFileUrl(a.src);
      invalidate('assets', 'account');
      return { ...a, src: assetUrl(a.src) };
    });
  },
  deleteAsset: (id: string) =>
    request<{ deleted: boolean }>(`/assets/${id}`, { method: 'DELETE' }).then(
      tap(['assets', 'account']),
    ),

  // billing — plans and entitlement. There is deliberately no "set my plan" call,
  // no "start my trial" call and no "mark me verified" call: each would be a free
  // Pro button. Entitlement is decided server-side, by the payment webhook, the
  // verification link, or an operator.
  /** The catalog changes only on a deploy — an hour of staleness is nothing. */
  listPlans: () => cachedGet<PlanDto[]>('/billing/plans', { tags: ['billing'], ttlMs: 3_600_000 }),
  getBilling: (opts?: { force?: boolean }) =>
    cachedGet<BillingSummary>('/billing/me', {
      tags: ['billing', 'account'],
      force: opts?.force,
    }),
  startCheckout: (plan: string) =>
    request<BillingChangeResult>('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }).then(tap(['billing', 'account'])),
  /**
   * A fresh link to Lemon Squeezy's customer portal.
   *
   * Not cached, deliberately: the URL is signed and expires in about a day, so a
   * cached one is a support ticket waiting to happen.
   */
  openBillingPortal: () => request<{ url: string }>('/billing/portal', { method: 'POST' }),
  cancelSubscription: () =>
    request<BillingChangeResult>('/billing/cancel', { method: 'POST' }).then(
      tap(['billing', 'account']),
    ),
  resumeSubscription: () =>
    request<BillingChangeResult>('/billing/resume', { method: 'POST' }).then(
      tap(['billing', 'account']),
    ),
  /**
   * Re-read this account's subscription from the payment provider.
   *
   * The user-facing repair path for a webhook that never arrived: someone who has
   * paid and still sees "Trial" can fix it themselves instead of waiting for
   * support. Invalidates the billing cache so the panel redraws from the truth.
   */
  resyncBilling: () =>
    request<{ resynced: boolean }>('/billing/resync', { method: 'POST' }).then(
      tap(['billing', 'account']),
    ),

  // auth — email confirmation. `confirmEmail` is AUTHENTICATED: the user types a
  // short code inside the desktop app they signed up in, and the code is only
  // safe because it can only be tested against the caller's own account. Tapping
  // 'account' refreshes the cached /auth/me so the app leaves the gated state.
  confirmEmail: (code: string) =>
    request<{ verified: true; trialEndsAt: string | null; alreadyVerified: boolean }>(
      '/auth/verify-email',
      { method: 'POST', body: JSON.stringify({ code }) },
    ).then(tap(['billing', 'account'])),
  resendVerification: () =>
    request<{ sent: true }>('/auth/verify-email/resend', { method: 'POST' }),

  // ai — the backend is the gateway. Keys are stored server-side (encrypted;
  // only {present, hint} ever comes back) and model calls stream through
  // POST /ai/stream (see core/ai/AgentLoop, which does its own fetch because
  // it needs the raw byte stream, not JSON).
  /**
   * The models the backend can actually route to.
   *
   * F13/F15: this endpoint has existed since the gateway shipped and had no
   * client, so the editor's picker was driven by `MODEL_SUGGESTIONS` — a
   * hand-maintained duplicate of `ModelRouter.CAPABILITY_MATRIX`. Two lists of
   * model ids maintained by hand is two lists that go stale independently, and
   * the one the user picks from was the one nobody validated against a live key.
   */
  getAiModels: () => request<AiModelsResponse>('/ai/models'),
  getAiKeys: () => request<AiKeysResponse>('/ai/keys'),
  saveAiKey: (provider: AiProviderId, key: string) =>
    request<{ ok: boolean; reason?: 'invalid' | 'unavailable' }>(`/ai/keys/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ key }),
    }),
  clearAiKey: (provider: AiProviderId) =>
    request<{ ok: boolean }>(`/ai/keys/${provider}`, { method: 'DELETE' }),
  /**
   * Generate one image. Returns base64 bytes, never a provider URL.
   *
   * The server holds the key and does the call — the same custody boundary as
   * `/ai/stream`. Bytes rather than a signed URL so the asset outlives the
   * provider's expiry and the user's IP never reaches the provider.
   */
  generateImage: (body: { provider: string; prompt: string; width?: number; height?: number }) =>
    request<{ ok: boolean; base64: string; mime: string }>('/ai/image', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listConversations: (projectId?: string, params: PageQuery = {}) =>
    cachedGet<Paginated<AiConversationSummary>>(
      `/ai/conversations${query({ projectId, ...params })}`,
      { tags: ['conversations'] },
    ),
  getConversation: (id: string) => request<AiConversationRecord>(`/ai/conversations/${id}`),
  /** Append turns; creates the conversation on first write. */
  appendMessages: (
    id: string,
    payload: {
      messages: { role: 'user' | 'assistant'; content: string; isError?: boolean }[];
      projectId?: string;
      title?: string;
    },
  ) =>
    request<{ id: string; appended: number }>(`/ai/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(tap(['conversations'])),
  deleteConversation: (id: string) =>
    request<{ deleted: boolean }>(`/ai/conversations/${id}`, { method: 'DELETE' }).then(
      tap(['conversations']),
    ),

  // render
  /**
   * Ask the server to mux an mp4. It is the ONLY server-rendered format: the
   * editor rasterizes the frames itself and uploads them to
   * `uploadRenderFrames`. webm, image sequences, json and lottie are exported
   * entirely client-side (see core/export/exportManager) and never come here.
   */
  createRender: (payload: {
    format: 'mp4';
    projectId?: string;
    fps?: number;
    duration?: number;
    width?: number;
    height?: number;
    transparent?: boolean;
  }) =>
    request<RenderJobDto>('/render', { method: 'POST', body: JSON.stringify(payload) }).then(
      tap(['renders']),
    ),
  uploadRenderFrames: (id: string, file: Blob, ext: string) => {
    const form = new FormData();
    form.append('file', file, `frames.${ext}`);
    return request<{ success: boolean; resultUrl: string }>(`/render/${id}/frames`, {
      method: 'POST',
      body: form,
    }).then(tap(['renders']));
  },
  /**
   * Uncached: this is polled while a job runs, and the whole point of the poll
   * is to see `progress` move. The conditional GET still saves the body when
   * it hasn't.
   */
  getRender: (id: string) => request<RenderJobDto>(`/render/${id}`),
  /**
   * A page of render jobs. `status` filters server-side; `'active'` means
   * queued-or-running, which is the only honest way to count what's in flight
   * without holding the whole job history in the browser.
   */
  listRenders: (params: PageQuery & { status?: RenderStatusFilter } = {}) =>
    cachedGet<Paginated<RenderJobDto>>(`/render${query({ ...params })}`, {
      tags: ['renders'],
      // Short: a queue is the one list a user expects to be live.
      ttlMs: 5_000,
    }),
  cancelRender: (id: string) =>
    request<RenderJobDto>(`/render/${id}/cancel`, { method: 'POST' }).then(tap(['renders'])),

  // ── Automation API (JWT from the editor; n8n uses API keys on the same paths) ─
  listApiKeys: (opts?: { force?: boolean; limit?: number; offset?: number }) =>
    cachedGet<Paginated<ApiKeySummary>>(
      `/v1/keys${query({ limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 })}`,
      {
        tags: ['api-keys'],
        force: opts?.force,
      },
    ).then(asKeyPage),
  createApiKey: (name: string, opts?: { scopes?: string[]; expiresAt?: string | null }) =>
    request<CreatedApiKey>('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        // Omitted (not null) when unset: the server applies its default grant.
        ...(opts?.scopes?.length ? { scopes: opts.scopes } : {}),
        ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      }),
    }).then(tap(['api-keys'])),
  revokeApiKey: (id: string) =>
    request<{ revoked: boolean }>(`/v1/keys/${id}`, { method: 'DELETE' }).then(tap(['api-keys'])),

  listAutomationTemplates: (params: PageQuery = {}) =>
    cachedGet<Paginated<AutomationTemplateSummary>>(`/v1/templates${query({ ...params })}`, {
      tags: ['automation-templates'],
    }),
  getAutomationTemplate: (id: string) =>
    request<AutomationTemplateRecord>(`/v1/templates/${id}`),
  publishAutomationTemplate: (body: PublishTemplateRequest) =>
    request<AutomationTemplateRecord>('/v1/templates', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(tap(['automation-templates'])),
  deleteAutomationTemplate: (id: string) =>
    request<{ deleted: boolean }>(`/v1/templates/${id}`, { method: 'DELETE' }).then(
      tap(['automation-templates']),
    ),

  listAnimationTemplates: (params: PageQuery = {}) =>
    cachedGet<Paginated<AnimationTemplateSummary>>(`/v1/animations${query({ ...params })}`, {
      tags: ['animation-templates'],
    }),
  getAnimationTemplate: (id: string) => request<AnimationTemplateRecord>(`/v1/animations/${id}`),
  publishAnimationTemplate: (body: { name: string; animationData: unknown }) =>
    request<AnimationTemplateRecord>('/v1/animations', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(tap(['animation-templates'])),
  deleteAnimationTemplate: (id: string) =>
    request<{ deleted: boolean }>(`/v1/animations/${id}`, { method: 'DELETE' }).then(
      tap(['animation-templates']),
    ),

  createAutomationRender: (body: AutomationRenderRequest) =>
    request<AutomationRenderJob>('/v1/renders', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(tap(['renders', 'api-usage'])),
  getAutomationRender: (id: string) => request<AutomationRenderJob>(`/v1/renders/${id}`),

  getApiUsage: () => cachedGet<ApiUsageSummary>('/v1/usage', { tags: ['api-usage'] }),
};

function asKeyPage(raw: Paginated<ApiKeySummary> | ApiKeySummary[]): Paginated<ApiKeySummary> {
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length, limit: raw.length, offset: 0 };
  }
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    total: raw.total ?? 0,
    limit: raw.limit ?? 50,
    offset: raw.offset ?? 0,
  };
}

/**
 * Invalidate after a successful write, then pass the result straight through.
 *
 * Written as a `.then` combinator so the invalidation sits next to the request
 * it belongs to, rather than in the caller — where it is the thing everyone
 * forgets, and the omission shows up as a UI that silently disagrees with the
 * server until the next reload.
 */
function tap<T>(tags: Parameters<typeof invalidate>): (value: T) => T {
  return (value) => {
    invalidate(...tags);
    return value;
  };
}
