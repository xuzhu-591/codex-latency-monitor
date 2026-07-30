import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "plugins", "codex-latency.10s.js");
const targetDirectory = process.env.CODEX_LATENCY_SWIFTBAR_PLUGIN_DIRECTORY
  ? resolve(process.env.CODEX_LATENCY_SWIFTBAR_PLUGIN_DIRECTORY)
  : resolve(homedir(), "Library", "Application Support", "SwiftBar", "Plugins");
const target = resolve(targetDirectory, "codex-latency.10s.sh");
const legacyTarget = resolve(targetDirectory, "codex-latency.10s.js");
const launcherMarker = "# codex-latency-monitor SwiftBar launcher";

mkdirSync(targetDirectory, { recursive: true });

assertReplaceableLauncher();
const removeLegacyTarget = isLegacyTargetInstalled();
const temporaryTarget = `${target}.tmp-${process.pid}`;
writeFileSync(temporaryTarget, buildLauncher(), { mode: 0o755 });
chmodSync(temporaryTarget, 0o755);
renameSync(temporaryTarget, target);
if (removeLegacyTarget) {
  unlinkSync(legacyTarget);
}
process.stdout.write(`已安装 SwiftBar 插件：${target}\n`);

function assertReplaceableLauncher() {
  try {
    const existing = lstatSync(target);
    if (!existing.isFile() || !readFileSync(target, "utf8").includes(`${launcherMarker}\n`)) {
      throw new Error(`不会覆盖已有插件：${target}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isLegacyTargetInstalled() {
  try {
    const existing = lstatSync(legacyTarget);
    if (existing.isSymbolicLink() && realpathSync(legacyTarget) === source) {
      return true;
    }
    throw new Error(`不会覆盖已有插件：${legacyTarget}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildLauncher() {
  return `#!/bin/sh
${launcherMarker}
node_path=${quoteForPosixShell(process.execPath)}
plugin_path=${quoteForPosixShell(source)}
export CODEX_LATENCY_SWIFTBAR_LAUNCHER="$0"

if [ ! -x "$node_path" ]; then
  printf '%s\\n' 'Codex · Error | color=red'
  printf '%s\\n' '---'
  printf '%s\\n' 'Node.js 运行时不可用，请重新运行 npm run install:swiftbar | disabled=true'
  exit 0
fi

exec "$node_path" "$plugin_path" "$@"
`;
}

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}
