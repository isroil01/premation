/**
 * The rules that keep product events private and the numbers honest. Each one
 * fails silently when broken — an event sent with sharing off, one account's
 * queue delivered under the next account's session, a file name in a reason —
 * so each is pinned here.
 */

let signedIn = true;
jest.mock('@core/api/session', () => ({ hasSession: () => signedIn }));

import { EngineRequestError } from '@motion/engine-api';
import { engineFailure } from '@core/engine/engineFailure';
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
  trackEngineRestart,
  trackOnce,
  trackRendererGone,
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
    // A plain Error is sorted by what it says, never by the words themselves.
    expect(failureReason(new Error('premation-engine restarted (hang); request dropped'))).toBe('engine');
    expect(failureReason(new Error('the engine is unavailable after 3 crashes'))).toBe('engine');
    expect(failureReason(new Error('engine request timed out'))).toBe('engine');
    expect(failureReason(new RangeError('Maximum call stack size exceeded'))).toBe('stack_overflow');
    expect(failureReason(new Error('Unexpected token < in JSON at position 0'))).toBe('parse');
    expect(failureReason(new Error('font "Inter Display" is missing a glyph'))).toBe('font');
    expect(failureReason(new Error('layer "Hero Title" not found'))).toBe('missing');
    expect(failureReason(new Error('fetch failed: 503'))).toBe('network');
    expect(failureReason(new Error('something nobody wrote a rule for yet'))).toBe('error');
    expect(failureReason(new Error(''))).toBe('error_empty');
  });

  it('keeps an engine refusal\'s code and names the IPC channel a main-process handler threw on', () => {
    const refused = new EngineRequestError({ code: 'busy', message: 'the engine is busy rendering "Hero Title"' });
    expect(failureReason(refused)).toBe('engine_busy');
    // engineFailure: the engine's own sentence for the user, its code for the dashboard.
    const kept = engineFailure({ code: 'decode', message: 'could not decode C:\\Users\\ada\\clip.mov' });
    expect(kept.message).toBe('could not decode C:\\Users\\ada\\clip.mov');
    expect(failureReason(kept)).toBe('engine_decode');
    const ipc = new Error("Error invoking remote method 'file:readFile': Error: ENOENT: no such file, open 'C:\\Users\\ada\\a.png'");
    expect(failureReason(ipc)).toBe('ipc_file-readFile');
  });

  it('reports engine restarts and a page that died, as codes the server keeps', () => {
    trackEngineRestart('hang');
    trackRendererGone('oom');
    const crashes = __peekQueue().filter((e) => e.name === 'crash').map((e) => e.props);
    expect(crashes).toEqual([
      { source: 'worker', reason: 'engine_hang' },
      { source: 'window', reason: 'renderer_oom' },
    ]);
    for (const c of crashes) expect(String(c?.reason)).toMatch(/^[A-Za-z0-9_-]{1,48}$/);
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
