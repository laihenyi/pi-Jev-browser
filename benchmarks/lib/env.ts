import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * This module must be evaluated before anything imports src/config.ts, because
 * config.ts resolves PI_JEV_BROWSER_CONFIG once at module load. Importing this first
 * keeps the benchmark from reading (and acting on) the user's real config.
 */
export const workingDir = mkdtempSync(join(tmpdir(), "pi-jev-browser-bench-"));
export const configPath = join(workingDir, "config.json");
process.env.PI_JEV_BROWSER_CONFIG = configPath;
writeFileSync(configPath, "{}");
