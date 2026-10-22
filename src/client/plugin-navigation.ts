// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The one way this client half reaches its own page on the harness's Plugins
// panel. The service is injected by the plugin-manager client UI, and its face
// is a plain callback holder rather than a React value: the sidebar body
// receives its business face from `controller.inject()` and cannot read the
// plugin context, so the apply closure records the navigation service here.
//
// The service is optional: the plugin-manager client UI provides it from a
// lazily mounted slot, so it can be missing entirely (a shell without that UI)
// or go away while this plugin keeps running. The pane reads availability from
// this module — never from the plugin context — and hides its settings action
// while no face is adopted.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";

// The plugin's installed package name. The Plugins page keys
// `plugins.bundle.config` by the bundle package name, so it must match
// package.json's `name`.
export const PLUGIN_PACKAGE = "@exagone313/dsh-podman";

/** The plugin-navigation service's face, as this client half uses it. */
export interface PluginNavigation {
  /**
   * Open one bundle's page on the Plugins panel.
   * @param packageName - npm package name of the bundle.
   */
  openBundle(packageName: string): void;
}

// The service the apply closure adopted, or undefined before it mounts (and
// after a plugin reload). A missing service makes the button a no-op rather
// than a failed click.
let navigation: PluginNavigation | undefined;

// Render seats observing adoption, so the pane's settings action appears as
// soon as the face does and disappears with it.
const listeners = new Set<() => void>();

/**
 * Record the plugin-navigation service (or clear it).
 * @param service - the live service, or undefined on teardown.
 */
export function setPluginNavigation(
  service: PluginNavigation | undefined,
): void {
  if (navigation === service) return;
  navigation = service;
  for (const listener of listeners) listener();
}

/** Whether a plugin-navigation face is currently adopted. */
export function pluginSettingsAvailable(): boolean {
  return navigation !== undefined;
}

/**
 * Observe whether the navigation face is available.
 * @param listener - invoked when the face is adopted or cleared.
 * @returns the disposer removing it.
 */
export function subscribePluginSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open this plugin's page on the Plugins panel, when the client UI is served. */
export function openPluginSettings(): void {
  navigation?.openBundle(PLUGIN_PACKAGE);
}
