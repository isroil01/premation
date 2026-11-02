/**
 * Runs an MCP client's tool calls in the editor (docs/MCP_PLAN.md D2, §3.3).
 *
 * Main relays each call from the MCP pipe to this page; this runs it with the
 * SAME registry, ToolContext and engine transaction the in-app assistant uses
 * (`getAiRegistry`, `sessionToolContext`, `beginAiTransaction`). There is no
 * second implementation of any tool here — only what an outside client needs
 * on top: undo grouping across calls, render feedback as MCP images, the
 * author-mode entry point, and the paid-plan gate.
 *
 * ## Undo (D4)
 *
 *   • A changing call outside a group is ONE engine gesture = one undo entry,
 *     labelled `Claude: <tool>`, rolled back whole if the tool fails.
 *   • `begin_edit(label)` opens a gesture that every following call joins,
 *     until `end_edit` (commit or roll back). It also closes itself after
 *     GROUP_IDLE_MS without a call, when the client disconnects, and when the
 *     user starts editing (`userActivity`) — so the user's own edits do not
 *     land in Claude's undo step.
 *
 * Calls run one at a time (a queue), whichever client sent them.
 *
 * No React, no zustand: the editor's hook (src/hooks/useMcpHost.ts) wires this
 * to the preload bridge and renders the "Claude is editing" badge from
 * `subscribe`.
 */

import type { AiToolDef, ToolContext, ToolRegistry, ToolResult } from '@motion/ai-tools';
import { isMcpTool, mutates } from '@motion/ai-tools';
import {
  adviseScript,
  authorSystemPrompt,
  describeRecent,
  fingerprintScript,
  coerceScript,
  compileScript,
  sameFrameKeys,
  formatAdvice,
  formatRepairs,
  type PieceHistory,
} from '@motion/author';
import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { activeCompRootId } from '@core/scene/activeComp';
import type { AiTransaction } from '../aiTransaction';
import { beatNameOfRoot, FRONT_GLOBALS_ROOT_NAME } from '../structureAdvisors';
import { SFX_ITEMS, getSfxItem } from '@core/library/sfxLibrary';
import type { MotionSheetInput } from '../filmstrip';
import { analyzeMotionText, motionSheetData } from './motionTools';
import { rigCharacter, rigCycle, rigViewData, type RigView } from '../rigTools';
import type { AssetDescription, SubjectView } from '../mediaTools';
import {
  describeEntry,
  findLibraryEntry,
  insertForPreview,
  insertLibraryItem,
  insertRoute,
  premiumPoster,
  previewSpan,
  searchLibraryText,
  type LibraryEditorOps,
} from './libraryTools';
import {
  applyLook,
  applyTechnique,
  castPiece,
  designGuide,
  listLooks,
  listTechniques,
  reviewDesign,
  type SessionLook,
} from './designTools';

/** An open `begin_edit` group closes itself after this long without a call. */
export const GROUP_IDLE_MS = 30_000;

/** MCP's CallToolResult. */
export interface McpResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface McpCall {
  clientId: number;
  name: string;
  args: unknown;
}

/** What the badge shows. */
export interface McpActivity {
  /** A call is running right now. */
  busy: boolean;
  /** The tool running, when busy. */
  tool: string | null;
  /** The open group's label, or null. */
  group: string | null;
}

/** May this account use Claude for Premation? */
export type AccessDecision = { ok: true } | { ok: false; message: string };

/** Something only the user may allow (a file in, a render out). */
export interface ApprovalRequest {
  kind: 'import' | 'export';
  /** One line: "Import 3 files", "Render Main Comp to MP4". */
  title: string;
  /** What exactly: the paths, the format. */
  detail: string[];
}

/**
 * Project-level editor operations an MCP client needs beyond the tool
 * registry. Injected (src/hooks/mcpEditorOps.ts) because they live in the
 * editor's layout code, which src/core may not import.
 */
export interface McpEditorOps {
  listCompositions(): Promise<unknown>;
  /** The new composition's id, or a sentence saying why not. */
  createComposition(o: { name: string; width: number; height: number; fps: number; durationSeconds: number; background: string }): Promise<{ id: string } | { error: string }>;
  setActiveComposition(compId: string): Promise<{ ok: true; name: string } | { error: string }>;
  /** Removes the compositions (and the precomp layers showing them) as one undo step. */
  deleteCompositions(compIds: readonly string[]): Promise<{ ok: true; names: string[]; layersRemoved: number } | { error: string }>;
  save(): Promise<{ ok: true; message: string } | { error: string }>;
  /** `atSec`: where each placed clip starts, comp seconds. */
  importMedia(paths: readonly string[], placeOnTimeline: boolean, atSec?: number): Promise<{ ok: true; message: string } | { error: string }>;
  /**
   * A built-in sound effect as an audio layer starting at `atSec`; its layer id.
   * `inGroup`: the host holds an open `begin_edit` gesture the insert must join
   * (its own gesture would be refused, B2).
   */
  addSfx(id: string, atSec: number, levelDb: number | null, opts?: { inGroup?: boolean }): Promise<{ id: string } | { error: string }>;
  setAudioLevels(nodeId: string, o: { levelDb?: number; fadeInSec?: number; fadeOutSec?: number }): Promise<{ ok: true; message: string } | { error: string }>;
  duck(musicId: string, voiceId: string, duckDb: number): Promise<{ ok: true; message: string } | { error: string }>;
  /** Library inserts only the editor can run (templates, Cloud items). */
  library?: Omit<LibraryEditorOps, 'addSfx'>;
}

/** render_frame's options beyond time and size (all optional; the active composition, whole, by default). */
export interface StillOptions {
  /** Another composition of the project. */
  compId?: string;
  /** Solo: only these layers of the composition are drawn (the project is untouched). */
  layerIds?: string[];
  /** Crop to this rectangle, comp px. */
  region?: { x: number; y: number; w: number; h: number };
  /** Magnify about the centre of the frame (or of `region`): show 1/zoom of it. */
  zoom?: number;
  /** A frame of an imported asset (source seconds) instead of a composition. */
  assetId?: string;
}

