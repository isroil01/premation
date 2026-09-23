/**
 * @motion/ai-tools — the typed vocabulary an LLM uses to author motion graphics.
 *
 * Pure by design — its one dependency is the engine API's TYPES
 * (`@motion/engine-api`, type-only; B5: the facades a handler receives are async
 * over the engine): the renderer, Electron's main process, and the NestJS
 * backend all read these same definitions, so a tool is described exactly once
 * and cannot drift between them.
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
  CompSettingsView,
  TimeFacade,
  AiEngineSession,
  ProviderId,
  AiErrorCode,
  AiEvent,
  AiToolCall,
  AiImage,
  AiMessage,
  AiRequest,
} from './types';

export { mutates, bindAlias, resolveAlias, AiEngineError } from './types';
export { ToolRegistry } from './registry';
export {
  SPRING_PRESETS,
  bakeSpring,
  dampingRatio,
  resolveSpring,
  sampleSpring,
  thinSamples,
  type BakeOptions,
  type BakedSpring,
  type SpringParams,
  type SpringPresetName,
  type SpringSample,
} from './spring';
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
