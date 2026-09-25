// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The plugin's real preferences (default image, sockets root, the default
// container environment, and the browser locale) live in the settings
// namespace; everything derived from the orchestrator travels over the card
// route (see card-route.ts).

import {
  CONTAINER_NS,
  type ContainerSettings,
  type ContainerSettingsScope,
  settingsSchema,
} from "./settings-schema.js";
import { type WorkspaceResolver } from "./workspace-binding.js";

/**
 * Register the plugin's preferences namespace and keep the resolver's config in
 * step with the user's choices.
 */
export function installContainerPreferences(
  ctx: any,
  resolver: WorkspaceResolver,
): void {
  ctx.inject(["settings"], (sctx: any) => {
    const scope = sctx.settings.register(CONTAINER_NS, settingsSchema, {
      base: {
        defaultImage: resolver.getConfig().defaultImage,
        socketsRoot: resolver.getConfig().socketsRoot,
        containerEnv: {},
      },
    }) as ContainerSettingsScope;
    scope.watch((next: ContainerSettings) => {
      resolver.setConfig({
        defaultImage: next.defaultImage,
        socketsRoot: next.socketsRoot,
        containerEnv: next.containerEnv,
      });
    });
  });
}
