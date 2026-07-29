#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const entrypoint = pathToFileURL(resolve(import.meta.dirname, "../dist/src/cli/main.js")).href;
const { runCli } = await import(entrypoint);

try {
  process.stdout.write(await runCli(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-latency: ${message}\n`);
  process.exitCode = 1;
}
