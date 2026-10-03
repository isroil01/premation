/**
 * The engine session an AI turn (or a user script run) writes through
 * (NATIVE_CORE_PLAN §5 B5, ENGINE_API.md §12).
 *
 * `apply` sends edit commands with the session's origin; `query` reads back.
 * Both speak only `EngineClient`, so the same session drives the TypeScript
 * engine and the C++ engine process. A typed engine refusal is thrown as
 * `AiEngineError` (nothing changed) — the tool registry turns a throw into a
 * failed tool result addressed to the model.
 *
 * `legacy(gap)` records a write that went AROUND the engine (the API cannot
 * express it yet). The transaction then commits the turn as a whole-document
 * snapshot instead of an engine entry. The session also notices an unrecorded
 * one: the engine answers any write it did not make with a `documentReset`
 * `resync` before its next command, and that is counted as a gap too — a
 * forgotten `legacy()` call costs replayability, never correctness.
 */

import type {
  Command,
  CommandResult,
  EngineClient,
  EngineError,
  Origin,
  QueryOf,
  QueryResults,
  QueryType,
} from '@motion/engine-api';
import { AiEngineError, type AiEngineSession } from '@motion/ai-tools';
import { isWriteAroundEngine } from '@core/engine/externalWrites';
import { engine, hasEngine } from '@core/engine/engineInstance';
import { documentMirror, hasDocumentMirror } from '@stores/documentMirror';

/** The gap recorded when the engine itself saw a write it did not make. */
export const RESYNC_GAP = 'a document write outside the engine (the engine resynced)';

function toAiError(error: EngineError): AiEngineError {
  return new AiEngineError(error.code, error.message || error.code, error.commandIndex);
}

export class EngineTurnSession implements AiEngineSession {
  readonly client: EngineClient;
  readonly origin: Origin;
  private readonly gaps: string[] = [];
  private resynced = false;
  private unsubscribe: (() => void) | null = null;

  constructor(client: EngineClient, origin: Origin = 'ai') {
    this.client = client;
    this.origin = origin;
  }

  /** Start counting engine resyncs (writes made around the engine) as gaps. */
  watch(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.subscribe((batch) => {
      if (isWriteAroundEngine(batch)) this.resynced = true;
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async apply(commands: readonly Command[], label = ''): Promise<CommandResult[]> {
    if (commands.length === 0) return [];
    if (commands.length === 1) {
      const res = await this.client.execute(commands[0]! as never, { origin: this.origin });
      if (!res.ok) throw toAiError(res.error);
      await this.catchUp(res.revision);
      return [{ type: commands[0]!.type, ...(res.value as object) } as CommandResult];
    }
    const res = await this.client.batch(label, [...commands], { origin: this.origin });
    if (!res.ok) throw toAiError(res.error);
    await this.catchUp(res.revision);
    return res.value;
  }

  /**
   * The tools read the document MIRROR between writes (an id the write minted,
   * a value it set): on the app's engine, let the mirror reach the write's
   * revision first — the answer can overtake its events over the pipe (as
   * `edit()` does).
   */
  private async catchUp(revision: number): Promise<void> {
    if (hasDocumentMirror() && hasEngine() && this.client === engine()) await documentMirror().whenAt(revision);
  }

  async query<T extends QueryType>(query: QueryOf<T>): Promise<QueryResults[T]> {
    const res = await this.client.query(query, { origin: this.origin });
    if (!res.ok) throw toAiError(res.error);
    return res.value;
  }

  legacy(gap: string): void {
    if (!this.gaps.includes(gap)) this.gaps.push(gap);
  }

  get legacyGaps(): readonly string[] {
    return this.resynced ? [...this.gaps, RESYNC_GAP] : [...this.gaps];
  }
}
