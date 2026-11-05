/**
 * How far a property row's name and value move to stay in view while the layer
 * columns are scrolled sideways.
 *
 * A layer row's columns scroll; a property row has nothing to line up with once
 * they do, and scrolling it just cut its name in half. It follows the visible
 * edge instead. When the column is too narrow to show the whole row, it gives
 * way by the shortfall, so scrolling to the end still reaches the values.
 */

/** Where a property row's content ends: the value column's left edge plus two value fields. */
export const PROPERTY_ROW_CONTENT_PX = 520;

export function propertyRowPin(scrollLeft: number, clientWidth: number): number {
  const shortfall = Math.max(0, PROPERTY_ROW_CONTENT_PX - clientWidth);
  return Math.max(0, scrollLeft - shortfall);
}
