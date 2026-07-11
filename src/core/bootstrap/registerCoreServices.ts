/**
 * registerCoreServices — the composition root for framework-agnostic services.
 *
 * Instantiates every core service, registers each into the DI container under
 * its token, and publishes the typed singleton refs. Called once from
 * Application.boot so services are available before any UI renders.
 */

import type { ServiceContainer } from '@core/services/ServiceContainer';
import { CoreService, setCoreServiceRefs, type CoreServiceRefs } from '@core/services/coreServices';
import { getLogger } from '@core/logging/Logger';
import { LoadingManager } from '@core/loading/LoadingManager';
import { SettingsManager } from '@core/settings/SettingsManager';
import { ThemeManager } from '@core/theme/ThemeManager';
import { FileManager } from '@core/files/FileManager';
import { RecentProjects } from '@core/project/RecentProjects';
import { ProjectManager } from '@core/project/ProjectManager';
import { projectService } from '@core/persistence/ProjectService';

export function registerCoreServices(container: ServiceContainer): CoreServiceRefs {
  const logger = getLogger();
  const loading = new LoadingManager();
  const settings = new SettingsManager();
  const theme = new ThemeManager({ settings });
  const files = new FileManager();
  const recent = new RecentProjects(settings);
  const project = new ProjectManager({ service: projectService, files, recent, logger });

  container.register(CoreService.Logger, logger);
  container.register(CoreService.Loading, loading);
  container.register(CoreService.Settings, settings);
  container.register(CoreService.Theme, theme);
  container.register(CoreService.Files, files);
  container.register(CoreService.Recent, recent);
  container.register(CoreService.Project, project);

  const refs: CoreServiceRefs = { logger, loading, settings, theme, files, recent, project };
  setCoreServiceRefs(refs);
  logger.scope('boot').info('Core services registered', { environment: files.environment });
  return refs;
}
