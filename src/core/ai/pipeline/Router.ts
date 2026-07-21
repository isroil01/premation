import type { GatewayProviderId } from '@core/api/client';
import type { ProviderId } from '@motion/ai-tools';

export interface RouterOptions {
  provider: GatewayProviderId;
  dialect: ProviderId;
  model: string;
  signal: AbortSignal;
}

export class Router {
  constructor(_options: RouterOptions) {}

  /**
   * Classify request as 'trivial_edit' (direct legacy AgentLoop) vs 'generative' (full pipeline).
   */
  async classify(prompt: string): Promise<'trivial_edit' | 'generative'> {
    // 1. Direct heuristic check (Imperative verbs + referencing elements/selection)
    const normalized = prompt.trim().toLowerCase();
    const trivialVerbRegex = /^(make|change|set|delete|move|hide|show|rename|update|align)\b/;
    const targetsSelection = /\b(this|selection|layer|color|title|text|opacity)\b/;

    if (trivialVerbRegex.test(normalized) && prompt.length < 50 && targetsSelection.test(normalized)) {
      return 'trivial_edit';
    }

    // Bias toward generative/creative pipelines for complex or longer prompts.
    return 'generative';
  }
}
