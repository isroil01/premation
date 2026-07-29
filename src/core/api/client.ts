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
import { clientNameHeader, currentRefreshToken } from './session';

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
  user: { id: string; email: string; name: string | null; role: UserRole };
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
  plan: 'free' | 'pro';
  aiCredits: number;
  aiCreditsUsed: number;
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
  id: 'free' | 'pro';
  name: string;
  priceCents: number;
  priceLabel: string;
  currency: 'usd';
  monthlyCredits: number;
  features: string[];
}

export interface BillingSummary {
  plan: PlanDto;
  credits: number;
  creditsUsedAllTime: number;
  creditsUsedLast30Days: number;
  memberSince: string;
  /** False until a payment provider is configured — gates the upgrade CTA. */
  paymentsEnabled: boolean;
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

export const api = {
  // auth
  register: (email: string, password: string, name?: string) =>
    request<AuthResult>('/auth/register', {
      method: 'POST',
      headers: clientNameHeader(),
      body: JSON.stringify({ email, password, name }),
    }),
  login: (email: string, password: string) =>
    request<AuthResult>('/auth/login', {
      method: 'POST',
      // Names this device in the account's session list, so a user can tell
      // their laptop from a machine they no longer have.
      headers: clientNameHeader(),
      body: JSON.stringify({ email, password }),
    }),
  /**
   * Revoke this device's refresh token server-side.
   *
   * Clearing it locally is not enough on its own: a copy taken from the
   * keystore would otherwise stay valid for the rest of its 90 days.
   */
  logout: () =>
    request<{ ok: true }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: currentRefreshToken() ?? undefined }),
    }),
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
  /** Where to send the browser to begin a provider sign-in. */
  oauthStartUrl: (provider: 'google' | 'github') => `${apiBaseUrl()}/auth/oauth/${provider}/start`,
  /** Swap the one-time code from the OAuth redirect for a real session. */
  oauthExchange: (code: string) =>
    request<AuthResult>('/auth/oauth/exchange', {
      method: 'POST',
      headers: clientNameHeader(),
      body: JSON.stringify({ code }),
    }),

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
  /** Spend the emailed token. Signs in on success; every old session dies. */
  resetPassword: (token: string, password: string) =>
    request<AuthResult>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

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

  // billing — plans and credits. There is deliberately no "set my plan" call:
  // entitlement is decided server-side, by a payment webhook or an operator.
  /** The catalog changes only on a deploy — an hour of staleness is nothing. */
  listPlans: () => cachedGet<PlanDto[]>('/billing/plans', { tags: ['billing'], ttlMs: 3_600_000 }),
  getBilling: () => cachedGet<BillingSummary>('/billing/me', { tags: ['billing', 'account'] }),
  startCheckout: (plan: 'pro') =>
    request<{ url: string }>('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }),

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
    request<{ ok: boolean; base64: string; mime: string; creditsUsed: number }>('/ai/image', {
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
};

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
