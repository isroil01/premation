/**
 * The session's EngineClient when the C++ ENGINE OWNS THE DOCUMENT
 * (NATIVE_CORE_PLAN §5 D5 + F2; always, in the app).
 *
 * Every request goes to the owner — the process client (`ProcessEngineClient`).
 * Its answers, its events, its history, its dirty flag and its frames are the
 * truth: the document mirror, the lifecycle (EngineDocumentSession), the
 * viewport and the transport read only the owner. The page keeps no copy of
 * the document (block 3, docs/TS_ENGINE_REMOVAL.md: the replica is gone).
 *
 * No React (src/core).
 */

import type { EngineClient, EventListener, Request, Response } from '@motion/engine-api';
import { EngineClientBase } from '@motion/engine-api';

/** What the owner must expose beyond EngineClient (ProcessEngineClient has it). */
export interface OwnerClient extends EngineClient {
  readonly backend: 'process' | 'unavailable' | 'pending' | 'closed';
}

export class OwnedEngineClient extends EngineClientBase {
  constructor(readonly owner: OwnerClient) {
    super();
  }

  subscribe(listener: EventListener): () => void {
    return this.owner.subscribe(listener);
  }

  async close(): Promise<void> {
    await this.owner.close();
  }

  async request(req: Request): Promise<Response> {
    const res = await this.owner.request(req);
    this.noteRevision(res.revision);
    return res;
  }
}
