/**
 * Help ▸ About tells the truth about the version.
 *
 * WHY THIS EXISTS. The dialog said "Version 0.1.0 — frontend foundation." in a
 * 0.8.5 build: a string typed once and never connected to anything. Compared
 * against package.json itself, so the next release cannot drift either.
 */

import { render, screen } from '@testing-library/react';
import pkg from '../../../package.json';
import { AboutContent, aboutVersionLine, buildAboutCommand } from './AboutDialog';
import { ProjectCommands } from '@layout/Menu/menuModel';

describe('About', () => {
  it('shows the version from package.json', () => {
    render(<AboutContent />);
    expect(screen.getByText(`Version ${(pkg as { version: string }).version}`)).toBeInTheDocument();
    expect(aboutVersionLine()).toMatch(/^Version \d+\.\d+\.\d+/);
  });

  it('no longer calls itself a frontend foundation', () => {
    const { container } = render(<AboutContent />);
    expect(container.textContent).not.toMatch(/frontend foundation/i);
    expect(container.textContent).not.toContain('0.1.0');
  });

  it('registers under the id the Help menu row already points at', () => {
    expect(buildAboutCommand().id).toBe(ProjectCommands.About);
  });
});
