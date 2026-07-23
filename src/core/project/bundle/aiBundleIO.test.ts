/**
 * AI bundle chunks — conversation history + Director memory round-trip through a
 * bundle, independent of the document codec.
 */

import { readAiConversations, writeAiConversations, readAiMemory, writeAiMemory } from './aiBundleIO';
import { MemoryBundleFs } from './BundleFs';

const ROOT = '/p/My.motion';

describe('conversations', () => {
  it('round-trips prose conversations', async () => {
    const fs = new MemoryBundleFs();
    const convos = [
      { id: 'c1', title: 'Intro', updatedAt: 10, messages: [
        { seq: 0, role: 'user' as const, content: 'hi' },
        { seq: 1, role: 'assistant' as const, content: 'hello' },
      ] },
    ];
    await writeAiConversations(fs, ROOT, convos);
    expect(await readAiConversations(fs, ROOT)).toEqual(convos);
  });

  it('returns [] when there is no conversations chunk', async () => {
    expect(await readAiConversations(new MemoryBundleFs(), ROOT)).toEqual([]);
  });
});

describe('Director memory', () => {
  it('round-trips brand + project memory', async () => {
    const fs = new MemoryBundleFs();
    await writeAiMemory(fs, ROOT, { brand: { tone: 'bold' }, project: { palette: ['#000'] } });
    const mem = await readAiMemory(fs, ROOT);
    expect(mem).toMatchObject({ version: '1.0.0', brand: { tone: 'bold' }, project: { palette: ['#000'] } });
  });

  it('returns null when there is no memory chunk', async () => {
    expect(await readAiMemory(new MemoryBundleFs(), ROOT)).toBeNull();
  });
});
