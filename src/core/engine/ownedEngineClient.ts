/**
 * The session's EngineClient when the C++ ENGINE OWNS THE DOCUMENT
 * (NATIVE_CORE_PLAN §5 D5 + F2, `PREMATION_ENGINE_OWNER=engine`).
 *
 * Every request goes to the owner — the process client (`ProcessEngineClient`,
 * which falls back to the TypeScript engine on its own when the process gives
 * up). Its answers, its events, its history, its dirty flag and its frames are
 * the truth: the document mirror, the lifecycle (EngineDocumentSession), the
 * viewport and the transport read only the owner.
 *
 * The page still holds a REPLICA: the TypeScript engine (LocalEngine) is sent
 * the same document-changing requests, in the same order. It is not
 * authoritative — nothing saves it, undoes it or renders it — it exists because
 * a lot of the editor still reads the document from the page (B4's remaining
 * reads, docs/B4_MIRROR.md §5): the viewport's gizmos, handles and hit tests,
 * the off-document layer builders, the Layers panel. The replay corpus shows
 * both engines answer the same request stream identically (C3: 10 539 requests,
 * 0 mismatches; D1/undo parity: 0 differences), so the replica follows the
 * owner. When it does not, the difference is COUNTED (`replicaStats`), never
 * shown to the owner: the replica can only make an overlay wrong, never the
 * saved project or the picture.
 *
 * Forwarded: edits and batches, the lifecycle commands that replace the
 * document (newProject / openProject / revertProject), and history
 * (undo / redo / jumpToHistory / gestures / checkpoints). Not forwarded:
 * queries (the owner answers), saveProject / collectFiles (the owner writes the
 * file; two writers of one path is how files get corrupted), transport and
 * viewport controls (the owner's clock drives the page's playhead), jobs.
 *
 * Once the process backend has fallen back, the owner already routes to the
 * TypeScript engine — the same instance as the replica — so nothing is
 * forwarded any more (it would apply twice).
 *
 * No React (src/core).
 */

import type {
  Command,
  EngineClient,
  EventListener,
  Request,
  Response,
} from '@motion/engine-api';
import { EngineClientBase, commandKind } from '@motion/engine-api';

/** What the owner must expose beyond EngineClient (ProcessEngineClient has it). */
export interface OwnerClient extends EngineClient {
  readonly backend: 'process' | 'fallback' | 'pending' | 'closed';
}

export interface ReplicaStats {
  /** Requests sent to the replica. */
  forwarded: number;
  /** Requests whose replica outcome differed from the owner's (ok vs error, or a different result). */
  mismatches: number;
  /** The last few differences, for diagnostics (dev HUD, harness). */
  last: string[];
}

/** Control commands the replica must also apply: they move its history. */
const HISTORY_CONTROLS = new Set<string>([
  'undo', 'redo', 'jumpToHistory', 'beginGesture', 'endGesture', 'clearHistory',
  'setHistoryLimit', 'addHistoryCheckpoint',
]);

/** io commands that replace the replica's document. saveProject / collectFiles stay with the owner. */
const DOCUMENT_IO = new Set<string>(['newProject', 'openProject', 'revertProject']);

/** Edit commands whose work is the owner's job alone (a job result the replica never computed). */
const OWNER_ONLY_EDITS = new Set<string>(['applyJobResult']);

/** Does the replica apply this request? */
export function replicates(req: Request): boolean {
  const b = req.body;
  if (b.kind === 'query') return false;
  if (b.kind === 'batch') return true;
  const type = b.value.type;
  if (OWNER_ONLY_EDITS.has(type)) return false;
  const kind = commandKind(type);
  if (kind === 'edit') return true;
  if (kind === 'io') return DOCUMENT_IO.has(type);
  return HISTORY_CONTROLS.has(type);
}

function outcomeSignature(res: Response): string {
  const o = res.outcome;
  if (o.kind === 'error') return `error:${o.value.code}`;
  try {
    return `${o.kind}:${JSON.stringify(o.value)}`;
  } catch {
    return o.kind;
  }
}

/**
 * Commands whose results legitimately differ between the engines (paths,
 * byte counts, timings): compared by outcome kind only.
 */
const KIND_ONLY = new Set<string>([
  'openProject', 'newProject', 'revertProject', 'restoreDocument', 'importFiles', 'importBytes',
  // Gesture ids are mapped (`gestureIds`), so a different number is not a difference.
  'beginGesture', 'endGesture',
]);

export class OwnedEngineClient extends EngineClientBase {
  readonly replicaStats: ReplicaStats = { forwarded: 0, mismatches: 0, last: [] };
  /** The owner's gesture id → the replica's, when they differ. */
  private readonly gestureIds = new Map<number, number>();

  constructor(
    readonly owner: OwnerClient,
    private readonly replica: () => EngineClient | null,
  ) {
    super();
  }

  subscribe(listener: EventListener): () => void {
    return this.owner.subscribe(listener);
  }

  async close(): Promise<void> {
    await this.owner.close();
  }

  async request(req: Request): Promise<Response> {
    const replica = this.owner.backend === 'fallback' ? null : this.replica();
    const mirrored = replica && replicates(req) ? this.forward(replica, req) : null;
    const res = await this.owner.request(req);
    this.noteRevision(res.revision);
    if (mirrored) void this.compare(req, res, mirrored);
    return res;
  }

  /** Send the replica the same request (sent now, so it keeps the owner's order). */
  private forward(replica: EngineClient, req: Request): Promise<Response> {
    this.replicaStats.forwarded += 1;
    // The owner's revisions are not the replica's: a baseRevision would be a false conflict.
    const { baseRevision: _base, ...rest } = req;
    let body = rest.body;
    if (body.kind === 'command' && body.value.type === 'endGesture') {
      const mapped = this.gestureIds.get(body.value.gesture);
      if (mapped !== undefined) body = { kind: 'command', value: { ...body.value, gesture: mapped } as Command };
    }
    return replica.request({ ...rest, body }).catch((err: unknown): Response => ({
      seq: req.seq,
      revision: 0,
      outcome: { kind: 'error', value: { code: 'internal', message: err instanceof Error ? err.message : String(err) } },
    }));
  }

  private async compare(req: Request, owner: Response, mirrored: Promise<Response>): Promise<void> {
    const replica = await mirrored;
    const b = req.body;
    const type = b.kind === 'command' ? b.value.type : b.kind;
    if (type === 'beginGesture' && owner.outcome.kind === 'command' && replica.outcome.kind === 'command') {
      const o = (owner.outcome.value as { gesture?: number }).gesture;
      const r = (replica.outcome.value as { gesture?: number }).gesture;
      if (o !== undefined && r !== undefined && o !== r) this.gestureIds.set(o, r);
    }
    if (type === 'endGesture' && b.kind === 'command' && b.value.type === 'endGesture') this.gestureIds.delete(b.value.gesture);
    const same = KIND_ONLY.has(type)
      ? owner.outcome.kind === replica.outcome.kind
      : outcomeSignature(owner) === outcomeSignature(replica);
    if (same) return;
    this.replicaStats.mismatches += 1;
    const line = `${type}: owner ${outcomeSignature(owner).slice(0, 120)} · replica ${outcomeSignature(replica).slice(0, 120)}`;
    this.replicaStats.last.push(line);
    if (this.replicaStats.last.length > 20) this.replicaStats.last.shift();
    console.warn(`[engine] the page's replica differs from the engine (overlays may be off until the next open): ${line}`);
  }
}
