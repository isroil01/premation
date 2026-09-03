/**
 * The template authoring section before anything has been exposed.
 *
 * This is the panel's first-run state and it used to be an unbroken wall of
 * instruction text with no visual anchor — the one shape in the app that says
 * "there is nothing here yet" was missing from the surface most likely to be
 * empty.
 */

import { render, screen } from '@testing-library/react';
import { TemplateAuthoringSection } from './TemplateFieldsPanel';
import { useTemplateStore } from '@stores/templateStore';
import { useSelectionStore } from '@stores/selectionStore';

beforeEach(() => {
  useTemplateStore.setState({ active: null });
  useSelectionStore.getState().clear();
});

it('shows an empty state until a layer is exposed as a field', () => {
  render(<TemplateAuthoringSection />);

  expect(screen.getByText('No fields exposed yet')).toBeTruthy();
});
