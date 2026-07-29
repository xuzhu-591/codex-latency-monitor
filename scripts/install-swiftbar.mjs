import { lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "plugins", "codex-latency.10s.js");
const targetDirectory = resolve(homedir(), "Library", "Application Support", "SwiftBar", "Plugins");
const target = resolve(targetDirectory, "codex-latency.10s.js");
mkdirSync(targetDirectory, { recursive: true });
try {
  const existing = lstatSync(target);
  if (!existing.isSymbolicLink() || realpathSync(target) !== source) {
    throw new Error(`不会覆盖已有插件：${target}`);
  }
  unlinkSync(target);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    // 目标不存在时直接创建链接。
  } else {
    throw error;
  }
}
symlinkSync(source, target);
process.stdout.write(`已安装 SwiftBar 插件：${target}\n`);
