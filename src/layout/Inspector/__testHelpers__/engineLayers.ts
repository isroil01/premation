/**
 * Test helpers for inspector suites whose writes go through the engine API
 * (B3): `idle` waits for the asynchronous engine commands a click or a typed
 * value sent, and the mirror to follow.
 */

import { act } from '@testing-library/react';
import { settleEdits } from '@core/engine/__testHelpers__/appEngine';

/** Wait for every queued engine request (and re-render). */
export async function idle(): Promise<void> {
  await act(async () => { await settleEdits(); });
}
