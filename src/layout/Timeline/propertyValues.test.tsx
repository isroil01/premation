/**
 * The timeline's property rows carry live, scrubbable values (AE puts them
 * there so a whole animation can be built without crossing to the inspector).
 *
 * Before this the timeline could only ADD a keyframe: changing what it held
 * meant a round trip to the right-hand panel.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { PropertyHeader } from './Timeline';

describe('timeline property values', () => {
  const base = {
    label: 'Position',
    style: {},
    keyframes: [],
    currentTime: 0,
  };

  it('shows one field per edited prop, named so each is addressable', () => {
    render(
      <PropertyHeader
        {...base}
        valueProps={['x', 'y']}
        valueUnit="px"
        propertyValue={(p: string) => (p === 'x' ? -400 : 12)}
        onValueChange={() => undefined}
      />,
    );
    expect(screen.getByRole('spinbutton', { name: 'Position x' }).getAttribute('aria-valuenow')).toBe('-400');
    expect(screen.getByRole('spinbutton', { name: 'Position y' }).getAttribute('aria-valuenow')).toBe('12');
  });

  it('reports edits per prop, so Position x does not write y', () => {
    const seen: Array<[string, number]> = [];
    render(
      <PropertyHeader
        {...base}
        valueProps={['x', 'y']}
        valueUnit="px"
        propertyValue={() => 0}
        onValueChange={(p: string, v: number) => seen.push([p, v])}
      />,
    );
    // ArrowUp nudges the resting field by one step.
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Position x' }), { key: 'ArrowUp' });
    expect(seen).toEqual([['x', 1]]);
  });

  it('offers a value on a STATIC row too — AE lets you set before keyframing', () => {
    render(
      <PropertyHeader
        {...base}
        label="Opacity"
        animated={false}
        valueProps={['opacity']}
        valueUnit="%"
        propertyValue={() => 100}
        onValueChange={() => undefined}
        onStopwatch={() => undefined}
      />,
    );
    expect(screen.getByRole('spinbutton', { name: 'Opacity' }).getAttribute('aria-valuenow')).toBe('100');
    // ...and the stopwatch is still the way to start animating.
    expect(screen.queryByRole('button', { name: /Enable Opacity animation/i })).not.toBeNull();
  });

  it('renders no fields when the row declares none (rows that are not editable)', () => {
    render(<PropertyHeader {...base} />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
});

describe('the property stopwatch', () => {
  const base = { label: 'Position', style: {}, keyframes: [], currentTime: 0 };

  it('is present on an ANIMATED row and reads as on', () => {
    // It used to appear only on un-animated rows, so the timeline could turn
    // animation on but never off.
    const clicks: number[] = [];
    render(<PropertyHeader {...base} animated onStopwatch={() => clicks.push(1)} />);
    const sw = screen.getByRole('button', { name: /Disable Position animation/i });
    expect(sw.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sw);
    expect(clicks).toHaveLength(1);
  });

  it('reads as off on a static row and offers to enable', () => {
    render(<PropertyHeader {...base} animated={false} onStopwatch={() => undefined} />);
    const sw = screen.getByRole('button', { name: /Enable Position animation/i });
    expect(sw.getAttribute('aria-pressed')).toBe('false');
  });

  it('is absent when the row cannot be animated', () => {
    render(<PropertyHeader {...base} animated />);
    expect(screen.queryByRole('button', { name: /Position animation/i })).toBeNull();
  });
});
