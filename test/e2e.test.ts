import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { completedTurnLines, createTestEnvironment, event, writeLines } from "./helpers.js";

const root = process.cwd();
const cli = resolve(root, "bin", "codex-latency.mjs");
const plugin = resolve(root, "plugins", "codex-latency.10s.js");

test("E2E：从 JSONL 到 CLI、SwiftBar 文本和本地报告", async () => {
  const environment = await createTestEnvironment("codex-latency-e2e");
  const privateText = "e2e-private-message";
  await writeLines(environment.log, [
    ...completedTurnLines("e2e-turn", Date.now() - 20_000),
    event("2026-07-01T00:01:00.000Z", "event_msg", { type: "agent_message", message: privateText }),
  ]);
  const childEnvironment = {
    ...process.env,
    CODEX_LATENCY_SESSIONS_DIR: environment.sessions,
    CODEX_LATENCY_DATA_DIR: environment.data,
    CODEX_LATENCY_NO_OPEN: "1",
  };

  const status = run([cli, "status", "--format", "json"], childEnvironment);
  const parsed = JSON.parse(status.stdout) as { latest: { ttftMs: number; tps: number; sessionId: string } };
  assert.equal(parsed.latest.ttftMs, 2_000);
  assert.equal(parsed.latest.tps, 2.5);

  const swiftbar = run([plugin], childEnvironment);
  assert.match(swiftbar.stdout, /^Codex · TTFT 2\.0s · TPS 2\.5\/s/m);
  assert.match(swiftbar.stdout, /今天 · 1 轮 \| disabled=true/);
  assert.match(swiftbar.stdout, /TTFT p50 2\.0s · p95 2\.0s/);
  assert.match(swiftbar.stdout, /TPS p50 2\.5\/s · p95 2\.5\/s/);
  assert.doesNotMatch(swiftbar.stdout, /N\/A/);
  assert.match(swiftbar.stdout, /打开本地报告/);
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
  assert.match(html, new RegExp(parsed.latest.sessionId));
  assert.doesNotMatch(html, new RegExp(privateText));
});

function run(argumentsList: string[], environment: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, argumentsList, { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
