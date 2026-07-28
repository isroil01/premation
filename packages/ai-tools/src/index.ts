/**
 * @motion/ai-tools — the typed vocabulary an LLM uses to author motion graphics.
 *
 * Pure and dependency-free by design: the renderer, Electron's main process,
 * and the NestJS backend all read these same definitions, so a tool is
 * described exactly once and cannot drift between them.
 */

export type {
  JsonSchema,
  ToolKind,
  AiToolDef,
  AiTool,
  ToolResult,
  ToolHandler,
  ToolContext,
  SceneFacade,
  SceneNodeView,
  AnimFacade,
  KeyframeView,
  CompFacade,
  TimeFacade,
  ProviderId,
  AiErrorCode,
  AiEvent,
  AiToolCall,
  AiImage,
  AiMessage,
  AiRequest,
} from './types';

export { mutates } from './types';
export { ToolRegistry } from './registry';
export {
  ADAPTERS,
  getAdapter,
  openAiAdapter,
  anthropicAdapter,
  geminiAdapter,
  SseReader,
  safeJson,
  type ProviderAdapter,
  type StreamParser,
} from './providers';
export { validate, type ValidResult } from './schema';
export {
  toOpenAiTools,
  toAnthropicTools,
  toGeminiDeclarations,
  toMcpToolList,
  stripUnsupported,
} from './emit';
export * from './tools';
