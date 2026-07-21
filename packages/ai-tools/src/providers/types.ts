/**
 * The provider seam.
 *
 * An adapter does exactly two things: turn our neutral `AiRequest` into a
 * vendor's request body, and turn a vendor's SSE stream back into our neutral
 * `AiEvent`s. Nothing above this layer learns a vendor's wire format — that's
 * what makes swapping OpenAI for Claude a settings change rather than a rewrite.
 *
 * The transport isn't here on purpose: in Electron, main performs the fetch (it
 * holds the key and isn't bound by the renderer's CSP) and streams raw bytes
 * back. Adapters are pure text-in / events-out, so they're trivially testable
 * against recorded fixtures — which is the only sane way to cover three
 * incompatible tool-call encodings.
 */

import type { AiEvent, AiRequest, ProviderId } from '../types';

export interface StreamParser {
  /** Feed raw bytes; get whatever events they completed. */
  push(chunk: string): AiEvent[];
  /**
   * The stream ended. Emits assembled tool calls and a terminal `stop` — most
   * providers only reveal a complete tool call once the stream is done.
   */
  end(): AiEvent[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly defaultModel: string;
  buildBody(req: AiRequest): unknown;
  createParser(): StreamParser;
}
