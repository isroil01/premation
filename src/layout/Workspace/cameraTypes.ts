/**
 * The slice of the viewport camera an overlay needs.
 *
 * A structural type rather than the concrete `Camera`, so `layerScreenMapping`
 * can be handed the 1:1 stub the overlay tests mock without importing the
 * workspace package into a unit test.
 */
export interface Camera2DLike {
  worldToScreen(p: { x: number; y: number }): { x: number; y: number };
  screenToWorld(p: { x: number; y: number }): { x: number; y: number };
}
