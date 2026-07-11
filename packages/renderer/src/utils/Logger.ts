/** Minimal leveled logger with an injectable sink (no console coupling). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export type LogSink = (level: Exclude<LogLevel, 'silent'>, scope: string, message: string) => void;

export class Logger {
  constructor(
    private readonly scope: string,
    private level: LogLevel = 'warn',
    private sink: LogSink = defaultSink,
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level, this.sink);
  }

  debug(message: string): void {
    this.emit('debug', message);
  }
  info(message: string): void {
    this.emit('info', message);
  }
  warn(message: string): void {
    this.emit('warn', message);
  }
  error(message: string): void {
    this.emit('error', message);
  }

  private emit(level: Exclude<LogLevel, 'silent'>, message: string): void {
    if (ORDER[level] >= ORDER[this.level] && this.level !== 'silent') {
      this.sink(level, this.scope, message);
    }
  }
}

const defaultSink: LogSink = (level, scope, message) => {
  // Routed through console but isolated here so the rest of the engine is clean.
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};
