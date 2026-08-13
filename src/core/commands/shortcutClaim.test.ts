/**
 * A focused surface can take a chord back from the global shortcut.
 *
 * WHY THIS EXISTS. The dispatcher listens on `window` in the capture phase and
 * stops propagation on every chord it matches, so a panel's own key handler is
 * unreachable for any chord that is also bound globally. The Assets panel hit
 * this with Delete: it had a correct, wired, reviewed handler that could not
 * fire, because Delete belongs to "delete the selected layers". Nothing failed
 * — the key simply did nothing, which is invisible to types and to tests that
 * only call the handler directly.
 *
 * So the two properties asserted here are the ones that were actually wrong,
 * and the one that would be wrong if this were fixed carelessly: a claimed
 * chord is yielded, and an UNCLAIMED one is not. A surface that swallowed
 * everything while focused would stop Space from playing.
 */
import { claimsChord } from './ShortcutManager';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('claimsChord', () => {
  const PANEL = '<div data-shortcut-claim="delete backspace Ctrl+a Meta+a"><span id="row">row</span></div>';

  it('yields a chord the surface claims, from a descendant of it', () => {
    // The event target is the ROW, not the element carrying the attribute —
    // which is the only shape that ever occurs, since focus and clicks land on
    // the contents rather than the container.
    const host = mount(PANEL);
    const row = host.querySelector('#row');
    expect(claimsChord(row, 'delete')).toBe(true);
    expect(claimsChord(row, 'backspace')).toBe(true);
  });

  it('does NOT yield a chord the surface did not claim', () => {
    // The property that keeps this narrow. `v` (a tool) and `space` (play)
    // must still reach the global command from inside a claiming panel.
    const host = mount(PANEL);
    const row = host.querySelector('#row');
    expect(claimsChord(row, 'v')).toBe(false);
    expect(claimsChord(row, 'space')).toBe(false);
    expect(claimsChord(row, 'Ctrl+z')).toBe(false);
  });

  it('matches case-insensitively, so a claim cannot fail on a capital', () => {
    // `chordKey` emits `Ctrl+a` — capitalised modifier, lowercased key. An
    // author writing `ctrl+a` in the markup is not making a mistake worth
    // punishing with a silently dead key.
    const host = mount('<div data-shortcut-claim="ctrl+a"><span id="row">row</span></div>');
    expect(claimsChord(host.querySelector('#row'), 'Ctrl+a')).toBe(true);
  });

  it('is false with no claiming ancestor, and for a null target', () => {
    const host = mount('<div><span id="row">row</span></div>');
    expect(claimsChord(host.querySelector('#row'), 'delete')).toBe(false);
    expect(claimsChord(null, 'delete')).toBe(false);
  });

  it('survives a target that is not an Element', () => {
    // A keydown with nothing focused targets `window` or `document`, neither of
    // which has `closest`. This threw on the first cut and took out every
    // global shortcut — the dispatcher runs this before it matches anything,
    // so one TypeError here disables the whole keyboard.
    expect(claimsChord(window, 'delete')).toBe(false);
    expect(claimsChord(document, 'delete')).toBe(false);
  });

  it('ignores an empty claim rather than matching everything', () => {
    // `''.split(/\s+/)` yields `['']`, so a blank attribute would claim the
    // empty-string chord — harmless — but a naive `.includes` over that list
    // is the kind of thing that starts matching more than it should.
    const host = mount('<div data-shortcut-claim=""><span id="row">row</span></div>');
    expect(claimsChord(host.querySelector('#row'), 'delete')).toBe(false);
    expect(claimsChord(host.querySelector('#row'), '')).toBe(false);
  });
});
