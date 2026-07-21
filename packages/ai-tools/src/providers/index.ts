import type { ProviderId } from '../types';
import type { ProviderAdapter } from './types';
import { openAiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';

export type { ProviderAdapter, StreamParser } from './types';
export { SseReader, safeJson } from './sse';
export { openAiAdapter } from './openai';
export { anthropicAdapter } from './anthropic';
export { geminiAdapter } from './gemini';

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export const getAdapter = (id: ProviderId): ProviderAdapter => ADAPTERS[id];