export interface McpHostDeps {
  registry(): Pick<ToolRegistry, 'execute' | 'has' | 'get'>;
  beginTransaction(label: string): Promise<AiTransaction>;
  /** A context over `session` that keeps the run's style/scene window and the client's aliases. */
  context(session: AiTransaction['session'] | null, signal: AbortSignal, aliases: Map<string, string>): ToolContext;
  /** Start a run (resets the scene window, style, entrance seed); called once per client. */
  freshRun(signal: AbortSignal): void;
  /**
   * PNG of the active composition at `seconds`, long side ≤ maxSize; null if
   * it could not draw. `opts` (render_frame's compId / layerIds / region /
   * zoom / assetId) may be refused with a sentence (`{ error }`).
   */
  renderStill(seconds: number, maxSize: number, opts?: StillOptions): Promise<{ mimeType: string; data: string } | { error: string } | null>;
  /** A subject's matte preview (the layer cropped, outlines drawn); absent = text only. */
  renderSubjectView?(view: SubjectView): Promise<{ mimeType: string; data: string } | null>;
  /** describe_asset's contact sheet of an imported footage item; absent = text only. */
  renderAssetSheet?(itemId: string, durationSec: number, cells: number): Promise<{ mimeType: string; data: string } | null>;
  /** A labelled contact sheet of `cells` frames between two times. */
  renderStrip(startSec: number, endSec: number, cells: number): Promise<{ mimeType: string; data: string } | null>;
  /** render_motion_sheet's images (frame strip, onion skin with trails); absent = text only. */
  renderMotionSheet?(input: MotionSheetInput): Promise<{ mimeType: string; data: string }[]>;
  /** render_rig_view's image (the layer cropped, grid and rig drawn on it); absent = text only. */
  renderRigView?(view: RigView): Promise<{ mimeType: string; data: string } | null>;
  access(): Promise<AccessDecision>;
  editor?: McpEditorOps;
  /** Ask the user in Premation; resolves false on Deny or timeout. Absent = always refused. */
  approve?(request: ApprovalRequest): Promise<boolean>;
  /** The last pieces made (@motion/author variety.ts): shown in the author guide, checked by the advisors and review_design. */
  pieceHistory?: PieceHistory;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Group {
  tx: AiTransaction;
  label: string;
  clientId: number;
  timer: unknown;
}

const text = (t: string, isError = false): McpResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function fromToolResult(r: ToolResult): McpResult {
  const parts = [r.content];
  if (r.data !== undefined) {
    try {
      parts.push(JSON.stringify(r.data, null, 1));
    } catch { /* unserialisable data: the prose is enough */ }
  }
  return text(parts.filter(Boolean).join('\n'), !r.ok);
}

function obj(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** render_frame's options, checked; a sentence when they cannot be honoured together. */
export function stillOptions(a: Record<string, unknown>): StillOptions | { error: string } {
  const out: StillOptions = {};
  if (typeof a.compId === 'string' && a.compId) out.compId = a.compId;
  if (typeof a.assetId === 'string' && a.assetId) out.assetId = a.assetId;
  if (Array.isArray(a.layerIds)) {
    const ids = a.layerIds.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 60);
    if (ids.length) out.layerIds = ids;
  }
  if (a.region && typeof a.region === 'object') {
    const r = a.region as Record<string, unknown>;
    const x = num(r.x, NaN), y = num(r.y, NaN), w = num(r.w, NaN), h = num(r.h, NaN);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return { error: 'region needs numeric x, y and positive w, h (composition px).' };
    out.region = { x, y, w, h };
  }
  if (a.zoom !== undefined) {
    const z = num(a.zoom, NaN);
    if (!Number.isFinite(z) || z < 1 || z > 16) return { error: 'zoom must be between 1 and 16.' };
    if (z > 1) out.zoom = z;
  }
  if (out.assetId && (out.compId || out.layerIds)) return { error: 'assetId renders an imported asset on its own: drop compId / layerIds (region and zoom still apply).' };
  return out;
}

/**
 * Remove what an earlier build of `script` left in the composition: the beat
 * roots whose beat name the script has again (`compileScript` names each root
 * `Beat N — <name>`, so a beat's identity is its name), the `Front globals`
 * root when the script has front globals, and — only when a beat root
 * matched, i.e. this IS a re-run — the top-level layers that carry a back
 * global's name. Children go with their roots. Returns what was removed.
 */
async function removeScriptLayers(ctx: ToolContext, script: { beats: readonly { name: string }[]; globals: readonly { name: string; stack?: string }[] }): Promise<string[]> {
  const all = await ctx.scene.all();
  const top = all.filter((n) => n.parent === null);
  const beatNames = new Set(script.beats.map((b) => b.name));
  const roots = top.filter((n) => {
    const beat = beatNameOfRoot(n.name);
    return beat !== null && beatNames.has(beat);
  });
  const victims = [...roots];
  if (script.globals.some((g) => g.stack === 'front')) victims.push(...top.filter((n) => n.name === FRONT_GLOBALS_ROOT_NAME));
  if (roots.length > 0) {
    const backNames = new Set(script.globals.filter((g) => g.stack !== 'front').map((g) => g.name));
    victims.push(...top.filter((n) => backNames.has(n.name) && !victims.includes(n)));
  }
  // The compositions the victims' precomp layers show (a beat's `precompose`):
  // removing the layer leaves its composition behind, and every rebuild of a
  // beat would add another orphan "Phone" / "Goals scene" to the project.
  const m = documentMirror();
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const under = (id: string): boolean => {
    for (let n = byId.get(id); n; n = n.parent ? byId.get(n.parent) : undefined) if (victims.some((v) => v.id === n!.id)) return true;
    return false;
  };
  const shown = new Set<string>();
  for (const n of all) {
    const source = m.layer(n.id)?.source;
    if (source && m.comp(source) && under(n.id)) shown.add(source);
  }
  const removed: string[] = [];
  for (const v of victims) {
    if (!(await ctx.scene.has(v.id))) continue;
    await ctx.scene.remove(v.id);
    removed.push(v.name);
  }
  // Only compositions nothing else still shows (and never the one being built in).
  const active = activeCompRootId();
  const orphans = [...shown].filter((c) => c !== active && !m.layerIds().some((id) => m.layer(id)?.source === c && !under(id)));
  if (orphans.length) await ctx.engine.apply([{ type: 'removeItems', items: orphans, removeUsingLayers: false } as Command]);
  return removed;
}

export class McpCallHost {
  private queue: Promise<unknown> = Promise.resolve();
  private group: Group | null = null;
  private abort = new AbortController();
  /** Per-client alias maps (handles a client invented → real ids), kept across calls. */
  private readonly aliases = new Map<number, Map<string, string>>();
  private activity: McpActivity = { busy: false, tool: null, group: null };
  /** The look apply_look chose; casts and techniques use it. */
  private look: SessionLook | null = null;
  /**
   * Per client: the layers its last cast_piece created. A second cast_piece
   * REPLACES them (docs/PROGRAM_3D_PERF_UX.md M1) unless `append: true` —
   * the owner's comp held a whole script twice because every re-run stacked.
   */
  private readonly casts = new Map<number, string[]>();
  private readonly listeners = new Set<(a: McpActivity) => void>();

