/**
 * Rebuilds its subtree when the UI language changes.
 *
 * `t()` returns plain strings and most of the UI reads them once per render,
 * behind `memo`, `useMemo` and tables built at mount, so a redraw from the top
 * cannot reach all of them. A remount reaches every one. It keeps what lives in
 * stores (the document, selection, playhead, panel layout) and resets only local
 * React state, which is the same thing leaving the page and coming back does.
 *
 * So place it AROUND VIEWS, never around anything that owns a session: the
 * engine boot in `Providers`, project loaders and autosave stay outside it.
 */

import { Fragment, type ReactNode } from 'react';
import { useCatalogueRevision } from '@hooks/useLocale';

export function LocaleBoundary({ children }: { children: ReactNode }): JSX.Element {
  const revision = useCatalogueRevision();
  return <Fragment key={revision}>{children}</Fragment>;
}
