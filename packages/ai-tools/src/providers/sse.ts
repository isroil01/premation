/**
 * A minimal SSE reader.
 *
 * All three providers speak Server-Sent Events, and all three fragment their
 * payloads across arbitrary byte boundaries — a single `data:` line can arrive
 * split down the middle of a JSON escape. So the one thing this must get right
 * is buffering: never assume a chunk is a whole line.
 */

export interface SseEvent {
  /** The `event:` name, when the provider sends one (Anthropic does). */
  event: string | null;
  /** The joined `data:` payload. */
  data: string;
}

export class SseReader {
  private buffer = '';

  /** Feed a raw chunk; get back whatever complete events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];

    // Events are separated by a blank line. Normalize CRLF first — some
    // proxies rewrite line endings and \r\n\r\n would otherwise never match.
    this.buffer = this.buffer.replace(/\r\n/g, '\n');

    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const parsed = parseBlock(raw);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** Flush a trailing event that arrived without its terminating blank line. */
  end(): SseEvent[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const parsed = parseBlock(rest);
    return parsed ? [parsed] : [];
  }
}

function parseBlock(raw: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank or comment/heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!data.length && event === null) return null;
  return { event, data: data.join('\n') };
}

/** Parse JSON without throwing — a malformed frame shouldn't kill the stream. */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
