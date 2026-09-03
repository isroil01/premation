/**
 * The relink dialog once every missing file has been found.
 *
 * A dialog that empties itself as you work is exactly the case where a bare
 * sentence reads as a rendering failure — you relinked the last asset and the
 * list you were working through vanished.
 */

import { render, screen } from '@testing-library/react';
import { RelinkBody } from './RelinkAssetsDialog';

it('says there is nothing left to relink', () => {
  render(<RelinkBody missing={[]} close={() => {}} />);

  expect(screen.getByText('Nothing left to relink')).toBeTruthy();
});
