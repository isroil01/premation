/**
 * The autosave arming window must DEFER early changes, not drop them.
 *
 * The regression this pins: "start from a video" inserts the footage layer
 * ~1s after the project opens — inside the 3s arm window. `schedule()` used
 * to plain-return while unarmed, so that change never saved and the project
 * REOPENED AS AN EMPTY SCENE unless the user happened to edit again.
 */

import { render, cleanup } from '@testing-library/react';
import { act } from 'react';
import { CloudAutosave } from './CloudAutosave';
import { getEventBus } from '@core/events/EventBus';
import { api } from '@core/api/client';
import { useEntitlementStore } from '@stores/entitlementStore';

jest.mock('@core/api/client', () => ({
  api: { autosave: jest.fn().mockResolvedValue(undefined) },
}));

// captureDocument walks live singletons; the test only cares that a save fires.
jest.mock('@core/api/cloudDocument', () => ({
  captureDocument: jest.fn().mockReturnValue({ version: '1.1.0' }),
}));

const autosave = api.autosave as jest.Mock;

/** Drain the zero-delay capture timer + the promise chain inside flush(). */
async function drainFlush(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CloudAutosave arming', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    autosave.mockClear();
    // Writable account — the flush's entitlement gate must not eat the save.
    const s = useEntitlementStore.getState() as unknown as { access?: unknown };
    if (typeof (useEntitlementStore as unknown as { setState?: (v: object) => void }).setState === 'function') {
      (useEntitlementStore as unknown as { setState: (v: object) => void }).setState({
        access: { write: true },
      });
    }
    void s;
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('defers a change that lands during the arm window instead of dropping it', async () => {
    render(<CloudAutosave projectId="p1" />);

    // The footage insert: 1s after open — well inside the 3s arm window.
    act(() => {
      jest.advanceTimersByTime(1000);
      getEventBus().emit('SceneGraphChanged', undefined);
    });
    expect(autosave).not.toHaveBeenCalled();

    // Arm boundary (3s) + debounce (1.2s): the deferred change must now save.
    act(() => {
      jest.advanceTimersByTime(2100); // t = 3.1s → armed, deferred change schedules
    });
    act(() => {
      jest.advanceTimersByTime(1300); // debounce elapses → flush
    });
    await drainFlush();

    expect(autosave).toHaveBeenCalledTimes(1);
    expect(autosave).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('still saves changes that arrive after arming (the ordinary path)', async () => {
    render(<CloudAutosave projectId="p2" />);
    act(() => {
      jest.advanceTimersByTime(3000); // armed, nothing pending
    });
    expect(autosave).not.toHaveBeenCalled();

    act(() => {
      getEventBus().emit('NodeUpdated', { nodeId: 'n1', componentId: 'c1', propName: 'x', value: 1 });
      jest.advanceTimersByTime(1200);
    });
    await drainFlush();
    expect(autosave).toHaveBeenCalledTimes(1);
  });

  it('does not save at all when nothing ever changed', () => {
    render(<CloudAutosave projectId="p3" />);
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(autosave).not.toHaveBeenCalled();
  });
});
