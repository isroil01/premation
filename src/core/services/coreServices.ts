/**
 * Core service tokens + typed accessors.
 *
 * Services are registered in the DI `ServiceContainer` under these string
 * tokens (so plugins/tests can resolve them generically) and are also exposed
 * through typed getters for ergonomic call sites — mirroring the existing
 * getEventBus()/getCommandSystem() singleton pattern.
 */

import type { LoggerService } from '@core/logging/Logger';
import type { LoadingManager } from '@core/loading/LoadingManager';
import type { SettingsManager } from '@core/settings/SettingsManager';
import type { ThemeManager } from '@core/theme/ThemeManager';
import type { FileManager } from '@core/files/FileManager';
import type { RecentProjects } from '@core/project/RecentProjects';
import type { ProjectManager } from '@core/project/ProjectManager';

export const CoreService = {
  Logger: 'core.logger',
  Loading: 'core.loading',
  Settings: 'core.settings',
  Theme: 'core.theme',
  Files: 'core.files',
  Recent: 'core.recentProjects',
  Project: 'core.project',
} as const;

export type CoreServiceToken = (typeof CoreService)[keyof typeof CoreService];

export interface CoreServiceRefs {
  logger: LoggerService;
  loading: LoadingManager;
  settings: SettingsManager;
  theme: ThemeManager;
  files: FileManager;
  recent: RecentProjects;
  project: ProjectManager;
}

let refs: CoreServiceRefs | null = null;

export function setCoreServiceRefs(r: CoreServiceRefs): void {
  refs = r;
}

export function coreServices(): CoreServiceRefs {
  if (!refs) throw new Error('Core services not registered — call registerCoreServices() during boot.');
  return refs;
}

export const getSettingsManager = (): SettingsManager => coreServices().settings;
export const getThemeManager = (): ThemeManager => coreServices().theme;
export const getLoadingManager = (): LoadingManager => coreServices().loading;
export const getFileManager = (): FileManager => coreServices().files;
export const getRecentProjects = (): RecentProjects => coreServices().recent;
export const getProjectManager = (): ProjectManager => coreServices().project;
