import type { AiToolDef } from '../types';
import { READ_TOOL_DEFS } from './read';
import { WRITE_TOOL_DEFS } from './write';
import { CRAFT_TOOL_DEFS, LATE_TOOL_DEFS } from './craft';
import { COMPOSE_TOOL_DEFS } from './compose';

export * from './read';
export * from './write';
export * from './craft';
export * from './compose';

/**
 * Every tool the AI can reach.
 *
 * Read tools first (look before you edit), then the write primitives, then the
 * craft primitives from `craft.ts` — the ones a *technique* needs and a recipe
 * did not. The `compose` recipes sit at the end and are on their way out: the
 * technique library replaces them with emitters that compile to primitives, so a
 * high compose ratio stops being a quality signal and starts being homogeneity.
 */
export const ALL_TOOL_DEFS: readonly AiToolDef[] = [
  ...READ_TOOL_DEFS,
  ...WRITE_TOOL_DEFS,
  ...CRAFT_TOOL_DEFS,
  ...COMPOSE_TOOL_DEFS,
  // Five tools that used to be registered inline in `buildAiTools()`, bypassing
  // this list entirely. Two sources of truth for the tool surface is how a
  // drift check can read the whole registry and still miss five of it.
  ...LATE_TOOL_DEFS,
];
