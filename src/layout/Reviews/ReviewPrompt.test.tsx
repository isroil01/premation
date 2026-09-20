import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewPrompt } from './ReviewPrompt';
import { useReviewPromptStore } from '@stores/reviewPromptStore';
import { api, type MyReview } from '@core/api/client';

jest.mock('@core/api/client', () => ({
  api: {
    myReview: jest.fn(),
    submitReview: jest.fn(),
    dismissReviewPrompt: jest.fn(),
  },
}));

const myReview = api.myReview as jest.MockedFunction<typeof api.myReview>;
const submitReview = api.submitReview as jest.MockedFunction<typeof api.submitReview>;
const dismissPrompt = api.dismissReviewPrompt as jest.MockedFunction<
  typeof api.dismissReviewPrompt
>;

const IDLE = {
  open: false,
  submitting: false,
  error: null,
  status: null,
  consideredThisSession: false,
} as const;

/** A body long enough to clear the 40-character floor the server enforces. */
const LONG_ENOUGH =
  'I rebuilt our title sequence in an afternoon and it was genuinely painless.';

beforeEach(() => {
  jest.clearAllMocks();
  myReview.mockResolvedValue({ review: null, promptedAt: null, shouldPrompt: true });
  submitReview.mockResolvedValue({ id: 'r1', status: 'pending' });
  dismissPrompt.mockResolvedValue({ promptedAt: new Date().toISOString() });
  useReviewPromptStore.setState(IDLE);
});

function openPrompt(status: MyReview = { review: null, promptedAt: null, shouldPrompt: true }) {
  useReviewPromptStore.setState({ ...IDLE, open: true, status });
  return render(<ReviewPrompt />);
}

describe('the review prompt', () => {
  it('renders nothing until it is opened', () => {
    const { container } = render(<ReviewPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on the rating — the first ask is one click, not an essay', () => {
    openPrompt();

    const stars = screen.getAllByRole('radio');
    expect(stars).toHaveLength(5);
    expect(stars.every((s) => s.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('will not send without a rating', () => {
    openPrompt();

    fireEvent.change(screen.getByRole('textbox', { name: /What did you make/ }), {
      target: { value: LONG_ENOUGH },
    });

    expect(screen.getByRole('button', { name: 'Send review' })).toBeDisabled();
  });

  it('asks for a little more when the body is too short for the server', () => {
    openPrompt();

    fireEvent.click(screen.getByRole('radio', { name: /5 stars/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /What did you make/ }), {
      target: { value: 'great' },
    });

    // Said here rather than discovered by a round trip that 400s.
    expect(screen.getByText(/at least 40 characters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send review' })).toBeDisabled();
  });

  it('sends the rating and the trimmed body, omitting the optional fields', async () => {
    openPrompt();

    fireEvent.click(screen.getByRole('radio', { name: /4 stars/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /What did you make/ }), {
      target: { value: `  ${LONG_ENOUGH}  ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send review' }));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith({ rating: 4, body: LONG_ENOUGH }),
    );
  });

  it('says plainly that nothing publishes itself', () => {
    openPrompt();

    // A form that implies the words go live immediately is a form people write
    // differently into.
    expect(screen.getByText(/Nothing is published automatically/)).toBeInTheDocument();
  });

  it('records a refusal when the user says "Not now"', async () => {
    openPrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(dismissPrompt).toHaveBeenCalled());
    expect(useReviewPromptStore.getState().open).toBe(false);
  });

  it('does NOT record a refusal when the dialog is merely closed', () => {
    openPrompt();

    useReviewPromptStore.getState().close();

    // Closing is not declining. Treating it as one spends the single chance we
    // get to ask on a stray Escape.
    expect(dismissPrompt).not.toHaveBeenCalled();
    expect(useReviewPromptStore.getState().open).toBe(false);
  });

  it('starts on what they already wrote when editing a pending review', () => {
    openPrompt({
      review: { id: 'r1', rating: 3, title: 'Solid', body: LONG_ENOUGH, status: 'pending' },
      promptedAt: new Date().toISOString(),
      shouldPrompt: false,
    });

    expect(screen.getByRole('radio', { name: /3 stars/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: /What did you make/ })).toHaveValue(LONG_ENOUGH);
    expect(screen.getByRole('button', { name: 'Update review' })).toBeInTheDocument();
  });

  it('keeps the dialog open and shows why when the send fails', async () => {
    submitReview.mockRejectedValue(new Error('offline'));
    openPrompt();

    fireEvent.click(screen.getByRole('radio', { name: /5 stars/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /What did you make/ }), {
      target: { value: LONG_ENOUGH },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send review' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(useReviewPromptStore.getState().open).toBe(true);
  });
});

describe('deciding whether to ask', () => {
  it('never asks someone who has not made anything yet', async () => {
    await useReviewPromptStore.getState().consider({ hasProjects: false });

    expect(myReview).not.toHaveBeenCalled();
    expect(useReviewPromptStore.getState().open).toBe(false);
  });

  it('asks the server, and opens only when the server says to', async () => {
    myReview.mockResolvedValue({ review: null, promptedAt: null, shouldPrompt: false });

    await useReviewPromptStore.getState().consider({ hasProjects: true });

    expect(myReview).toHaveBeenCalled();
    expect(useReviewPromptStore.getState().open).toBe(false);
  });

  it('opens when the server says the prompt is owed', async () => {
    await useReviewPromptStore.getState().consider({ hasProjects: true });

    expect(useReviewPromptStore.getState().open).toBe(true);
  });

  it('asks the server once per session, however often the dashboard remounts', async () => {
    const store = useReviewPromptStore.getState();
    await store.consider({ hasProjects: true });
    await useReviewPromptStore.getState().consider({ hasProjects: true });
    await useReviewPromptStore.getState().consider({ hasProjects: true });

    expect(myReview).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the check fails — this is not worth an error on a dashboard', async () => {
    myReview.mockRejectedValue(new Error('offline'));

    await expect(
      useReviewPromptStore.getState().consider({ hasProjects: true }),
    ).resolves.toBeUndefined();
    expect(useReviewPromptStore.getState().open).toBe(false);
  });
});
