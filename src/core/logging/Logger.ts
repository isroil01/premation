/**
 * Logger — leveled, scoped application logging.
 *
 * Framework-agnostic. Writes to the console, keeps a bounded in-memory ring
 * buffer (for a future Log panel / diagnostics export), and lets tools
 * subscribe to the stream. Engines create scoped child loggers so every line
 * is attributable to a subsystem without extra ceremony.
 *
 *   const log = getLogger().scope('render');
 *   log.info('attached', { fps: 60 });
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly data?: unknown;
  /** Monotonic sequence number (stable ordering without relying on the clock). */
  readonly seq: number;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Create a child logger tagged with an additional scope. */
  scope(name: string): Logger;
}

export interface LoggerOptions {
  /** Minimum level that is emitted. Lines below this are dropped. */
  minLevel?: LogLevel;
  /** Max entries retained in the ring buffer. */
  bufferSize?: number;
  /** Mirror to the browser/node console. */
  console?: boolean;
}

class LoggerHub {
  private minLevel: LogLevel;
  private readonly bufferSize: number;
  private readonly toConsole: boolean;
  private readonly buffer: LogEntry[] = [];
  private readonly sinks = new Set<LogSink>();
  private seq = 0;

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = opts.minLevel ?? 'debug';
    this.bufferSize = opts.bufferSize ?? 1000;
    this.toConsole = opts.console ?? true;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = { level, scope, message, data, seq: this.seq++ };

    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    if (this.toConsole) {
      const label = `[${scope}]`;
      const fn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
          : level === 'debug' ? console.debug
            : console.info;
      if (data !== undefined) fn(label, message, data);
      else fn(label, message);
    }

    for (const sink of this.sinks) {
      try { sink(entry); } catch { /* a bad sink must not break logging */ }
    }
  }

  /** Snapshot of the retained log entries. */
  history(): ReadonlyArray<LogEntry> {
    return this.buffer.slice();
  }

  subscribe(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

class ScopedLogger implements Logger {
  constructor(protected readonly hub: LoggerHub, protected readonly scopeName: string) {}
  debug(message: string, data?: unknown): void { this.hub.emit('debug', this.scopeName, message, data); }
  info(message: string, data?: unknown): void { this.hub.emit('info', this.scopeName, message, data); }
  warn(message: string, data?: unknown): void { this.hub.emit('warn', this.scopeName, message, data); }
  error(message: string, data?: unknown): void { this.hub.emit('error', this.scopeName, message, data); }
  scope(name: string): Logger { return new ScopedLogger(this.hub, `${this.scopeName}:${name}`); }
}

/**
 * LoggerService — the root logger plus diagnostics surface (history/subscribe).
 * Registered as a core service; UI/tools use it for a Log panel.
 */
export class LoggerService extends ScopedLogger {
  constructor(opts?: LoggerOptions) {
    super(new LoggerHub(opts), 'app');
  }
  history(): ReadonlyArray<LogEntry> { return this.hub.history(); }
  subscribe(sink: LogSink): () => void { return this.hub.subscribe(sink); }
  setMinLevel(level: LogLevel): void { this.hub.setMinLevel(level); }
  clear(): void { this.hub.clear(); }
}

let instance: LoggerService | null = null;

export function getLogger(): LoggerService {
  if (!instance) instance = new LoggerService();
  return instance;
}

/** Replace the singleton — for tests / multi-window isolation. */
export function setLogger(logger: LoggerService): void {
  instance = logger;
}
