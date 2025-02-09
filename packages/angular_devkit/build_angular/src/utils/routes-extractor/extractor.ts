/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  ApplicationRef,
  Compiler,
  Injector,
  Type,
  createPlatformFactory,
  platformCore,
  ɵwhenStable as whenStable,
} from '@angular/core';
import {
  INITIAL_CONFIG,
  ɵINTERNAL_SERVER_PLATFORM_PROVIDERS as INTERNAL_SERVER_PLATFORM_PROVIDERS,
} from '@angular/platform-server';
import { Route, Router, ɵloadChildren as loadChildrenHelper } from '@angular/router';

interface RouterResult {
  route: string;
  success: boolean;
  redirect: boolean;
}

async function* getRoutesFromRouterConfig(
  routes: Route[],
  compiler: Compiler,
  parentInjector: Injector,
  parentRoute = '',
): AsyncIterableIterator<RouterResult> {
  for (const route of routes) {
    const { path, redirectTo, loadChildren, children } = route;
    if (path === undefined) {
      continue;
    }

    const currentRoutePath = buildRoutePath(parentRoute, path);

    if (redirectTo !== undefined) {
      // TODO: handle `redirectTo`.
      yield { route: currentRoutePath, success: false, redirect: true };
      continue;
    }

    if (/[:*]/.test(path)) {
      // TODO: handle parameterized routes population.
      yield { route: currentRoutePath, success: false, redirect: false };
      continue;
    }

    yield { route: currentRoutePath, success: true, redirect: false };

    if (children?.length) {
      yield* getRoutesFromRouterConfig(children, compiler, parentInjector, currentRoutePath);
    }

    if (loadChildren) {
      const loadedChildRoutes = await loadChildrenHelper(
        route,
        compiler,
        parentInjector,
      ).toPromise();

      if (loadedChildRoutes) {
        const { routes: childRoutes, injector = parentInjector } = loadedChildRoutes;
        yield* getRoutesFromRouterConfig(childRoutes, compiler, injector, currentRoutePath);
      }
    }
  }
}

export async function* extractRoutes(
  bootstrapAppFnOrModule: (() => Promise<ApplicationRef>) | Type<unknown>,
  document: string,
): AsyncIterableIterator<RouterResult> {
  const platformRef = createPlatformFactory(platformCore, 'server', [
    [
      {
        provide: INITIAL_CONFIG,
        useValue: { document, url: '' },
      },
    ],
    ...INTERNAL_SERVER_PLATFORM_PROVIDERS,
  ])();

  try {
    let applicationRef: ApplicationRef;
    if (isBootstrapFn(bootstrapAppFnOrModule)) {
      applicationRef = await bootstrapAppFnOrModule();
    } else {
      const moduleRef = await platformRef.bootstrapModule(bootstrapAppFnOrModule);
      applicationRef = moduleRef.injector.get(ApplicationRef);
    }

    // Wait until the application is stable.
    await whenStable(applicationRef);

    const injector = applicationRef.injector;
    const router = injector.get(Router);
    const compiler = injector.get(Compiler);

    // Extract all the routes from the config.
    yield* getRoutesFromRouterConfig(router.config, compiler, injector);
  } finally {
    platformRef.destroy();
  }
}

function isBootstrapFn(value: unknown): value is () => Promise<ApplicationRef> {
  // We can differentiate between a module and a bootstrap function by reading compiler-generated `ɵmod` static property:
  return typeof value === 'function' && !('ɵmod' in value);
}

function buildRoutePath(...routeParts: string[]): string {
  return routeParts.filter(Boolean).join('/');
}
