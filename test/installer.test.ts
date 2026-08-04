import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const installer = resolve(root, "scripts", "install-swiftbar.mjs");
const plugin = resolve(root, "plugins", "codex-latency.10s.js");

test("安装器生成不依赖 PATH 的 SwiftBar 启动器，并迁移旧版链接", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-latency-swiftbar-"));
  const legacyTarget = join(directory, "codex-latency.10s.js");
  const target = join(directory, "codex-latency.10s.sh");
  await symlink(plugin, legacyTarget);
  await mkdir(join(directory, "sessions"));

  runInstaller(directory);
  assert.equal((await lstat(target)).isFile(), true);
  await assert.rejects(lstat(legacyTarget), { code: "ENOENT" });
  const launcher = await readFile(target, "utf8");
  assert.match(launcher, /codex-latency-monitor SwiftBar launcher/);
  assert.match(launcher, new RegExp(escapeForRegex(process.execPath)));

  const execution = spawnSync(target, [], {
    encoding: "utf8",
    env: {
      HOME: directory,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      CODEX_LATENCY_SESSIONS_DIR: join(directory, "sessions"),
      CODEX_LATENCY_CLAUDE_SESSIONS_DIR: join(directory, "claude"),
      CODEX_LATENCY_DATA_DIR: join(directory, "data"),
      CODEX_LATENCY_NO_OPEN: "1",
    },
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /^cx · 等待完成 Turn/m);
  assert.match(execution.stdout, new RegExp(`bash=${escapeForRegex(target)} param1=report`));

  runInstaller(directory);
});

test("安装器不会覆盖同名的非本工具插件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-latency-swiftbar-"));
  const target = join(directory, "codex-latency.10s.sh");
  await writeFile(target, "#!/bin/sh\necho other-plugin\n");

  const result = runInstaller(directory, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不会覆盖已有插件/);
  assert.equal(await readFile(target, "utf8"), "#!/bin/sh\necho other-plugin\n");
});

function runInstaller(directory: string, expectSuccess = true) {
  const result = spawnSync(process.execPath, [installer], {
    encoding: "utf8",
    env: { ...process.env, CODEX_LATENCY_SWIFTBAR_PLUGIN_DIRECTORY: directory },
  });
  if (expectSuccess) {
    assert.equal(result.status, 0, result.stderr);
  }
  return result;
}

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
