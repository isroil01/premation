/**
 * @jest-environment jsdom
 */

import {
  appendLocalMessages,
  getLocalConversation,
  listLocalConversations,
  deleteLocalConversation,
} from './localConversations';

describe('localConversations', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('appends turns and lists them by project', () => {
    appendLocalMessages('c1', 'local', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], 'hello');
    const listed = listLocalConversations('local');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe('c1');
    expect(getLocalConversation('c1')?.messages).toHaveLength(2);
    expect(listLocalConversations('other')).toHaveLength(0);
  });

  it('deletes a thread', () => {
    appendLocalMessages('c1', 'local', [{ role: 'user', content: 'x' }]);
    deleteLocalConversation('c1');
    expect(getLocalConversation('c1')).toBeNull();
  });
});
