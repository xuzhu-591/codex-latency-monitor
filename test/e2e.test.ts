import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { completedClaudeTurnLines, completedTurnLines, createTestEnvironment, event, writeLines } from "./helpers.js";

const root = process.cwd();
const cli = resolve(root, "bin", "codex-latency.mjs");
const plugin = resolve(root, "plugins", "codex-latency.10s.js");

test("E2E：从 JSONL 到 CLI、SwiftBar 文本和本地报告", async () => {
  const environment = await createTestEnvironment("codex-latency-e2e");
  const privateText = "e2e-private-message";
  const now = Date.now();
  await writeLines(environment.log, [
    ...completedTurnLines("e2e-turn", now - 20_000),
    event("2026-07-01T00:01:00.000Z", "event_msg", { type: "agent_message", message: privateText }),
  ]);
  await writeLines(environment.claudeLog, completedClaudeTurnLines(undefined, now - 15_000));
  const childEnvironment = {
    ...process.env,
    CODEX_LATENCY_SESSIONS_DIR: environment.sessions,
    CODEX_LATENCY_CLAUDE_SESSIONS_DIR: environment.claudeProjects,
    CODEX_LATENCY_DATA_DIR: environment.data,
    CODEX_LATENCY_NO_OPEN: "1",
  };

  const status = run([cli, "status", "--format", "json"], childEnvironment);
  const parsed = JSON.parse(status.stdout) as { latest: { provider: string; model: string; ttftMs: number; tps: number; sessionId: string } };
  assert.equal(parsed.latest.provider, "claude");
  assert.equal(parsed.latest.ttftMs, 2_000);
  assert.equal(parsed.latest.tps, 1.2);
  assert.equal(parsed.latest.model, "claude-opus-4-8");

  const swiftbar = run([plugin], childEnvironment);
  assert.match(swiftbar.stdout, /^cc · claude-opus-4-8 · 2\.0s · 1\.2\/s$/m);
  assert.match(swiftbar.stdout, /cc · claude-opus-4-8 · 2\.0s · 1\.2\/s/);
  assert.match(swiftbar.stdout, /cx · gpt-5\.6-sol · 2\.0s · 2\.0\/s/);
  assert.match(swiftbar.stdout, /今天 · 2 轮 \| disabled=true/);
  assert.match(swiftbar.stdout, /cx · gpt-5\.6-sol · 1 轮/);
  assert.match(swiftbar.stdout, /cc · claude-opus-4-8 · 1 轮/);
  assert.match(swiftbar.stdout, /TPS p50 2\.0\/s · p5 2\.0\/s/);
  assert.match(swiftbar.stdout, /TPS p50 1\.2\/s · p5 1\.2\/s/);
  assert.doesNotMatch(swiftbar.stdout, /N\/A/);
  assert.match(swiftbar.stdout, /打开本地报告/);
  assert.doesNotMatch(swiftbar.stdout.split("\n---\n今天")[0], /TTFT|TPS/);
  assert.doesNotMatch(swiftbar.stdout, new RegExp(parsed.latest.sessionId));

  const report = run([cli, "report"], childEnvironment);
  const reportPath = report.stdout.trim();
  const html = await readFile(reportPath, "utf8");
  assert.match(html, /昨日及今日 TTFT 时序/);
  assert.match(html, /昨日及今日 TPS 时序/);
  assert.match(html, /<svg/);
  assert.match(html, /data-chart-tooltip/);
  assert.match(html, /data-chart-point/);
  assert.match(html, /data-metric="TTFT"/);
  assert.match(html, /data-value="2\.0s"/);
  assert.match(html, /pointerenter/);
  assert.match(html, /TPS p50 1\.2\/s · p5 1\.2\/s/);
  assert.match(html, /● cx/);
  assert.match(html, /◆ cc/);
  assert.match(html, /<th>模型<\/th>/);
  assert.match(html, /gpt-5\.6-sol/);
  assert.match(html, /claude-opus-4-8/);
  assert.match(html, new RegExp(parsed.latest.sessionId));
  assert.doesNotMatch(html, new RegExp(privateText));
});

function run(argumentsList: string[], environment: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, argumentsList, { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
