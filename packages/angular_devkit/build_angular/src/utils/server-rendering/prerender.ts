/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { readFile } from 'node:fs/promises';
import { extname, posix } from 'node:path';
import Piscina from 'piscina';
import { BuildOutputFile, BuildOutputFileType } from '../../tools/esbuild/bundler-context';
import { getESMLoaderArgs } from './esm-in-memory-loader/node-18-utils';
import type { RenderResult, ServerContext } from './render-page';
import type { RenderWorkerData } from './render-worker';
import type {
  RoutersExtractorWorkerResult,
  RoutesExtractorWorkerData,
} from './routes-extractor-worker';

interface PrerenderOptions {
  routesFile?: string;
  discoverRoutes?: boolean;
}

interface AppShellOptions {
  route?: string;
}

export async function prerenderPages(
  workspaceRoot: string,
  appShellOptions: AppShellOptions = {},
  prerenderOptions: PrerenderOptions = {},
  outputFiles: Readonly<BuildOutputFile[]>,
  document: string,
  inlineCriticalCss?: boolean,
  maxThreads = 1,
  verbose = false,
): Promise<{
  output: Record<string, string>;
  warnings: string[];
  errors: string[];
}> {
  const output: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  const outputFilesForWorker: Record<string, string> = {};

  for (const { text, path, type } of outputFiles) {
    if (
      type === BuildOutputFileType.Server || // Contains the server runnable application code
      (type === BuildOutputFileType.Browser && extname(path) === '.css') // Global styles for critical CSS inlining.
    ) {
      outputFilesForWorker[path] = text;
    }
  }

  const { routes: allRoutes, warnings: routesWarnings } = await getAllRoutes(
    workspaceRoot,
    outputFilesForWorker,
    document,
    appShellOptions,
    prerenderOptions,
    verbose,
  );

  if (routesWarnings?.length) {
    warnings.push(...routesWarnings);
  }

  if (allRoutes.size < 1) {
    return {
      errors,
      warnings,
      output,
    };
  }

  const renderWorker = new Piscina({
    filename: require.resolve('./render-worker'),
    maxThreads: Math.min(allRoutes.size, maxThreads),
    workerData: {
      workspaceRoot,
      outputFiles: outputFilesForWorker,
      inlineCriticalCss,
      document,
    } as RenderWorkerData,
    execArgv: getESMLoaderArgs(),
  });

  try {
    const renderingPromises: Promise<void>[] = [];
    const appShellRoute = appShellOptions.route && removeLeadingSlash(appShellOptions.route);

    for (const route of allRoutes) {
      const isAppShellRoute = appShellRoute === route;
      const serverContext: ServerContext = isAppShellRoute ? 'app-shell' : 'ssg';

      const render: Promise<RenderResult> = renderWorker.run({ route, serverContext });
      const renderResult: Promise<void> = render.then(({ content, warnings, errors }) => {
        if (content !== undefined) {
          const outPath = isAppShellRoute ? 'index.html' : posix.join(route, 'index.html');
          output[outPath] = content;
        }

        if (warnings) {
          warnings.push(...warnings);
        }

        if (errors) {
          errors.push(...errors);
        }
      });

      renderingPromises.push(renderResult);
    }

    await Promise.all(renderingPromises);
  } finally {
    void renderWorker.destroy();
  }

  return {
    errors,
    warnings,
    output,
  };
}

class RoutesSet extends Set<string> {
  override add(value: string): this {
    return super.add(removeLeadingSlash(value));
  }
}

async function getAllRoutes(
  workspaceRoot: string,
  outputFilesForWorker: Record<string, string>,
  document: string,
  appShellOptions: AppShellOptions,
  prerenderOptions: PrerenderOptions,
  verbose: boolean,
): Promise<{ routes: Set<string>; warnings?: string[] }> {
  const { routesFile, discoverRoutes } = prerenderOptions;
  const routes = new RoutesSet();

  const { route: appShellRoute } = appShellOptions;
  if (appShellRoute !== undefined) {
    routes.add(appShellRoute);
  }

  if (routesFile) {
    const routesFromFile = (await readFile(routesFile, 'utf8')).split(/\r?\n/);
    for (const route of routesFromFile) {
      routes.add(route.trim());
    }
  }

  if (!discoverRoutes) {
    return { routes };
  }

  const renderWorker = new Piscina({
    filename: require.resolve('./routes-extractor-worker'),
    maxThreads: 1,
    workerData: {
      workspaceRoot,
      outputFiles: outputFilesForWorker,
      document,
      verbose,
    } as RoutesExtractorWorkerData,
    execArgv: getESMLoaderArgs(),
  });

  const { routes: extractedRoutes, warnings }: RoutersExtractorWorkerResult = await renderWorker
    .run({})
    .finally(() => void renderWorker.destroy());

  for (const route of extractedRoutes) {
    routes.add(route);
  }

  return { routes, warnings };
}

function removeLeadingSlash(value: string): string {
  return value.charAt(0) === '/' ? value.slice(1) : value;
}
