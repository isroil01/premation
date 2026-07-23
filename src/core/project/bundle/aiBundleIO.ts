/**
 * aiBundleIO — the AI chunks of a `.motion` bundle: conversation history and
 * Director memory, both moved on-device (were Postgres `AiConversation` rows and
 * `User.brandMemory`/`Project.aiMemory` columns).
 *
 * These live alongside the document but are NOT part of `EditorDocument`, so they
 * are managed here as independent chunks rather than through the document codec
 * (the codec already ignores unknown chunks, so this composes cleanly). Prose
 * only for conversations — tool traffic is deliberately not persisted, matching
 * the old backend policy.
 */

import type { BundleFs } from './BundleFs';

const CONVERSATIONS_PATH = 'ai/conversations.json';
const MEMORY_PATH = 'ai/memory.json';
const FILE_VERSION = '1.0.0';

export interface AiMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
}

export interface AiConversation {
  id: string;
  title?: string;
  updatedAt: number;
  messages: AiMessage[];
}

export interface AiConversationsFile {
  version: string;
  conversations: AiConversation[];
}

/** Director memory — opaque JSON (brand + project scoped), local to the bundle. */
export interface AiMemoryFile {
  version: string;
  brand?: unknown;
  project?: unknown;
}

export async function readAiConversations(fs: BundleFs, root: string): Promise<AiConversation[]> {
  const parsed = await readJson<AiConversationsFile>(fs, root, CONVERSATIONS_PATH);
  return parsed?.conversations ?? [];
}

export async function writeAiConversations(fs: BundleFs, root: string, conversations: AiConversation[]): Promise<void> {
  const file: AiConversationsFile = { version: FILE_VERSION, conversations };
  await fs.writeAtomic(root, CONVERSATIONS_PATH, JSON.stringify(file));
}

export async function readAiMemory(fs: BundleFs, root: string): Promise<AiMemoryFile | null> {
  return readJson<AiMemoryFile>(fs, root, MEMORY_PATH);
}

export async function writeAiMemory(fs: BundleFs, root: string, memory: Omit<AiMemoryFile, 'version'>): Promise<void> {
  const file: AiMemoryFile = { version: FILE_VERSION, ...memory };
  await fs.writeAtomic(root, MEMORY_PATH, JSON.stringify(file));
}

async function readJson<T>(fs: BundleFs, root: string, name: string): Promise<T | null> {
  const text = await fs.read(root, name);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
