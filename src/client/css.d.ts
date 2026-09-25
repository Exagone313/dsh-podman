// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The client build inlines imported stylesheets as strings (an esbuild `text`
// loader, see scripts/build-client-bundle.mjs), so a CSS import is a default
// string export and not a stylesheet side effect.
declare module "*.css" {
  const css: string;
  export default css;
}
