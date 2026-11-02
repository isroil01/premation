/**
 * Help ▸ Report a Problem — everything that is not the dialog.
 *
 * What a report carries, and the line it does not cross: SAFE diagnostics are
 * always attached (build, OS, GPU, engine state, a path-scrubbed engine.log
 * tail, how many layers are failing and at which stage). The project — its
 * name, file paths, layer error messages — goes only when the user ticks the
 * box, in a separate `projectInfo` the server stores apart. The server scrubs
 * paths out of `diagnostics` again on arrival (motion-back problem-reports),
 * so an older or modified client cannot break the promise either.
 */

import { request } from '@core/api/transport';
import { APP_VERSION } from './whatsNew';

export const REPORT_CATEGORIES = [
  'crash',
  'rendering',
  'performance',
  'playback',
  'export',
  'import',
  'text',
  'effects',
  'audio',
  'ui',
  'plugins',
  'account',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_IMPACTS = ['blocker', 'major', 'minor'] as const;
export type ReportImpact = (typeof REPORT_IMPACTS)[number];

export interface ReportDraft {
  category: ReportCategory;
  impact: ReportImpact;
  summary: string;
  description: string;
  steps: string;
  email: string;
  includeProject: boolean;
}

export interface ReportResult {
  id: string;
  number: string;
  status: string;
  attachments: number;
}

/** The mirror's surface this module reads — a structural type, so tests pass a fake. */
export interface ProjectSource {
  readonly projectPath: string;
  readonly items: ReadonlyMap<string, { kind: string; name: string; path: string; missing: boolean }>;
  readonly comps: ReadonlyMap<string, { layers: readonly string[] }>;
  layerErrors(comp: string): ReadonlyArray<{ stage: string; message: string }>;
}

/** Safe, countable facts about the open project: no names, no paths, no messages. */
export function safeProjectFacts(src: ProjectSource | null): Record<string, unknown> | null {
  if (!src) return null;
  const itemKinds: Record<string, number> = {};
  let missingFootage = 0;
  for (const it of src.items.values()) {
    itemKinds[it.kind] = (itemKinds[it.kind] ?? 0) + 1;
    if (it.missing) missingFootage++;
  }
  let layers = 0;
  const errorStages: Record<string, number> = {};
  for (const [id, comp] of src.comps) {
    layers += comp.layers.length;
    for (const e of src.layerErrors(id)) errorStages[e.stage] = (errorStages[e.stage] ?? 0) + 1;
  }
  return { comps: src.comps.size, layers, itemKinds, missingFootage, layerErrorStages: errorStages };
}

/** The opt-in half: what the user agreed to share when they ticked the box. */
export function projectDetails(src: ProjectSource | null): Record<string, unknown> | null {
  if (!src) return null;
  const errors: Array<{ comp: string; stage: string; message: string }> = [];
  for (const id of src.comps.keys()) {
    for (const e of src.layerErrors(id)) errors.push({ comp: src.items.get(id)?.name ?? id, stage: e.stage, message: e.message });
  }
  return {
    projectPath: src.projectPath || null,
    footage: [...src.items.values()]
      .filter((i) => i.path)
      .slice(0, 100)
      .map((i) => ({ name: i.name, path: i.path, missing: i.missing })),
    comps: [...src.comps.keys()].slice(0, 50).map((id) => ({ name: src.items.get(id)?.name ?? id, layers: src.comps.get(id)?.layers.length ?? 0 })),
    layerErrors: errors.slice(0, 50),
  };
}

/** Validation the dialog shows inline. Empty object = sendable. */
export function validateDraft(d: ReportDraft): Partial<Record<'summary' | 'description' | 'email', string>> {
  const out: Partial<Record<'summary' | 'description' | 'email', string>> = {};
  if (d.summary.trim().length < 4) out.summary = 'summary';
  if (!d.description.trim()) out.description = 'description';
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) out.email = 'email';
  return out;
}

export interface BuildInput {
  draft: ReportDraft;
  diagnostics: Record<string, unknown>;
  project: ProjectSource | null;
  screenshot: Blob | null;
}

/** The multipart body the server takes: `payload` JSON + optional `screenshot`. */
export function buildReportForm({ draft, diagnostics, project, screenshot }: BuildInput): FormData {
  const payload = {
    category: draft.category,
    impact: draft.impact,
    summary: draft.summary.trim(),
    description: draft.description.trim(),
    ...(draft.steps.trim() ? { steps: draft.steps.trim() } : {}),
    ...(draft.email.trim() ? { email: draft.email.trim() } : {}),
    diagnostics: { ...diagnostics, app: { ...(diagnostics.app as object | undefined), version: (diagnostics.app as { version?: string } | undefined)?.version ?? APP_VERSION }, project: safeProjectFacts(project) },
    includeProject: draft.includeProject,
    ...(draft.includeProject ? { projectInfo: projectDetails(project) ?? {} } : {}),
  };
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  if (screenshot) form.append('screenshot', screenshot, 'viewport.png');
  return form;
}

export function submitReport(form: FormData): Promise<ReportResult> {
  return request<ReportResult>('/problem-reports', { method: 'POST', body: form });
}

/**
 * The diagnostics object. From main when there is one (desktop); a minimal
 * renderer-side version otherwise (browser build, tests) — still nothing that
 * names a file.
 */
export async function collectDiagnostics(): Promise<Record<string, unknown>> {
  const fromMain = await window.motionEditor?.diag?.problemDiagnostics?.().catch(() => null);
  if (fromMain) return fromMain;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  return {
    app: { version: APP_VERSION, packaged: false },
    os: { platform: nav?.platform ?? 'unknown', userAgent: nav?.userAgent ?? '' },
    gpu: {},
    engine: null,
    logTail: [],
    capturedAt: new Date().toISOString(),
  };
}

/** The viewer's on-screen rectangle, for the capture. Null when no viewer is mounted. */
export function viewportRect(doc: Document = document): { x: number; y: number; width: number; height: number } | null {
  const el = doc.querySelector('[data-engine-surface="viewport"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** A PNG of the viewer as it is right now, or null (browser build, no viewer, capture refused). */
export async function captureViewport(): Promise<Blob | null> {
  const rect = viewportRect();
  const capture = window.motionEditor?.diag?.captureViewport;
  if (!rect || !capture) return null;
  try {
    const bytes = await capture(rect);
    return bytes && bytes.byteLength > 0 ? new Blob([bytes as BlobPart], { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}
