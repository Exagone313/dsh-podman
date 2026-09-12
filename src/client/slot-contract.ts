// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "settings.plugin.item": {
      kind: "keyed";
      scope: "root";
      owner: { children?: never };
    };
  }
}
