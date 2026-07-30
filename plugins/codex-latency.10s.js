#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pluginPath = realpathSync(new URL(import.meta.url));
const launcherPath = process.env.CODEX_LATENCY_SWIFTBAR_LAUNCHER ?? pluginPath;
const root = resolve(dirname(pluginPath), "..");
const command = resolve(root, "bin/codex-latency.mjs");
const action = process.argv[2] ?? "status";

try {
  if (action === "report") {
    execFileSync(process.execPath, [command, "report", "--open"], { stdio: "ignore" });
    process.stdout.write("Codex · 报告已打开 | refresh=true\n");
  } else {
    const output = execFileSync(process.execPath, [command, "status", "--format", "swiftbar"], { encoding: "utf8" });
    process.stdout.write(output);
    process.stdout.write(`---\n打开本地报告 | bash=${launcherPath} param1=report terminal=false\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/[\r\n|]/g, " ") : "未知错误";
  process.stdout.write(`Codex · Error | color=red\n---\n${message} | disabled=true\n`);
}
