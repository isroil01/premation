/**
 * AiChatContext — hoists the `useAiChat` state above the dock-panel tree.
 *
 * The AI chat lives in a left-sidebar tab, and DockPanel unmounts inactive
 * tabs. If the panel owned the hook, switching to Shapes mid-generation would
 * cancel the run and roll back a pending preview transaction. The provider
 * mounts once at the editor shell, so chat state, streaming runs, and the
 * Apply/Decline transaction all survive tab switches.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useAiChat, type UseAiChat } from '@layout/Workspace/useAiChat';

const AiChatCtx = createContext<UseAiChat | null>(null);

export function AiChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const chat = useAiChat();
  return <AiChatCtx.Provider value={chat}>{children}</AiChatCtx.Provider>;
}

export function useAiChatContext(): UseAiChat {
  const v = useContext(AiChatCtx);
  if (!v) throw new Error('useAiChatContext must be used inside <AiChatProvider>');
  return v;
}
