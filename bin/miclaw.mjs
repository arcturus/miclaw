#!/usr/bin/env node

// Thin wrapper that loads tsx and runs src/cli.ts
// This avoids requiring tsx to be installed globally.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cli = join(root, "src", "cli.ts");

// Find tsx: local node_modules first, then global
const tsxBin = join(root, "node_modules", ".bin", "tsx");

try {
  execFileSync(tsxBin, [cli, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  // execFileSync throws on non-zero exit — just forward the exit code
  process.exit(err.status ?? 1);
}
