// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Build the browser client half into the format the dsh host serves: a single
// classic script that registers a closure factory via
// `window.__ModuleLoader__.load({ id, factory })`. Module-table rows (react,
// the shared dsh client services) stay as `require()` calls answered by the
// loader; everything else is inlined.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ID = "@exagone313/dsh-podman";

const EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
];

await build({
  entryPoints: [join(root, "src/client/index.ts")],
  outfile: join(root, "dist/client/index.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  external: EXTERNALS,
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n`
      + "var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: "\nreturn module.exports; } });",
  },
  logLevel: "info",
});
console.log("built client bundle -> dist/client/index.js");
