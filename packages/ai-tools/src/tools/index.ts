import type { AiToolDef } from '../types';
import { READ_TOOL_DEFS } from './read';
import { WRITE_TOOL_DEFS } from './write';
import { COMPOSE_TOOL_DEFS } from './compose';

export * from './read';
export * from './write';
export * from './compose';

/**
 * Every tool the AI can reach. Read tools first (look before you edit); the
 * high-level compose tools sit at the end but the prompt steers the model to
 * prefer them over hand-authoring with the low-level write tools.
 */
export const ALL_TOOL_DEFS: readonly AiToolDef[] = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS, ...COMPOSE_TOOL_DEFS];
