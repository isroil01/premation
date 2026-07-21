import { api, setToken } from './client';

jest.mock('./env', () => ({ API_URL: undefined }));

/**
 * These cover the shared `request()` helper — auth header, body shape, and the
 * ApiError contract — through a real endpoint. They used to ride on `aiEdit`,
 * which is gone: the assistant now calls the user's own provider directly and
 * the server only stores the transcript. Retargeted onto `appendMessages`, the
 * error paths are identical.
 */
describe('API client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => setToken(null));
  afterEach(() => { global.fetch = originalFetch; });

  test('sends the auth header and body, and parses the response', async () => {
    const mockResponse = { id: 'conv1', appended: 2 };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockResponse });
    setToken('fake-token');

    const result = await api.appendMessages('conv1', {
      messages: [
        { role: 'user', content: 'Make it bounce' },
        { role: 'assistant', content: 'Added a bounce.' },
      ],
      projectId: 'proj1',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/conversations/conv1/messages'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer fake-token',
        },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'Make it bounce' },
            { role: 'assistant', content: 'Added a bounce.' },
          ],
          projectId: 'proj1',
        }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  test('throws ApiError carrying status and parsed body on a 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal Server Error' }),
    });

    await expect(api.getConversation('c1')).rejects.toThrow('Internal Server Error');

    try {
      await api.getConversation('c1');
    } catch (err: any) {
      expect(err.status).toBe(500);
      expect(err.body.message).toBe('Internal Server Error');
    }
  });

  test('falls back to the raw text when the error body is not JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => { throw new Error('Not JSON'); },
      text: async () => 'Bad Request Text',
    });

    try {
      await api.getConversation('c1');
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.body).toBe('Bad Request Text');
      expect(err.message).toBe('Request failed (400)');
    }
  });

  test('deleteConversation issues a DELETE', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    await api.deleteConversation('conv1');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/conversations/conv1'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
