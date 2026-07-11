/**
 * AI suggestion state (spec §AI Suggestion Behavior Rules — anti-Clippy).
 *
 *  - Global mode: Normal / Minimal / Off.
 *  - Dismissal is remembered PER ASSET — a dismissed suggestion never returns
 *    for the same object (keyed `${nodeId}:${suggestionId}`).
 *  - The auto card can be closed per node without dismissing its suggestions;
 *    they remain reachable behind the toolbar sparkle button.
 */

import { create } from 'zustand';

export type SuggestionMode = 'normal' | 'minimal' | 'off';

interface AiSuggestionStore {
  mode: SuggestionMode;
  setMode: (mode: SuggestionMode) => void;

  /** `${nodeId}:${suggestionId}` → dismissed. */
  dismissed: Record<string, true>;
  dismiss: (nodeId: string, suggestionId: string) => void;
  isDismissed: (nodeId: string, suggestionId: string) => boolean;

  /** nodeId whose auto card the user closed (this session). */
  closedCards: Record<string, true>;
  closeCard: (nodeId: string) => void;
  isCardClosed: (nodeId: string) => boolean;
}

const dkey = (nodeId: string, id: string): string => `${nodeId}:${id}`;

export const useAiSuggestionStore = create<AiSuggestionStore>((set, get) => ({
  mode: 'normal',
  setMode: (mode) => set({ mode }),

  dismissed: {},
  dismiss: (nodeId, id) => set((s) => ({ dismissed: { ...s.dismissed, [dkey(nodeId, id)]: true } })),
  isDismissed: (nodeId, id) => !!get().dismissed[dkey(nodeId, id)],

  closedCards: {},
  closeCard: (nodeId) => set((s) => ({ closedCards: { ...s.closedCards, [nodeId]: true } })),
  isCardClosed: (nodeId) => !!get().closedCards[nodeId],
}));
