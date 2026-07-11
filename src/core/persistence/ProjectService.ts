import type { ProjectFile } from '../types';
import { serializeProject, parseProject } from './ProjectSerializer';

export class ProjectService {
  serialize(project: ProjectFile): string {
    return serializeProject(project);
  }

  parse(json: string): ProjectFile {
    return parseProject(json);
  }
}

export const projectService = new ProjectService();

export default projectService;