  /** The brief the client last gave get_author_guide (DARK_DEFAULT reads its cues). */
  private lastBrief: string | undefined;
  /** author_scene recorded the piece on screen: review_design compares against the ones before it. */
  private recordedPiece = false;

  constructor(private readonly deps: McpHostDeps) {}

  // ── Activity (the badge) ─────────────────────────────────────────────

  subscribe(fn: (a: McpActivity) => void): () => void {
    this.listeners.add(fn);
    fn(this.activity);
    return () => this.listeners.delete(fn);
  }

  getActivity(): McpActivity {
    return this.activity;
  }

  private setActivity(patch: Partial<McpActivity>): void {
    this.activity = { ...this.activity, ...patch };
    for (const fn of this.listeners) fn(this.activity);
  }

  // ── Entry points ─────────────────────────────────────────────────────

  /** Run one call; calls are queued so two clients never interleave edits. */
  handle(call: McpCall): Promise<McpResult> {
    const run = this.queue.then(() => this.run(call));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The connected clients changed; a group whose client left is committed. */
  clientsChanged(ids: readonly number[]): Promise<void> {
    for (const id of [...this.aliases.keys()]) if (!ids.includes(id)) this.aliases.delete(id);
    for (const id of [...this.casts.keys()]) if (!ids.includes(id)) this.casts.delete(id);
    const g = this.group;
    return g && !ids.includes(g.clientId) ? this.closeQueued(g) : Promise.resolve();
  }

  /** The user started editing: commit Claude's open group first, so their edit is its own step. */
  userActivity(): Promise<void> {
    const g = this.group;
    return g && !this.activity.busy ? this.closeQueued(g) : Promise.resolve();
  }

  /**
   * Commit `g` through the call queue, so it is ordered with the calls around
   * it. Called while idle, the queue is empty and it runs at once.
   */
  private closeQueued(g: Group): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.group === g) await this.closeGroup(true);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The badge's Stop: abort what is running and throw the open group away. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.abort = new AbortController();
    if (this.group) await this.closeGroup(false);
  }

  // ── Running a call ───────────────────────────────────────────────────

  private aliasesFor(clientId: number): Map<string, string> {
    let m = this.aliases.get(clientId);
    if (!m) {
      m = new Map();
      this.aliases.set(clientId, m);
      // A new client starts a new run: no style or scene window from before.
      this.deps.freshRun(this.abort.signal);
    }
    return m;
  }

