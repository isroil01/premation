/**
 * The rules that keep product events private and the numbers honest. Each one
 * fails silently when broken — an event sent with sharing off, one account's
 * queue delivered under the next account's session, a file name in a reason —
 * so each is pinned here.
 */

let signedIn = true;
jest.mock('@core/api/session', () => ({ hasSession: () => signedIn }));

import { setEdition } from '@core/config/edition';
import { usePreferenceStore } from '@stores/preferenceStore';
import {
  __peekQueue,
  failureReason,
  flushProductEvents,
  mediaKindOf,
  noteNextProjectSource,
  noteSignedIn,
  resetProductEvents,
  setProductEventSender,
  track,
  trackCrash,
  trackOnce,
  trackProjectCreated,
  type EventBatch,
} from './productEvents';

const sent: EventBatch[] = [];

beforeEach(() => {
  signedIn = true;
  setEdition('server');
  usePreferenceStore.getState().set('shareUsageData', true);
  resetProductEvents();
  sent.length = 0;
  setProductEventSender(async (b) => {
    sent.push(b);
  });
});

afterAll(() => setProductEventSender(null));

describe('when nothing is recorded', () => {
  it('records nothing with sharing off — and does not queue it for later', () => {
    usePreferenceStore.getState().set('shareUsageData', false);
    track('preview_played');
    usePreferenceStore.getState().set('shareUsageData', true);
    expect(__peekQueue()).toHaveLength(0);
  });

  it('records nothing in the local edition or without a session', () => {
    setEdition('local');
    track('preview_played');
    setEdition('server');
    signedIn = false;
    track('preview_played');
    expect(__peekQueue()).toHaveLength(0);
  });

  it('does not spend a once-per-session event that could not be recorded', () => {
    signedIn = false;
    trackOnce('edit_session');
    signedIn = true;
    trackOnce('edit_session');
    trackOnce('edit_session');
    expect(__peekQueue().map((e) => e.name)).toEqual(['edit_session']);
  });
});

describe('accounts', () => {
  it('starts a different account from nothing', () => {
    noteSignedIn('a');
    track('preview_played');
    noteSignedIn('b');
    expect(__peekQueue().map((e) => e.name)).toEqual(['app_opened']);
  });

  it('keeps the queue when the same account is restored', () => {
    noteSignedIn('a');
    track('preview_played');
    noteSignedIn('a');
    expect(__peekQueue().map((e) => e.name)).toEqual(['app_opened', 'preview_played']);
  });
});

describe('flushing', () => {
  it('sends the queue with the build context and empties it', async () => {
    track('preview_played');
    await flushProductEvents();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events.map((e) => e.name)).toEqual(['preview_played']);
    expect(sent[0]!.context.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(__peekQueue()).toHaveLength(0);
  });

  it('keeps a batch the network lost, and drops one the server refused', async () => {
    setProductEventSender(() => Promise.reject(Object.assign(new Error('offline'), { status: 0 })));
    track('preview_played');
    await flushProductEvents();
    expect(__peekQueue()).toHaveLength(1);

    setProductEventSender(() => Promise.reject(Object.assign(new Error('bad'), { status: 400 })));
    await flushProductEvents();
    expect(__peekQueue()).toHaveLength(0);
  });
});

describe('what an event may say', () => {
  it('reduces an error to a code, never its message', () => {
    expect(failureReason(new Error('Could not write C:\\Users\\ada\\Launch final.mp4: ENOSPC'))).toBe('disk_full');
    expect(failureReason(new Error('VideoEncoder configure failed'))).toBe('encoder');
    expect(failureReason(new TypeError('x is undefined in /Users/ada/secret'))).toBe('TypeError');
    expect(failureReason('something odd')).toBe('unknown');
  });

  it('ignores aborts and layout noise, and caps crashes per session', () => {
    trackCrash('promise', Object.assign(new Error('stop'), { name: 'AbortError' }));
    trackCrash('window', new Error('ResizeObserver loop completed with undelivered notifications.'));
    for (let i = 0; i < 20; i++) trackCrash('window', new TypeError('boom'));
    expect(__peekQueue().filter((e) => e.name === 'crash')).toHaveLength(5);
  });

  it('classifies media by kind, not by name', () => {
    expect(mediaKindOf({ name: 'Holiday.MOV', type: '' })).toBe('video');
    expect(mediaKindOf({ name: 'logo.svg', type: 'image/svg+xml' })).toBe('svg');
    expect(mediaKindOf({ name: 'voice.m4a', type: 'audio/mp4' })).toBe('audio');
    expect(mediaKindOf({ name: 'notes.txt', type: 'text/plain' })).toBe('other');
  });
});

describe('project source', () => {
  it('uses the source the caller announced, once, then falls back to blank', () => {
    noteNextProjectSource('template');
    trackProjectCreated();
    trackProjectCreated();
    expect(__peekQueue().map((e) => e.props?.source)).toEqual(['template', 'blank']);
  });
});
