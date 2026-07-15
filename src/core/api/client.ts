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
 * Rewrite a backend-served asset URL to a same-origin relative path.
 *
 * The backend hands back absolute URLs like `http://localhost:4000/files/<key>`.
 * In the browser build those are cross-origin and blocked by the page CSP
 * (`default-src 'self'`), so images/video/audio never load. Collapsing them to
 * `/files/<key>` routes the request through the same-origin dev proxy (see
 * vite.config.ts) so it satisfies `'self'`. Blob/data URLs pass through
 * untouched.
 */
export function assetUrl(src: string | null | undefined): string {
  if (!src) return src ?? '';
  if (src.startsWith('blob:') || src.startsWith('data:')) return src;
  // Reduce any absolute backend URL to its `/files/...` path first.
  const m = src.match(/^https?:\/\/[^/]+(\/files\/.*)$/);
  const path = m ? m[1]! : src;
  if (path.startsWith('/files')) {
    // Electron has no dev proxy → the asset must be an absolute backend URL.
    // The browser uses the same-origin proxied path (satisfies CSP 'self').
    return IS_ELECTRON ? `${BACKEND_ORIGIN}${path}` : path;
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

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord extends ProjectSummary {
  document: unknown;
}

export interface ImportedAssetDto {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  src: string;
  size: number;
  metadata?: { width?: number; height?: number; duration?: number };
}

export interface Timing {
  t: number;
  curve?: string;
}

export interface SetOp {
  op: 'set';
  target: string;
  properties: Record<string, number>;
  timing: Timing;
}

export interface RemoveOp {
  op: 'remove';
  target: string;
  prop: string;
  timing: { t: number };
}

export interface MoveOp {
  op: 'move';
  target: string;
  prop: string;
  timing: { t: number; toT: number };
}

export interface EasingOp {
  op: 'easing';
  target: string;
  prop: string;
  timing: { t: number; curve: string };
}

export type KeyframeOp = SetOp | RemoveOp | MoveOp | EasingOp;

export type LayerKind = 'shape' | 'text' | 'image' | 'video' | 'group' | 'null';

/** Structural layer ops the assistant may emit. */
export type StructuralOp =
  | { op: 'create_layer'; target: string; properties: { kind: LayerKind; name: string } }
  | { op: 'delete_layer'; target: string }
  | { op: 'reparent_layer'; target: string; properties: { parentId: string | null } };

export type AiOp = KeyframeOp | StructuralOp;

export interface AiEditResult {
  label: string;
  message: string;
  ops: AiOp[];
  fallback: boolean;
  /** Set when the edit was persisted — reuse it to append to the same thread. */
  conversationId?: string;
}

export interface RenderJobDto {
  id: string;
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

export interface AiConversationSummary {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
}

export interface AiMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ops: AiOp[] | null;
  createdAt: string;
}

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
  me: () => request<{ id: string; email: string; name: string | null }>('/auth/me'),

  // projects
  listProjects: () => request<ProjectSummary[]>('/projects'),
  createProject: (name: string, document?: unknown) =>
    request<ProjectRecord>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, document }),
    }),
  getProject: (id: string) => request<ProjectRecord>(`/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; document?: unknown; baseRevision?: number }) =>
    request<ProjectRecord>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  autosave: (id: string, document: unknown, time?: number, baseRevision?: number) =>
    request<{ id: string; revision: number; updatedAt: string }>(`/projects/${id}/autosave`, {
      method: 'PUT',
      body: JSON.stringify({ document, time, baseRevision }),
    }),
  deleteProject: (id: string) => request<{ deleted: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  // project versions / history
  listVersions: (projectId: string) =>
    request<ProjectVersionSummary[]>(`/projects/${projectId}/versions`),
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
  listAssets: (projectId?: string) =>
    request<ImportedAssetDto[]>(`/assets${projectId ? `?projectId=${projectId}` : ''}`).then((list) =>
      list.map((a) => ({ ...a, src: assetUrl(a.src) })),
    ),
  uploadAsset: (file: File, projectId?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (projectId) form.append('projectId', projectId);
    return request<ImportedAssetDto>('/assets', { method: 'POST', body: form }).then((a) => ({
      ...a,
      src: assetUrl(a.src),
    }));
  },
  deleteAsset: (id: string) => request<{ deleted: boolean }>(`/assets/${id}`, { method: 'DELETE' }),

  // ai
  aiEdit: (payload: {
    prompt: string;
    projectId?: string;
    document?: unknown;
    selection?: string[];
    atTime?: number;
    conversationId?: string;
  }) => request<AiEditResult>('/ai/edit', { method: 'POST', body: JSON.stringify(payload) }),
  listConversations: () => request<AiConversationSummary[]>('/ai/conversations'),
  getConversation: (id: string) => request<AiConversationRecord>(`/ai/conversations/${id}`),

  // render
  createRender: (payload: {
    format: 'webm' | 'png' | 'json' | 'lottie' | 'mp4';
    projectId?: string;
    document?: unknown;
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
  listRenders: () => request<RenderJobDto[]>('/render'),
  cancelRender: (id: string) => request<RenderJobDto>(`/render/${id}/cancel`, { method: 'POST' }),
};
