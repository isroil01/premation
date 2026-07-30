/**
 * Contract for `areRowPropsEqual` — the memo comparator that lets the timeline's
 * row subcomponents (track headers, lane content, keyframes) skip re-rendering
 * on the 60×/s playhead frames they don't depend on.
 *
 * The optimization's real hazard is a FALSE positive: reporting "equal" when a
 * genuine data change happened would leave the UI stale. These tests pin both
 * directions — skip on identity churn, re-render on real change.
 */
import { areRowPropsEqual } from './Timeline';

const noop = (): void => {};

describe('areRowPropsEqual', () => {
  it('is equal when nothing changed', () => {
    const track = { id: 'a' };
    const props = { track, index: 1, selected: false, onClick: noop };
    expect(areRowPropsEqual(props, { ...props })).toBe(true);
  });

  it('ignores callback identity churn (closures are bound to a stable id)', () => {
    const track = { id: 'a' };
    const prev = { track, index: 1, onClick: () => {}, onToggle: () => {} };
    const next = { track, index: 1, onClick: () => {}, onToggle: () => {} };
    // Different closure instances, same data → skip re-render.
    expect(areRowPropsEqual(prev, next)).toBe(true);
  });

  it('ignores a fresh style object with identical values', () => {
    const track = { id: 'a' };
    const prev = { track, style: { position: 'absolute', top: 30, height: 30 } };
    const next = { track, style: { position: 'absolute', top: 30, height: 30 } };
    expect(areRowPropsEqual(prev, next)).toBe(true);
  });

  it('re-renders when style geometry changes (scroll / row-height)', () => {
    const track = { id: 'a' };
    const prev = { track, style: { position: 'absolute', top: 30, height: 30 } };
    const next = { track, style: { position: 'absolute', top: 60, height: 30 } };
    expect(areRowPropsEqual(prev, next)).toBe(false);
  });

  it('re-renders when the track object is replaced (data changed)', () => {
    const prev = { track: { id: 'a' }, index: 1, selected: false };
    const next = { track: { id: 'a' }, index: 1, selected: false };
    // Different object identities for a NON-function, non-style prop → not equal.
    expect(areRowPropsEqual(prev, next)).toBe(false);
  });

  it('re-renders when a primitive data prop changes (selection, index, expanded)', () => {
    const track = { id: 'a' };
    expect(areRowPropsEqual({ track, selected: false }, { track, selected: true })).toBe(false);
    expect(areRowPropsEqual({ track, index: 1 }, { track, index: 2 })).toBe(false);
    expect(areRowPropsEqual({ track, expanded: true }, { track, expanded: false })).toBe(false);
  });

  it('re-renders when the prop set differs (added / removed key)', () => {
    const track = { id: 'a' };
    expect(areRowPropsEqual({ track }, { track, extra: 1 })).toBe(false);
  });

  it('treats a style prop that turns non-object as a change', () => {
    const track = { id: 'a' };
    expect(areRowPropsEqual({ track, style: { top: 1 } }, { track, style: undefined })).toBe(false);
  });
});
