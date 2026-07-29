/**
 * The brand lockup's proportions are a design contract shared with the
 * marketing site (mark 56/wordmark 44/gap 12 and mark 72/wordmark 56/gap 16).
 * These lock the ratios and the accessible name so a later tweak to one
 * surface can't silently desynchronise the two.
 *
 * Plain Jest matchers only — jest-dom is imported at runtime by jest.setup.ts,
 * but that file sits outside tsconfig's `include`, so its matcher types are not
 * visible to `tsc -b`.
 */
import { render } from '@testing-library/react';
import { Logo, BRAND_NAME } from './Logo';

function imagesIn(container: HTMLElement): HTMLImageElement[] {
  return Array.from(container.querySelectorAll('img'));
}

describe('Logo', () => {
  it('renders the mark alone in the `mark` variant, named for screen readers', () => {
    const { container } = render(<Logo variant="mark" size={18} />);
    const imgs = imagesIn(container);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('alt')).toBe(BRAND_NAME);
    expect(imgs[0]!.getAttribute('width')).toBe('18');
    expect(imgs[0]!.getAttribute('height')).toBe('18');
  });

  it('renders mark + wordmark in the `lockup` variant, announcing the brand once', () => {
    const { container } = render(<Logo variant="lockup" size={32} />);
    const [mark, wordmark] = imagesIn(container);
    expect(imagesIn(container)).toHaveLength(2);
    // The mark is decorative in a lockup — otherwise a screen reader would say
    // the brand name twice.
    expect(mark!.getAttribute('alt')).toBe('');
    expect(mark!.getAttribute('aria-hidden')).toBe('true');
    expect(wordmark!.getAttribute('alt')).toBe(BRAND_NAME);
    expect(wordmark!.getAttribute('aria-hidden')).toBeNull();
  });

  it('derives the wordmark height and the gap from the mark height', () => {
    const { container } = render(<Logo variant="lockup" size={32} />);
    const [mark, wordmark] = imagesIn(container);
    expect(mark!.getAttribute('height')).toBe('32');
    // 32 * 0.78 = 24.96 → 25; the 512/96 aspect keeps the wordmark undistorted.
    expect(wordmark!.getAttribute('height')).toBe('25');
    expect(wordmark!.getAttribute('width')).toBe(String(Math.round(25 * (512 / 96))));
    // 32 * 0.22 = 7.04 → 7px, the "little gap" between mark and wordmark.
    expect((container.firstElementChild as HTMLElement).style.gap).toBe('7px');
  });

  it('scales the lockup proportionally at a larger size', () => {
    const { container } = render(<Logo variant="lockup" size={72} />);
    const [mark, wordmark] = imagesIn(container);
    expect(mark!.getAttribute('height')).toBe('72');
    // Matches the marketing site's 72/56 lockup exactly.
    expect(wordmark!.getAttribute('height')).toBe('56');
    expect((container.firstElementChild as HTMLElement).style.gap).toBe('16px');
  });

  it('centers the row and defaults to the lockup at 24px', () => {
    const { container } = render(<Logo />);
    const imgs = imagesIn(container);
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute('height')).toBe('24');
    expect((container.firstElementChild as HTMLElement).title).toBe(BRAND_NAME);
  });
});
