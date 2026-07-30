import { readOnlyDetail } from './transport';

/**
 * The read-only 403 detector. A regression here is INVISIBLE in the paywall — the
 * server guard still refuses the write — but the editor stops noticing, so the
 * read-only bar never shows and CloudAutosave retries the 403 forever with
 * backoff. So both NestJS shapes have to keep parsing.
 */
describe('readOnlyDetail', () => {
  it('reads the code when NestJS nests it under message', () => {
    // What ForbiddenException({ code, reason, message }) actually serializes to.
    const body = {
      statusCode: 403,
      message: { code: 'read_only', reason: 'trial_expired', message: 'Your trial has ended.' },
    };
    expect(readOnlyDetail(403, body)).toEqual({
      reason: 'trial_expired',
      message: 'Your trial has ended.',
    });
  });

  it('reads the code when it sits flat on the body', () => {
    const body = { code: 'read_only', reason: 'lapsed', message: 'Your plan has ended.' };
    expect(readOnlyDetail(403, body)).toEqual({ reason: 'lapsed', message: 'Your plan has ended.' });
  });

  it('ignores a 403 that is not about entitlement', () => {
    // A permission 403 (someone else's project) must NOT flip this user to
    // read-only across their whole account.
    expect(readOnlyDetail(403, { message: 'Forbidden' })).toBeNull();
    expect(readOnlyDetail(403, { code: 'not_owner' })).toBeNull();
  });

  it('ignores non-403 responses even if they mention read_only', () => {
    expect(readOnlyDetail(500, { code: 'read_only' })).toBeNull();
    expect(readOnlyDetail(200, { code: 'read_only' })).toBeNull();
  });

  it('survives a body that is a bare string or missing', () => {
    expect(readOnlyDetail(403, 'Forbidden')).toBeNull();
    expect(readOnlyDetail(403, undefined)).toBeNull();
    expect(readOnlyDetail(403, null)).toBeNull();
  });

  it('returns the code with no extras when reason and message are absent', () => {
    expect(readOnlyDetail(403, { code: 'read_only' })).toEqual({ reason: undefined, message: undefined });
  });
});
