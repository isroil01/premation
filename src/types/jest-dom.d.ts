/**
 * jest-dom's matcher augmentation, pulled into the app's type program.
 *
 * `jest.setup.ts` imports '@testing-library/jest-dom' at RUNTIME, so the
 * matchers work when tests execute. But `tsconfig.json` excludes the setup file
 * (its `include` is `src` only), so `tsc --noEmit` never saw the module
 * augmentation and reported `toBeInTheDocument does not exist on
 * JestMatchers<HTMLElement>` in every component test — two standing errors that
 * made `npm run typecheck` non-clean, which is how real errors get skimmed past.
 *
 * A `.d.ts` under `src` is the smallest fix that puts the augmentation inside
 * the same program as the tests that rely on it.
 */

import '@testing-library/jest-dom';
