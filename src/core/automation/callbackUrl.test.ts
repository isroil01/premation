import { isAllowedCallbackUrl } from './callbackUrl';

describe('isAllowedCallbackUrl', () => {
  it('accepts public https webhook endpoints', () => {
    expect(isAllowedCallbackUrl('https://n8n.example.com/webhook/render-done')).toBe(true);
    expect(isAllowedCallbackUrl('https://hooks.zapier.com/hooks/catch/123/abc')).toBe(true);
  });

  it('rejects private and loopback hosts', () => {
    expect(isAllowedCallbackUrl('http://127.0.0.1/webhook')).toBe(false);
    expect(isAllowedCallbackUrl('http://192.168.0.5/hook')).toBe(false);
    expect(isAllowedCallbackUrl('http://169.254.169.254/')).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isAllowedCallbackUrl('file:///tmp/hook')).toBe(false);
    expect(isAllowedCallbackUrl('javascript:alert(1)')).toBe(false);
  });
});
