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
import {
  FileProjectStorage,
  BundleProjectStorage,
  RoutedProjectStorage,
} from '@core/persistence/ProjectStorage';
import { initLocalIndex } from '@core/localIndex/sqliteLocalIndex';
import { setLocalBlobResolver } from '@core/rendering/localBlobSource';
import { createBlobStore } from '@core/assets/local/blobStoreEnv';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { isLocalFirst } from '@core/config/flags';

export function registerCoreServices(container: ServiceContainer): CoreServiceRefs {
  const logger = getLogger();
  const loading = new LoadingManager();
  const settings = new SettingsManager();
  const theme = new ThemeManager({ settings });
  const files = new FileManager();
  const recent = new RecentProjects(settings);
  // Route saves/opens to a `.motion` directory bundle under LOCAL_FIRST, else to
  // the legacy single-file blob. Bundles already on disk always open as bundles.
  const storage = new RoutedProjectStorage(
    new FileProjectStorage(projectService, files),
    new BundleProjectStorage(),
  );
  const project = new ProjectManager({ service: projectService, files, recent, logger, storage });

  container.register(CoreService.Logger, logger);
  container.register(CoreService.Loading, loading);
  container.register(CoreService.Settings, settings);
  container.register(CoreService.Theme, theme);
  container.register(CoreService.Files, files);
  container.register(CoreService.Recent, recent);
  container.register(CoreService.Project, project);

  const refs: CoreServiceRefs = { logger, loading, settings, theme, files, recent, project };
  setCoreServiceRefs(refs);
  // Swap in the SQLite index if the desktop backend is available (fire-and-forget;
  // the in-memory index stays otherwise). Never blocks boot.
  void initLocalIndex();

  // Let the GPU texture loader resolve `motion-blob:<hash>` refs to bytes from
  // the current project's content-addressed blob store (RFC §6). No-op unless a
  // local-first bundle is open.
  setLocalBlobResolver(async (hash) => {
    if (!isLocalFirst()) return null;
    const path = project.getState().current?.path ?? null;
    if (!path || !isBundlePath(path)) return null;
    return createBlobStore(path).read(hash);
  });
  logger.scope('boot').info('Core services registered', { environment: files.environment });
  return refs;
}
