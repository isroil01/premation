/**
 * The title bar's route slot.
 *
 * Off the editor route the desktop title bar is otherwise empty, and a page
 * with a bar of its own (the dashboard: search, account) stacked a second
 * header under it. The title bar renders an empty element with this id on
 * those routes, and the page portals its controls into it — one bar, and the
 * editor's title bar never sees the slot.
 *
 * Its own file so a page can name the slot without importing the title bar
 * (and the menu bar behind it) into its bundle.
 */
export const TITLE_BAR_ROUTE_SLOT_ID = 'title-bar-route-slot';
