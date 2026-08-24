/**
 * Local AI conversation store — used when there is no cloud project / session.
 *
 * Prose only (user + assistant turns), matching the backend policy of not
 * persisting tool traffic. Survives reloads via localStorage.
 */

export interface LocalAiMessage {
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
}

export interface LocalAiConversation {
  id: string;
  title?: string;
  updatedAt: number;
  projectKey: string;
  messages: LocalAiMessage[];
}

interface StoreFile {
  version: 1;
  conversations: LocalAiConversation[];
}

const KEY = 'motion_editor_ai_conversations_v1';

function read(): StoreFile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { version: 1, conversations: [] };
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || !Array.isArray(parsed.conversations)) return { version: 1, conversations: [] };
    return { version: 1, conversations: parsed.conversations };
  } catch {
    return { version: 1, conversations: [] };
  }
}

function write(file: StoreFile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(file));
  } catch {
    /* quota / private mode — history is a convenience */
  }
}

export function listLocalConversations(projectKey: string): LocalAiConversation[] {
  return read()
    .conversations.filter((c) => c.projectKey === projectKey)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLocalConversation(id: string): LocalAiConversation | null {
  return read().conversations.find((c) => c.id === id) ?? null;
}

export function appendLocalMessages(
  id: string,
  projectKey: string,
  messages: LocalAiMessage[],
  title?: string,
): LocalAiConversation {
  const file = read();
  let conv = file.conversations.find((c) => c.id === id);
  if (!conv) {
    conv = {
      id,
      projectKey,
      updatedAt: Date.now(),
      messages: [],
      ...(title ? { title } : {}),
    };
    file.conversations.push(conv);
  }
  conv.messages.push(...messages);
  conv.updatedAt = Date.now();
  if (title && !conv.title) conv.title = title;
  write(file);
  return conv;
}

export function deleteLocalConversation(id: string): void {
  const file = read();
  file.conversations = file.conversations.filter((c) => c.id !== id);
  write(file);
}

