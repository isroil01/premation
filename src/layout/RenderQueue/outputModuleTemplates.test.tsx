/**
 * Templates reaching the dialog — the wiring, not the registry.
 *
 * The registry test proves the math; this proves a click in the dropdown
 * actually moves the fields, resolved against the COMP the dialog was opened
 * for. A template row that renders but writes nothing is the composed-but-
 * unexecuted failure this repo keeps finding.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OutputModuleDialog, type OutputSettings } from './OutputModuleDialog';

const openDialog = (onConfirm: (s: OutputSettings) => void = () => {}) =>
  render(
    <OutputModuleDialog
      initialWidth={3840}
      initialHeight={2160}
      initialFps={30}
      initialDuration={10}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the template row', () => {
  it('offers the built-ins', () => {
    openDialog();
    const select = screen.getByLabelText('Output template');
    const names = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(names).toContain('Half Res Draft');
    expect(names).toContain('PNG Sequence (alpha)');
  });

  it('applying "Half Res Draft" halves THIS comp, not some remembered one', () => {
    // The dialog opened for a 4K comp, so half res is 1920 — the same template
    // on an HD comp would give 960. Scale-relative is the whole point.
    const confirmed: OutputSettings[] = [];
    openDialog((s) => confirmed.push(s));
    fireEvent.change(screen.getByLabelText('Output template'), { target: { value: 'Half Res Draft' } });
    fireEvent.click(screen.getByText('OK'));
    expect(confirmed[0]).toMatchObject({ width: 1920, height: 1080, quality: 'draft', fps: 30 });
  });

  it('a template with an fps override applies it; "comp" templates follow the comp', () => {
    const confirmed: OutputSettings[] = [];
    openDialog((s) => confirmed.push(s));
    fireEvent.change(screen.getByLabelText('Output template'), { target: { value: 'GIF Preview' } });
    fireEvent.click(screen.getByText('OK'));
    expect(confirmed[0]!.fps).toBe(15);
    expect(confirmed[0]!.format).toBe('gif');
  });

  it('an alpha template only claims transparency where the format can carry it', () => {
    const confirmed: OutputSettings[] = [];
    openDialog((s) => confirmed.push(s));
    fireEvent.change(screen.getByLabelText('Output template'), { target: { value: 'PNG Sequence (alpha)' } });
    fireEvent.click(screen.getByText('OK'));
    expect(confirmed[0]).toMatchObject({ format: 'png-sequence', transparent: true });
  });

  it('duration is never part of a template — the comp keeps its own', () => {
    const confirmed: OutputSettings[] = [];
    openDialog((s) => confirmed.push(s));
    fireEvent.change(screen.getByLabelText('Output template'), { target: { value: 'Half Res Draft' } });
    fireEvent.click(screen.getByText('OK'));
    expect(confirmed[0]!.durationSec).toBe(10);
  });
});
