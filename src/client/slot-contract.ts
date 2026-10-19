// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Slot types the client half consumes: the generic slot registry, the tool
// view contract, and the Plugins page's bundle-configuration slot this plugin
// registers its card into.
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    // The frame-wide overlay layer owned by the harness layout. The plugin's
    // client bundle does not depend on ui-layout, so it declares the seat it
    // contributes its command toast to (the real declaration is identical).
    "shell.overlay": { kind: "list"; scope: "root" };
  }
}
