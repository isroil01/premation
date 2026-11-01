/**
 * The dashboard→editor handoff for "render this project".
 *
 * A render is snapshotted from the open document, so the dashboard's Render
 * button opens the project and parks its id here; the editor's ProjectLoader
 * collects it once the project is open and brings up the Export dialog.
 *
 * A one-shot, like `pendingTemplate`: `take` clears, and only the project it
 * was parked for can collect it.
 */

let pending: string | null = null;

export function setPendingRender(projectId: string): void {
  pending = projectId;
}

export function takePendingRender(projectId: string): boolean {
  const hit = pending === projectId;
  pending = null;
  return hit;
}
