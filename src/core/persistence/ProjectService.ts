import type { VersionedDocument } from '../types';
import { serializeProject, parseProject } from './ProjectSerializer';

/**
 * Reads/writes the project document as JSON. Deliberately shape-agnostic — it
 * only requires a `version`, so the app can evolve the document (scene →
 * scene+animation+comps+timelines) without touching persistence.
 */
export class ProjectService {
  serialize(project: VersionedDocument): string {
    return serializeProject(project);
  }

  parse(json: string): VersionedDocument {
    return parseProject(json);
  }
}

export const projectService = new ProjectService();

export default projectService;
