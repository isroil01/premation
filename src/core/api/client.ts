/**
 * Motion backend API client.
 *
 * A thin fetch wrapper that talks to motion-back (NestJS). Auth is a bearer JWT
 * kept in localStorage; every request carries it when present. The client is
 * intentionally dependency-free so it can be used from stores, adapters, and the
 * assistant alike.
 */

import { API_URL, BACKEND_ORIGIN, IS_ELECTRON } from './env';

const BASE_URL: string = API_URL || 'http://localhost:4000/api';

/** Absolute/relative API base — for callers that need a raw fetch (AI stream). */
export const apiBaseUrl = (): string => BASE_URL;

const TOKEN_KEY = 'motion-editor.auth-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** True when the user has a stored session — gates cloud features. */
export function isAuthenticated(): boolean {
  return getToken() !== null;
}

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

/**
 * A page of a list endpoint.
 *
 * These used to return bare arrays of everything the account owned. `total` is
 * the count ignoring paging, so a UI can say "showing 20 of 143" rather than
 * pretending 20 is all there is.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PageQuery {
  limit?: number;
  offset?: number;
}

/** `{limit, offset, q}` → "?limit=20&offset=40&q=promo", omitting what's unset. */
function query(params: Record<string, string | number | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

/**
 * Freshly signed `/files/...` URLs from this session's API responses, keyed by
 * their bare path (no query).
 *
 * Locally stored backend files are served behind expiring HMAC signatures
 * (`?exp=…&sig=…`). Project documents persist asset `src` strings, so a
 * reloaded document holds yesterday's signature — dead on arrival. Every asset
 * list/upload response registers its fresh URL here, and `assetUrl()` swaps a
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !(init.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    const err = new Error(
      (body as { message?: string })?.message || `Request failed (${res.status})`,
    ) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Types (mirror the backend contracts) ────────────────────────────────────
export interface AuthResult {
  token: string;
  user: { id: string; email: string; name: string | null };
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

export interface AiConversationRecord extends AiConversationSummary {
  messages: AiMessageRecord[];
}

export const api = {
  // auth
  register: (email: string, password: string, name?: string) =>
    request<AuthResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),
  login: (email: string, password: string) =>
    request<AuthResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<AccountRecord>('/auth/me'),

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
   * A page of projects. `q` searches server-side — it must, because filtering
   * a single page in the browser is filtering the wrong set.
   */
  listProjects: (params: PageQuery & { q?: string } = {}) =>
    request<Paginated<ProjectSummary>>(`/projects${query({ ...params })}`),
  createProject: (name: string, document?: unknown) =>
    request<ProjectRecord>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, document }),
    }),
  getProject: (id: string) => request<ProjectRecord>(`/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; document?: unknown; tags?: string[]; baseRevision?: number }) =>
    request<ProjectRecord>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  autosave: (id: string, document: unknown, time?: number, baseRevision?: number) =>
    request<{ id: string; revision: number; updatedAt: string }>(`/projects/${id}/autosave`, {
      method: 'PUT',
      body: JSON.stringify({ document, time, baseRevision }),
    }),
  /** Upload the project's poster frame, rendered by the editor. */
  setProjectThumbnail: (id: string, image: Blob) => {
    const form = new FormData();
    form.append('file', image, 'thumbnail.jpg');
    return request<ProjectSummary>(`/projects/${id}/thumbnail`, { method: 'PUT', body: form });
  },
  /** Move to the trash — recoverable for `retentionDays`. */
  deleteProject: (id: string) =>
    request<{ deleted: boolean; recoverable: boolean; retentionDays: number }>(`/projects/${id}`, {
      method: 'DELETE',
    }),
  listTrash: (params: PageQuery = {}) =>
    request<Paginated<TrashedProject>>(`/projects/trash${query({ ...params })}`),
  restoreProject: (id: string) =>
    request<ProjectSummary>(`/projects/${id}/restore`, { method: 'POST' }),
  /** Irreversible. Only works on a project already in the trash. */
  destroyProject: (id: string) =>
    request<{ deleted: boolean; recoverable: boolean }>(`/projects/${id}/permanent`, {
      method: 'DELETE',
    }),

  // project versions / history
  listVersions: (projectId: string, params: PageQuery = {}) =>
    request<Paginated<ProjectVersionSummary>>(`/projects/${projectId}/versions${query({ ...params })}`),
  getVersion: (projectId: string, versionId: string) =>
    request<ProjectVersionRecord>(`/projects/${projectId}/versions/${versionId}`),
  saveVersion: (
    projectId: string,
    body: { label?: string; kind?: VersionKind; time?: number } = {},
  ) =>
    request<ProjectVersionSummary>(`/projects/${projectId}/versions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  restoreVersion: (projectId: string, versionId: string) =>
    request<ProjectRecord>(`/projects/${projectId}/versions/${versionId}/restore`, {
      method: 'POST',
    }),

  // assets
  listAssets: (projectId?: string, params: PageQuery = {}) =>
    request<Paginated<ImportedAssetDto>>(`/assets${query({ projectId, ...params })}`).then((page) => ({
      ...page,
      items: page.items.map((a) => {
        registerFileUrl(a.src);
        return { ...a, src: assetUrl(a.src) };
      }),
    })),
  uploadAsset: (file: File, projectId?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (projectId) form.append('projectId', projectId);
    return request<ImportedAssetDto>('/assets', { method: 'POST', body: form }).then((a) => {
      registerFileUrl(a.src);
      return { ...a, src: assetUrl(a.src) };
    });
  },
  deleteAsset: (id: string) => request<{ deleted: boolean }>(`/assets/${id}`, { method: 'DELETE' }),

  // billing — plans and credits. There is deliberately no "set my plan" call:
  // entitlement is decided server-side, by a payment webhook or an operator.
  listPlans: () => request<PlanDto[]>('/billing/plans'),
  getBilling: () => request<BillingSummary>('/billing/me'),
  startCheckout: (plan: 'pro') =>
    request<{ url: string }>('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }),

  // ai — the backend is the gateway. Keys are stored server-side (encrypted;
  // only {present, hint} ever comes back) and model calls stream through
  // POST /ai/stream (see core/ai/AgentLoop, which does its own fetch because
  // it needs the raw byte stream, not JSON).
  getAiKeys: () => request<AiKeysResponse>('/ai/keys'),
  saveAiKey: (provider: AiProviderId, key: string) =>
    request<{ ok: boolean; reason?: 'invalid' | 'unavailable' }>(`/ai/keys/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ key }),
    }),
  clearAiKey: (provider: AiProviderId) =>
    request<{ ok: boolean }>(`/ai/keys/${provider}`, { method: 'DELETE' }),

  listConversations: (projectId?: string, params: PageQuery = {}) =>
    request<Paginated<AiConversationSummary>>(`/ai/conversations${query({ projectId, ...params })}`),
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
    }),
  deleteConversation: (id: string) =>
    request<{ deleted: boolean }>(`/ai/conversations/${id}`, { method: 'DELETE' }),

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
  }) => request<RenderJobDto>('/render', { method: 'POST', body: JSON.stringify(payload) }),
  uploadRenderFrames: (id: string, file: Blob, ext: string) => {
    const form = new FormData();
    form.append('file', file, `frames.${ext}`);
    return request<{ success: boolean; resultUrl: string }>(`/render/${id}/frames`, { method: 'POST', body: form });
  },
  getRender: (id: string) => request<RenderJobDto>(`/render/${id}`),
  listRenders: (params: PageQuery = {}) => request<Paginated<RenderJobDto>>(`/render${query({ ...params })}`),
  cancelRender: (id: string) => request<RenderJobDto>(`/render/${id}/cancel`, { method: 'POST' }),
};
