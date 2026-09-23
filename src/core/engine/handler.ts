/**
 * The contract every edit-command handler implements.
 *
 * A handler VALIDATES (throwing `EngineFail` — nothing has changed yet) and
 * returns a `Plan`: the parts it may touch (scope), optional async preparation
 * (reading a file) and a synchronous `apply` that performs the mutation. The
 * engine captures the scope around `apply`; the changed parts become the
 * inverse. A handler never pushes history, never emits events, never touches
 * editor state (selection, tabs, panels).
 */

import type { CommandType, CommandResults, Origin } from '@motion/engine-api';
import type { CommandOf } from '@motion/engine-api';
import type { Scope } from './state';
import type { IdAllocator } from './ids';
import type { EnginePorts } from './ports';
import type { KeyIndex } from './keyIndex';

export interface Plan<R> {
  scope: Scope;
  /** Async work before anything is captured or changed (file reads). */
  prepare?: () => Promise<void>;
  apply: () => R;
  /** History label override. */
  label?: string;
}

export interface HandlerCtx {
  readonly origin: Origin;
  readonly ids: IdAllocator;
  readonly ports: EnginePorts;
  /** Mint an id in the shared layer/item id space. */
  mintId(prefix: string): string;
  /** Mint a group id unique within a layer (`taken` says what the layer already has). */
  mintGroupId(prefix: string, taken: (id: string) => boolean): string;
  /** Mint a stable keyframe id. */
  mintKeyId(): string;
  /** Mint a marker id. */
  mintMarkerId(): string;
  /** Keyframe id → location. */
  readonly keys: KeyIndex;
  /** The engine's playhead in flicks (for keep-world-transform style decisions). */
  readonly time: number;
}

export type Handler<T extends CommandType> = (cmd: CommandOf<T>, ctx: HandlerCtx) => Plan<Omit<CommandResults[T], never>>;

export type HandlerTable = { [T in CommandType]?: Handler<T> };
