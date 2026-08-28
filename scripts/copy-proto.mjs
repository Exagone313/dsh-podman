// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Copy the proto sources next to the compiled JS so the gRPC runtime
// (proto-loader.loadSync) can load them from the packaged dist/.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
cpSync(join(root, "proto"), join(root, "dist", "grpc", "proto"), {
  recursive: true,
});
console.log("copied proto/ -> dist/grpc/proto/");