  private async run(call: McpCall): Promise<McpResult> {
    const reg = this.deps.registry();
    if (!isMcpTool(call.name, (n) => reg.has(n))) {
      return text(`Premation does not offer '${call.name}' to Claude.`, true);
    }
    const access = await this.deps.access();
    if (!access.ok) return text(access.message, true);

    this.setActivity({ busy: true, tool: call.name });
    try {
      if (this.group) this.armIdle();
      switch (call.name) {
        case 'begin_edit': return await this.beginEdit(call);
        case 'end_edit': return await this.endEdit(call);
        case 'render_frame': return await this.renderFrame(call);
        case 'render_filmstrip': return await this.renderStrip(call);
        case 'analyze_motion': {
          const r = await analyzeMotionText(this.readContext(call), call.args);
          return text(r.text, !r.ok);
        }
        case 'render_motion_sheet': return await this.renderMotionSheet(call);
        case 'search_library': return text(await searchLibraryText(call.args));
        case 'preview_library': return await this.previewLibrary(call);
        case 'insert_library_item': return await this.insertLibrary(call);
        case 'render_rig_view': return await this.renderRigView(call);
        case 'rig_character': return await this.inTransaction(call, 'Claude: rig character', async (ctx) => {
          const r = await rigCharacter(ctx, call.args);
          return { result: text(r.text, !r.ok), ok: r.ok };
        });
        case 'rig_cycle': return await this.inTransaction(call, 'Claude: animate rig', async (ctx) => {
          const r = await rigCycle(ctx, call.args);
          return { result: text(r.text, !r.ok), ok: r.ok };
        });
        case 'get_author_guide': return this.authorGuide(call);
        case 'author_scene': return await this.inTransaction(call, 'Claude: build scene', (ctx) => this.authorScene(call, ctx));
        case 'list_compositions': return await this.editorOp(async (ed) => text(JSON.stringify(await ed.listCompositions(), null, 1)));
        case 'create_composition': return await this.createComposition(call);
        case 'set_active_composition': return await this.setActiveComposition(call);
        case 'delete_composition': return await this.deleteCompositions(call);
        case 'save_project': return await this.editorOp(async (ed) => {
          const r = await ed.save();
          return 'error' in r ? text(r.error, true) : text(r.message);
        });
        case 'import_media': return await this.importMedia(call);
        case 'export_video': return await this.exportVideo(call);
        case 'generate_speech': return await this.generateSpeech(call);
        case 'transcribe': return await this.transcribe(call);
        // Footage tools whose answer is also a picture: the registry result plus the preview.
        case 'find_subjects':
        case 'select_subject':
        case 'refine_subject': return await this.withSubjectView(call);
        case 'describe_asset': return await this.describeAsset(call);
        case 'get_design_guide': return text(designGuide(typeof obj(call.args).topic === 'string' ? String(obj(call.args).topic) : undefined));
        case 'list_looks': return text(listLooks());
        case 'apply_look': {
          const r = applyLook(call.args);
          if ('error' in r) return text(r.error, true);
          this.look = r.look;
          return text(r.summary);
        }
        case 'list_techniques': return text(listTechniques(call.args, this.look));
        case 'apply_technique': return await this.inTransaction(call, 'Claude: apply technique', async (ctx) => {
          const r = await applyTechnique(call.args, this.look, this.deps.registry(), ctx);
          return { result: text(r.text, !r.ok), ok: r.ok };
        });
        case 'cast_piece': {
          const menusOnly = obj(call.args).menusOnly === true;
          if (menusOnly) {
            const ctx = this.deps.context(null, this.abort.signal, this.aliasesFor(call.clientId));
            const r = await castPiece(call.args, this.look, { execute: async () => ({ ok: false, content: 'menus only' }) }, ctx);
            return text(r.text, !r.ok);
          }
          return await this.inTransaction(call, 'Claude: cast piece', async (ctx) => {
            const append = obj(call.args).append === true;
            const previous = this.casts.get(call.clientId) ?? [];
            let replaced = 0;
            if (!append) {
              // Inside this call's transaction: the removal and the new piece
              // are one undo entry, and a failed cast rolls the removal back.
              for (const id of previous) {
                if (!(await ctx.scene.has(id))) continue;
                await ctx.scene.remove(id);
                replaced++;
              }
            }
            const r = await castPiece(call.args, this.look, this.deps.registry(), ctx);
            if (r.ok) this.casts.set(call.clientId, append ? [...previous, ...r.created] : r.created);
            const note = replaced > 0
              ? `\nReplaced the piece cast earlier in this session (${replaced} layer(s) removed). Pass append: true to keep an earlier cast and add to it.`
              : '';
            return { result: text(r.text + note, !r.ok), ok: r.ok };
          });
        }
        case 'review_design': {
          const ctx = this.deps.context(this.group?.tx.session ?? null, this.abort.signal, this.aliasesFor(call.clientId));
          const r = await reviewDesign(ctx, { ...(this.lastBrief ? { brief: this.lastBrief } : {}), recent: (this.deps.pieceHistory?.recent() ?? []).slice(this.recordedPiece ? 1 : 0) });
          return { content: [...r.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })), { type: 'text', text: r.text }] };
        }
        case 'list_sfx': return text(SFX_ITEMS.map((x) => `${x.id} — ${x.name} (${x.cat}, ${x.duration.toFixed(2)}s)`).join('\n'));
        case 'add_sfx': return await this.addSfx(call);
        case 'set_audio_levels': return await this.editorOp(async (ed) => {
          const a = obj(call.args);
          const nodeId = String(a.nodeId ?? '');
          const r = await ed.setAudioLevels(nodeId, {
            ...(typeof a.levelDb === 'number' ? { levelDb: Math.max(-96, Math.min(12, a.levelDb)) } : {}),
            ...(typeof a.fadeInSec === 'number' && a.fadeInSec > 0 ? { fadeInSec: Math.min(30, a.fadeInSec) } : {}),
            ...(typeof a.fadeOutSec === 'number' && a.fadeOutSec > 0 ? { fadeOutSec: Math.min(30, a.fadeOutSec) } : {}),
          });
          return 'error' in r ? text(r.error, true) : text(r.message);
        });
        case 'duck_audio': return await this.editorOp(async (ed) => {
          const a = obj(call.args);
          const r = await ed.duck(String(a.musicId ?? ''), String(a.voiceId ?? ''), Math.max(-40, Math.min(0, num(a.duckDb, -12))));
          return 'error' in r ? text(r.error, true) : text(r.message);
        });
        default: return await this.registryCall(call);
      }
    } catch (err) {
      return text(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.setActivity({ busy: false, tool: null });
      if (this.group) this.armIdle();
    }
  }

  /**
   * Run a registry tool: a read as is, a changing one inside the open group
   * or its own transaction. `shape` turns the tool's result into MCP content
   * (default: its prose and data as text).
   */
  private async registryCall(call: McpCall, shape: (r: ToolResult) => Promise<McpResult> = async (r) => fromToolResult(r)): Promise<McpResult> {
    const reg = this.deps.registry();
    const def: AiToolDef | undefined = reg.get(call.name);
    const aliases = this.aliasesFor(call.clientId);
    if (!def || !mutates(def.kind)) {
      const ctx = this.deps.context(this.group?.tx.session ?? null, this.abort.signal, aliases);
      return shape(await reg.execute(call.name, call.args, ctx));
    }
    return this.inTransaction(call, `Claude: ${call.name.replace(/_/g, ' ')}`, async (ctx) => {
      const r = await reg.execute(call.name, call.args, ctx);
      return { result: await shape(r), ok: r.ok };
    });
  }

  /** find_subjects / select_subject / refine_subject: the matte preview drawn from the result's `view`, which is dropped from the text. */
  private withSubjectView(call: McpCall): Promise<McpResult> {
    return this.registryCall(call, async (r) => {
      const data = r.data && typeof r.data === 'object' ? { ...(r.data as Record<string, unknown>) } : undefined;
      const view = data?.view as SubjectView | undefined;
      if (data) delete data.view;
      const base = fromToolResult({ ...r, ...(data ? { data } : {}) });
      if (!r.ok || !view || !this.deps.renderSubjectView) return base;
      const img = await this.deps.renderSubjectView(view);
      if (!img) return base;
      return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, ...base.content] };
    });
  }

  /** describe_asset: the metadata plus a contact sheet decoded from the footage item. */
  private describeAsset(call: McpCall): Promise<McpResult> {
    return this.registryCall(call, async (r) => {
      const base = fromToolResult(r);
      const d = r.data as AssetDescription | undefined;
      if (!r.ok || !d?.itemId || d.type === 'audio' || !this.deps.renderAssetSheet) return base;
      const img = await this.deps.renderAssetSheet(d.itemId, d.durationSec, d.cells);
      if (!img) return { content: [...base.content, { type: 'text', text: 'No frames could be decoded for a contact sheet (the file may be missing or unsupported).' }] };
      const note = d.type === 'image' ? 'The picture is attached.' : `Attached: ${d.cells} frame(s) spread over ${d.durationSec.toFixed(2)}s, each labelled with its source time (render_frame { assetId, time } for one frame large).`;
      return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, ...base.content, { type: 'text', text: note }] };
    });
  }

  /**
   * Run a changing call: inside the open group, or as its own undo entry that
   * is rolled back whole when the call fails.
   */
  private async inTransaction(
    call: McpCall,
    label: string,
    body: (ctx: ToolContext) => Promise<{ result: McpResult; ok: boolean }>,
  ): Promise<McpResult> {
    const aliases = this.aliasesFor(call.clientId);
    if (this.group) {
      const ctx = this.deps.context(this.group.tx.session, this.abort.signal, aliases);
      return (await body(ctx)).result;
    }
    const tx = await this.deps.beginTransaction(label);
    try {
      const ctx = this.deps.context(tx.session, this.abort.signal, aliases);
      const { result, ok } = await body(ctx);
      if (ok) await tx.commit();
      else await tx.rollback();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ── Project-level operations ─────────────────────────────────────────

  private async editorOp(fn: (ed: McpEditorOps) => Promise<McpResult>): Promise<McpResult> {
    const ed = this.deps.editor;
    if (!ed) return text('This Premation build cannot do that from Claude.', true);
    return fn(ed);
  }

  private createComposition(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const name = String(a.name ?? '').trim().slice(0, 120) || 'Composition';
    return this.editorOp(async (ed) => {
      const r = await ed.createComposition({
        name,
        width: Math.round(Math.max(16, Math.min(8192, num(a.width, 1920)))),
        height: Math.round(Math.max(16, Math.min(8192, num(a.height, 1080)))),
        fps: Math.max(1, Math.min(120, num(a.fps, 30))),
        durationSeconds: Math.max(0.1, Math.min(3600, num(a.durationSeconds, 10))),
        background: typeof a.background === 'string' && /^#[0-9a-f]{6}$/i.test(a.background) ? a.background : '#101014',
      });
      return 'error' in r ? text(r.error, true) : text(`Created composition "${name}" (id ${r.id}); it is now the active composition.`);
    });
  }

  private setActiveComposition(call: McpCall): Promise<McpResult> {
    const compId = String(obj(call.args).compId ?? '');
    return this.editorOp(async (ed) => {
      const r = await ed.setActiveComposition(compId);
      return 'error' in r ? text(r.error, true) : text(`"${r.name}" is now the active composition.`);
    });
  }

  private deleteCompositions(call: McpCall): Promise<McpResult> {
    const raw = obj(call.args).compIds;
    const compIds = [...new Set((Array.isArray(raw) ? raw : []).filter((c): c is string => typeof c === 'string' && c !== ''))].slice(0, 50);
    if (compIds.length === 0) return Promise.resolve(text('delete_composition needs `compIds`: ids from list_compositions.', true));
    return this.editorOp(async (ed) => {
      const r = await ed.deleteCompositions(compIds);
      if ('error' in r) return text(r.error, true);
      const layers = r.layersRemoved ? ` and ${r.layersRemoved} precomp layer${r.layersRemoved === 1 ? '' : 's'} showing them` : '';
      return text(`Deleted ${r.names.map((n) => `"${n}"`).join(', ')}${layers}. One undo step brings them back.`);
    });
  }

  /** Ask the user; a refusal is final for this request and says so. */
  private async approved(req: ApprovalRequest): Promise<boolean> {
    return this.deps.approve ? this.deps.approve(req) : false;
  }

  private async importMedia(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const paths = (Array.isArray(a.paths) ? a.paths : []).filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, 20);
    if (paths.length === 0) return text('import_media needs `paths`: absolute file paths.', true);
    const ok = await this.approved({ kind: 'import', title: `Import ${paths.length} file${paths.length === 1 ? '' : 's'} into this project`, detail: paths });
    if (!ok) return text('The user did not allow this import. Do not retry it unless they ask; work with the media already in the project (list_assets).', true);
    return this.editorOp(async (ed) => {
      const r = await ed.importMedia(paths, a.placeOnTimeline !== false, Math.max(0, num(a.atSec, 0)));
      return 'error' in r ? text(r.error, true) : text(r.message);
    });
  }

  private async exportVideo(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const format = typeof a.format === 'string' ? a.format : 'mp4';
    const ok = await this.approved({ kind: 'export', title: `Render the active composition to ${format.toUpperCase()}`, detail: [`Format: ${format}`, a.mode === 'immediate' ? 'Starts now' : 'Added to the Render Queue'] });
    if (!ok) return text('The user did not allow this render. Do not retry it unless they ask.', true);
    return this.registryCall(call);
  }

  private async addSfx(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const id = String(a.id ?? '');
    const item = getSfxItem(id);
    if (!item) return text(`Unknown sound effect '${id}'. See list_sfx.`, true);
    return this.editorOp(async (ed) => {
      const r = await ed.addSfx(id, Math.max(0, num(a.atSec, 0)), typeof a.levelDb === 'number' ? Math.max(-48, Math.min(12, a.levelDb)) : null, { inGroup: this.group !== null });
      return 'error' in r ? text(r.error, true) : text(`Added "${item.name}" at ${num(a.atSec, 0)}s as audio layer ${r.id} (${item.duration.toFixed(2)}s).`);
    });
  }

  private async transcribe(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const range = `${num(a.startSec, 0).toFixed(1)}s–${typeof a.endSec === 'number' ? `${a.endSec.toFixed(1)}s` : 'the end'}`;
    const ok = await this.approved({
      kind: 'export',
      title: 'Transcribe the composition\'s audio (sends it to your speech provider)',
      detail: [`Range: ${range}`, a.createCaptions === true ? 'Creates caption layers (replacing the existing ones)' : 'Returns the text and word timings only'],
    });
    if (!ok) return text('The user did not allow transcribing. Do not retry it unless they ask.', true);
    return this.registryCall(call);
  }

  private async generateSpeech(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const words = typeof a.text === 'string' ? a.text : '';
    const ok = await this.approved({
      kind: 'export',
      title: 'Generate a voice-over (uses generation credit)',
      detail: [words.length > 160 ? `${words.slice(0, 157)}…` : words || '(no text)'],
    });
    if (!ok) return text('The user did not allow generating a voice-over. Do not retry it unless they ask.', true);
    return this.registryCall(call);
  }

  // ── Groups ───────────────────────────────────────────────────────────

  private async beginEdit(call: McpCall): Promise<McpResult> {
    const label = String(obj(call.args).label ?? '').trim().slice(0, 80) || 'edit';
    if (this.group) {
      return text(`A group is already open ("${this.group.label}"). Call end_edit before starting another.`, true);
    }
    const tx = await this.deps.beginTransaction(`Claude: ${label}`);
    this.group = { tx, label, clientId: call.clientId, timer: null };
    this.armIdle();
    this.setActivity({ group: label });
    return text(`Group "${label}" open. Every change until end_edit is one undo step.`);
  }

  private async endEdit(call: McpCall): Promise<McpResult> {
    if (!this.group) return text('No group is open; nothing to close.');
    const commit = obj(call.args).commit !== false;
    const label = this.group.label;
    const outcome = await this.closeGroup(commit);
    if (!commit) return text(`Group "${label}" discarded: every change it made was undone.`);
    return text(outcome === 'empty' ? `Group "${label}" closed; it changed nothing.` : `Group "${label}" saved as one undo step.`);
  }

  private armIdle(): void {
    const g = this.group;
    if (!g) return;
    const clear = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    if (g.timer !== null) clear(g.timer);
    g.timer = set(() => {
      if (this.group === g && !this.activity.busy) void this.closeQueued(g);
    }, GROUP_IDLE_MS);
  }

  private async closeGroup(commit: boolean): Promise<'engine' | 'empty'> {
    const g = this.group;
    if (!g) return 'empty';
    this.group = null;
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(g.timer);
    this.setActivity({ group: null });
    if (!commit) {
      await g.tx.rollback();
      return 'empty';
    }
    return (await g.tx.commit()).kind;
  }

  // ── Eyes ─────────────────────────────────────────────────────────────

  private async renderFrame(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const time = Math.max(0, num(a.time, 0));
    const maxSize = Math.max(128, Math.min(2048, Math.round(num(a.maxSize, 1024))));
    const opts = stillOptions(a);
    if ('error' in opts) return text(opts.error, true);
    const img = await this.deps.renderStill(time, maxSize, opts);
    const what = opts.assetId ? `asset ${opts.assetId} at ${time}s (source time)` : `the frame at ${time}s${opts.compId ? ` of ${opts.compId}` : ''}`;
    if (!img) return text(`Premation could not render ${what}.`, true);
    if ('error' in img) return text(img.error, true);
    const notes = [
      opts.layerIds ? `only ${opts.layerIds.join(', ')} drawn (solo)` : '',
      opts.region ? `cropped to x ${opts.region.x} y ${opts.region.y} ${opts.region.w}×${opts.region.h} comp px` : '',
      opts.zoom ? `${opts.zoom}× about the centre` : '',
    ].filter(Boolean);
    return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: `${opts.assetId ? `Asset ${opts.assetId} at ${time}s` : `Frame at ${time}s`}${notes.length ? ` — ${notes.join(', ')}` : ''}.` }] };
  }

  private async renderStrip(call: McpCall): Promise<McpResult> {
    const a = obj(call.args);
    const start = Math.max(0, num(a.startSec, 0));
    const end = num(a.endSec, start);
    if (!(end > start)) return text('endSec must be after startSec.', true);
    const cells = Math.max(2, Math.min(12, Math.round(num(a.cells, 8))));
    const img = await this.deps.renderStrip(start, end, cells);
    if (!img) return text(`Premation could not render frames between ${start}s and ${end}s.`, true);
    return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: `${cells} frames from ${start}s to ${end}s, each labelled with its time.` }] };
  }

  /** A context for a read: the open group's session when there is one, so it sees the group's edits. */
  private readContext(call: McpCall): ToolContext {
    return this.deps.context(this.group?.tx.session ?? null, this.abort.signal, this.aliasesFor(call.clientId));
  }

  private async renderMotionSheet(call: McpCall): Promise<McpResult> {
    const data = await motionSheetData(this.readContext(call), call.args);
    if ('error' in data) return text(data.error, true);
    const images = this.deps.renderMotionSheet ? await this.deps.renderMotionSheet(data) : [];
    const lead = images.length
      ? `Attached: ${images.length === 2 ? 'every frame of the window (labelled f<frame>) and an onion skin with the moving elements\' paths, one dot per sample' : 'the frames of the window'}.`
      : 'No frames could be rendered; the measurements below still hold.';
    return { content: [...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })), { type: 'text', text: `${lead}\n\n${data.text}` }] };
  }

  private async renderRigView(call: McpCall): Promise<McpResult> {
    const view = await rigViewData(this.readContext(call), call.args);
    if ('error' in view) return text(view.error, true);
    const img = this.deps.renderRigView ? await this.deps.renderRigView(view) : null;
    return { content: [...(img ? [{ type: 'image' as const, data: img.data, mimeType: img.mimeType }] : []), { type: 'text', text: img ? view.text : `${view.text}\n(No image could be rendered; the coordinates above still hold.)` }] };
  }

  // ── Library ──────────────────────────────────────────────────────────

  private libraryEditor(): LibraryEditorOps | undefined {
    const ed = this.deps.editor;
    if (!ed) return undefined;
    return {
      applyTemplate: (id) => ed.library?.applyTemplate(id) ?? Promise.resolve({ error: 'This Premation build cannot apply templates from Claude.' }),
      insertPremium: (item, o) => ed.library?.insertPremium(item, o) ?? Promise.resolve({ error: 'This Premation build cannot insert Cloud items from Claude.' }),
      addSfx: (id, atSec, inGroup) => ed.addSfx(id, atSec, null, { inGroup }),
    };
  }

  private async insertLibrary(call: McpCall): Promise<McpResult> {
    const entry = await findLibraryEntry(String(obj(call.args).id ?? ''));
    const deps = (ctx: ToolContext) => ({
      ...(this.libraryEditor() ? { editor: this.libraryEditor()! } : {}),
      inGroup: this.group !== null,
      moveLayer: async (id: string, x: number, y: number) => {
        const r = await this.deps.registry().execute('update_layer', { nodeId: id, x, y }, ctx);
        if (!r.ok) throw new Error(r.content);
      },
    });
    // Editor-routed inserts open their own engine gesture: never inside this call's transaction.
    if (!entry || insertRoute(entry) === 'editor') {
      const r = await insertLibraryItem(this.readContext(call), call.args, deps(this.readContext(call)));
      return text(r.text, !r.ok);
    }
    return this.inTransaction(call, `Claude: insert ${entry.name}`, async (ctx) => {
      const r = await insertLibraryItem(ctx, call.args, deps(ctx));
      return { result: text(r.text, !r.ok), ok: r.ok };
    });
  }

  /**
   * Build each item for real, render its motion, throw it away: a transaction
   * that is always rolled back, so nothing stays and nothing enters undo.
   */
  private async previewLibrary(call: McpCall): Promise<McpResult> {
    if (this.group) return text('preview_library builds and removes items, which cannot happen inside a begin_edit group. Call end_edit first.', true);
    const a = obj(call.args);
    const ids = (Array.isArray(a.ids) ? a.ids : []).filter((x): x is string => typeof x === 'string').slice(0, 4);
    if (ids.length === 0) return text('preview_library needs `ids` from search_library.', true);
    const cells = Math.max(3, Math.min(12, Math.round(num(a.cells, 6))));
    const content: McpResult['content'] = [];
    const notes: string[] = [];
    for (const id of ids) {
      const entry = await findLibraryEntry(id);
      if (!entry) { notes.push(`- ${id}: not in the library (search_library).`); continue; }
      if (entry.premium) {
        const poster = await premiumPoster(entry);
        if (poster) content.push({ type: 'image', data: poster.data, mimeType: poster.mimeType });
        notes.push(`- ${describeEntry(entry)}${poster ? ' (poster attached)' : ' (no poster available offline)'}`);
        continue;
      }
      if (insertRoute(entry) === 'editor') { notes.push(`- ${describeEntry(entry)} (described only: it is not drawn on the canvas or replaces the composition)`); continue; }
      const tx = await this.deps.beginTransaction(`Claude: preview ${entry.name}`);
      try {
        const ctx = this.deps.context(tx.session, this.abort.signal, this.aliasesFor(call.clientId));
        const made = await insertForPreview(ctx, entry);
        if (!made || made.length === 0) { notes.push(`- ${entry.id}: could not be built.`); continue; }
        const comp = await ctx.comp.get();
        const span = Math.min(previewSpan(entry), comp.durationSeconds);
        const raw = span > 0.05
          ? await this.deps.renderStrip(0, span, cells)
          : await this.deps.renderStill(0, 1024);
        const img = raw && !('error' in raw) ? raw : null;
        if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        notes.push(`- ${describeEntry(entry)}${img ? ` (${span > 0.05 ? `filmstrip 0–${span.toFixed(2)}s` : 'frame'} attached, over the composition at 0 s)` : ' (could not render)'}`);
      } finally {
        await tx.rollback();
      }
    }
    content.push({ type: 'text', text: [`Previewed ${ids.length} item(s); images in the order below. Nothing was left in the project.`, ...notes].join('\n') });
    return { content };
  }

  // ── Author mode ──────────────────────────────────────────────────────

  private authorGuide(call: McpCall): McpResult {
    const brief = String(obj(call.args).brief ?? '');
    if (brief.trim()) this.lastBrief = brief;
    const recent = this.deps.pieceHistory?.recent() ?? [];
    return text([
      authorSystemPrompt({ prompt: brief }),
      '',
      'BEFORE THE SCRIPT: sketch three different concepts for this brief — each its one idea, medium (3d, image, ink, ui, shape, type), value (light, mid or dark frame), palette in words and camera — differing on at least two of value, medium and camera. Pick the one that serves the brief best and put the choice and why in the `intent` of the script. A near-black frame is right for night, cinema or space, not as a default.',
      ...(recent.length ? ['', 'The last pieces made in this editor were:', describeRecent(recent), 'Unless the user asks for a series, this one must not repeat their value, medium and camera together.'] : []),
      '',
      'Pass the script to author_scene as `script`: the header fields, `globals`, and `beats` — each beat with its `startSec`, `endSec` and `layers` — in one object. Premation fits it to the active composition (its size, fps and length).',
      '',
      'A beat may also carry `precompose`: [{ id, name, layers: [layer ids of that beat sharing a parent], props?: { x, y, scale, rotation, opacity }, keys?: { prop: [[t, v], …] } }] — the layers become ONE composition layer that moves, fades and takes effects as a unit (a camera rig, a crowd). Its keys are beat seconds.',
      'Key times snap to frames: two keys of one property closer than a frame (1/fps s) merge and only the later one survives — author_scene reports any it finds.',
      '',
      'GLASS AND LIQUID: a 2D layer becomes real glass with apply_layer_style { styleType: "glass" } — backdrop blur, tint, edge refraction, rim and specular; set glass.surface "dome" with thickness, ior, caustic and fresnel for a drop of liquid, "luma" / "layer" for an embossed or bump-mapped surface. The refraction, glass and displacement-map EFFECTS take a Source: set their `source` param to "Backdrop (the scene below)" (update_effect_param source: 1) so they bend what is BEHIND the layer, not the layer\'s own pixels — a lens over footage, a water ripple over the whole scene (on an adjustment layer). The goo effect merges nearby shapes into one liquid blob (metaballs: blur + threshold, then a shaded dome with highlight and Fresnel rim) — put the blobs in a precomp or an adjustment layer over them, keyframe their positions, and they fuse and split as they meet.',
      '',
      'FOOTAGE the user imported (list_assets): describe_asset shows a contact sheet and the real codec / fps before you place it with create_media (render_frame { assetId, time } for one frame). A person or object in a shot is a SUBJECT: find_subjects lists candidates, select_subject cuts one out on a frame (points, a box or a candidate; footage px from the top-left), refine_subject corrects it (points, brush strokes, edge feather / choke), follow_subject carries it through the shot (a job — get_job_status), then apply_subject_style (outlines, glows, spotlight, colour splash, duotone, portrait blur, remove_background) and place_behind_subject (text behind them) use it. track_point + attach_to_track pin a layer or a null to a moving detail; transcribe gives word timings to cut type and SFX to speech, and caption layers.',
    ].join('\n'));
  }

  private async authorScene(call: McpCall, ctx: ToolContext): Promise<{ result: McpResult; ok: boolean }> {
    const raw = obj(call.args).script;
    if (!raw || typeof raw !== 'object') return { result: text('author_scene needs `script` (see get_author_guide).', true), ok: false };
    const comp = await ctx.comp.get();
    const coerced = coerceScript(raw, { durationSec: comp.durationSeconds, width: comp.width, height: comp.height });
    if (coerced.value.beats.length === 0 && coerced.value.globals.length === 0) {
      return { result: text(`The script has nothing to build.\n${formatRepairs(coerced.repairs)}`, true), ok: false };
    }
    const compiled = compileScript(coerced.value);
    const recentPieces = this.deps.pieceHistory?.recent() ?? [];
    const advice = adviseScript(coerced.value, compiled, {
      width: comp.width, height: comp.height, fps: comp.fps,
      ...(this.lastBrief ? { brief: this.lastBrief } : {}),
      recent: recentPieces,
    });
    const reg = this.deps.registry();
    // A beat that is already in the composition is REPLACED, not built again
    // next to itself (M1): the owner's comp carried every beat twice with
    // identical clip times — two cameras per beat, three adjustment layers at
    // once — because each author_scene re-run appended. Same transaction, so
    // the removal undoes with the rebuild.
    const replaced = obj(call.args).append === true ? [] : await removeScriptLayers(ctx, coerced.value);
    const rejected: string[] = [];
    let applied = 0;
    for (const c of compiled.calls) {
      if (ctx.signal.aborted) break;
      const r = await reg.execute(c.name, c.args, ctx);
      if (r.ok) applied++;
      else rejected.push(`- ${c.name}: ${r.content.slice(0, 240)}`);
    }
    if (applied === 0) {
      return { result: text(`Nothing could be built; every compiled call was rejected.\n${rejected.slice(0, 20).join('\n')}`, true), ok: false };
    }
    // A call that adds beats to an earlier build (no front globals of its own)
    // creates them on top — over the earlier call's letterbox, grain and
    // captions. Front globals stay in front (The Last Blade, In Motion).
    if (!coerced.value.globals.some((g) => g.stack === 'front')) {
      const fronts = (await ctx.scene.all()).filter((n) => n.parent === null && n.name === FRONT_GLOBALS_ROOT_NAME).map((n) => n.id);
      if (fronts.length) {
        const r = await reg.execute('reorder_layer', { nodeIds: fronts, position: 'top' }, ctx);
        if (!r.ok) rejected.push(`- reorder_layer: ${r.content.slice(0, 240)}`);
      }
    }
    const lines = [
      `Built "${coerced.value.title || 'scene'}": ${coerced.value.beats.length} beats, ${applied} of ${compiled.calls.length} operations applied, in ${comp.width}×${comp.height} at ${comp.fps} fps, ${comp.durationSeconds}s.`,
    ];
    if (replaced.length) lines.push('', `Replaced ${replaced.length} layer group(s) the composition already had from an earlier build: ${replaced.join(', ')}. Pass append: true to keep an earlier build next to this one.`);
    if (coerced.repairs.length) lines.push('', 'Repaired in the script:', formatRepairs(coerced.repairs));
    const collisions = sameFrameKeys(compiled, comp.fps);
    if (collisions.length) lines.push('', 'Keys merged by frame snapping:', ...collisions.slice(0, 20).map((c) => `- ${c}`));
    if (rejected.length) lines.push('', 'Rejected by the engine:', ...rejected.slice(0, 20));
    if (advice.findings.length) lines.push('', 'Design advisors:', formatAdvice(advice.findings));
    lines.push('', 'Look at it with render_filmstrip, then refine with the individual tools.');
    // What this piece is, for the next one (a rebuild of the same script replaces nothing: same title, one entry).
    const fp = fingerprintScript(coerced.value);
    const history = this.deps.pieceHistory;
    if (history && !(fp.title && history.recent()[0]?.title === fp.title)) history.record(fp);
    this.recordedPiece = !!history;
    return { result: text(lines.join('\n')), ok: true };
  }
}
