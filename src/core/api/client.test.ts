import { api, setToken } from './client';

jest.mock('./env', () => ({ API_URL: undefined }));

describe('API Client - aiEdit', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset the stored token
    setToken(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('sends correct request format and parses successful response', async () => {
    const mockResponse = {
      label: 'AI Suggestion',
      message: 'Here is what I changed.',
      ops: [{ op: 'set', nodeId: 'n1', prop: 'x', t: 0, value: 10 }],
      fallback: false,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    setToken('fake-token');

    const result = await api.aiEdit({
      prompt: 'Make it bounce',
      projectId: 'proj1',
      selection: ['n1'],
      atTime: 2.5,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/edit'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer fake-token',
        },
        body: JSON.stringify({
          prompt: 'Make it bounce',
          projectId: 'proj1',
          selection: ['n1'],
          atTime: 2.5,
        }),
      })
    );

    expect(result).toEqual(mockResponse);
  });

  test('throws ApiError with fallback context on 500 server error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal Server Error' }),
    });

    await expect(api.aiEdit({ prompt: 'test' })).rejects.toThrow('Internal Server Error');
    
    try {
      await api.aiEdit({ prompt: 'test' });
    } catch (err: any) {
      expect(err.status).toBe(500);
      expect(err.body.message).toBe('Internal Server Error');
    }
  });

  test('throws ApiError on text-based error response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => { throw new Error('Not JSON'); },
      text: async () => 'Bad Request Text',
    });

    try {
      await api.aiEdit({ prompt: 'test' });
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.body).toBe('Bad Request Text');
      expect(err.message).toBe('Request failed (400)');
    }
  });
});
