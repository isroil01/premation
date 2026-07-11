import type { ProjectFile } from '../types';

export function serializeProject(project: ProjectFile): string {
  // Minimal validation
  if (!project.version) throw new Error('Project must have a version');
  return JSON.stringify(project, null, 2);
}

export function parseProject(json: string): ProjectFile {
  const obj = JSON.parse(json);
  if (!obj || typeof obj !== 'object') throw new Error('Invalid project JSON');
  // Basic shape validation can be extended later
  return obj as ProjectFile;
}

export const ProjectSerializer = { serializeProject, parseProject };

export default ProjectSerializer;
