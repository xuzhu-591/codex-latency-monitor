import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { buildStatus, formatSwiftBar } from "../src/cli/status.js";
import { refreshClaudeSessions, refreshSessions } from "../src/ingest/ingest.js";
import { writeReport } from "../src/report/report.js";
import { MonitorDatabase, defaultDatabasePath } from "../src/storage/database.js";
import { appendRaw, claudeEvent, completedTurnLines, createTestEnvironment, event, writeLines } from "./helpers.js";

test("增量导入、部分行重试和重复刷新不会重复统计", async () => {
  const environment = await createTestEnvironment("codex-latency-integration");
  await writeLines(environment.log, completedTurnLines());
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  try {
    const first = await refreshSessions(database, environment.sessions);
    assert.equal(first.importedEvents, 4);
    assert.equal(buildStatus(database, first.importedEvents, []).recent.length, 1);

    const second = await refreshSessions(database, environment.sessions);
    assert.equal(second.importedEvents, 0);
    assert.equal(buildStatus(database, second.importedEvents, []).recent.length, 1);

    const nextTurn = completedTurnLines("turn-partial");
    const partialFirstLine = nextTurn[0].slice(0, -10);
    await appendRaw(environment.log, partialFirstLine);
    assert.equal((await refreshSessions(database, environment.sessions)).importedEvents, 0);
    await appendRaw(environment.log, `${nextTurn[0].slice(-10)}\n${nextTurn.slice(1).join("\n")}\n`);
    assert.equal((await refreshSessions(database, environment.sessions)).importedEvents, 4);
    assert.equal(buildStatus(database, 0, []).recent.length, 2);
  } finally {
    database.close();
  }
});

test("工具 Turn 的 TPS 包含全部等待，报告不泄露消息正文", async () => {
  const environment = await createTestEnvironment("codex-latency-privacy");
  const secret = "fixture-secret-must-not-persist";
  await writeLines(environment.log, [
    event("2026-07-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "tool-turn" }),
    event("2026-07-01T00:00:01.000Z", "event_msg", { type: "agent_message", message: secret }),
    event("2026-07-01T00:00:02.000Z", "response_item", { type: "custom_tool_call", internal_chat_message_metadata_passthrough: { turn_id: "tool-turn" }, input: secret }),
    event("2026-07-01T00:00:05.000Z", "event_msg", { type: "token_count", info: { last_token_usage: { output_tokens: 20 } } }),
    event("2026-07-01T00:00:11.000Z", "event_msg", { type: "task_complete", turn_id: "tool-turn", duration_ms: 11_000, time_to_first_token_ms: 1_000 }),
  ]);
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  try {
    await refreshSessions(database, environment.sessions);
    const report = buildStatus(database, 0, []);
    assert.equal(report.latest?.hasTool, true);
    assert.equal(report.latest?.tps, 20 / 11);
    const path = writeReport(environment.data, report);
    assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(secret));
  } finally {
    database.close();
  }
});

test("趋势图仅包含昨天零点至当前的完成 Turn", async () => {
  const environment = await createTestEnvironment("codex-latency-trend-period");
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  const now = new Date(2026, 6, 2, 12, 0, 0).getTime();
  try {
    database.completeTurn(turn("older", new Date(2026, 5, 30, 23, 59, 59).getTime()));
    database.completeTurn(turn("yesterday", new Date(2026, 6, 1, 0, 0, 0).getTime()));
    database.completeTurn(turn("aborted", new Date(2026, 6, 1, 6, 0, 0).getTime(), "aborted"));
    database.completeTurn(turn("today", new Date(2026, 6, 2, 11, 59, 59).getTime()));
    database.completeTurn(turn("future", new Date(2026, 6, 3, 0, 0, 0).getTime()));

    const report = buildStatus(database, 0, [], now);
    assert.deepEqual(report.trend.map((record) => record.turnId), ["yesterday", "today"]);
  } finally {
    database.close();
  }
});

test("状态栏跳过最近的中止 Turn，展示上一条正常完成结果", async () => {
  const environment = await createTestEnvironment("codex-latency-latest-completed");
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  try {
    const now = Date.now();
    database.completeTurn(turn("completed-turn", now - 1_000));
    database.completeTurn(turn("aborted-turn", now, "aborted"));

    const report = buildStatus(database, 0, [], now);
    assert.equal(report.recent[0]?.turnId, "aborted-turn");
    assert.equal(report.latest?.turnId, "completed-turn");
    assert.match(formatSwiftBar(report), /^Codex · TTFT 1\.0s · TPS 2\.5\/s/m);
  } finally {
    database.close();
  }
});

test("菜单栏按来源展示当天汇总与 N/A 数量", () => {
  const text = formatSwiftBar({
    latest: null,
    recent: [],
    trend: [],
    active: [],
    summary: {
      completedCount: 3,
      unavailableCount: 1,
      p50TtftMs: 2_000,
      p95TtftMs: 4_000,
      p50Tps: 10,
      p5Tps: 5,
    },
    providerSummaries: {
      codex: {
        completedCount: 2,
        unavailableCount: 1,
        p50TtftMs: 2_000,
        p95TtftMs: 4_000,
        p50Tps: 10,
        p5Tps: 5,
      },
      claude: {
        completedCount: 1,
        unavailableCount: 0,
        p50TtftMs: 3_000,
        p95TtftMs: 3_000,
        p50Tps: 8,
        p5Tps: 8,
      },
    },
    importedEvents: 0,
    diagnostics: [],
  });

  assert.match(text, /今天 · 3 轮/);
  assert.match(text, /Codex · 2 轮 · N\/A 1/);
  assert.match(text, /TTFT p50 2\.0s · p95 4\.0s/);
  assert.match(text, /TPS p50 10\.0\/s · p5 5\.0\/s/);
  assert.match(text, /Claude · 1 轮/);
  assert.match(text, /TTFT p50 3\.0s · p95 3\.0s/);
  assert.match(text, /TPS p50 8\.0\/s · p5 8\.0\/s/);
});

test("TPS 汇总使用低分位 p5 表示慢输出", async () => {
  const environment = await createTestEnvironment("codex-latency-tps-p5");
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  const now = new Date(2026, 6, 2, 12, 0, 0).getTime();
  try {
    for (let index = 1; index <= 10; index += 1) {
      database.completeTurn(turn(`tps-${index}`, now - index * 1_000, "completed", index * 10));
    }

    const report = buildStatus(database, 0, [], now);
    assert.equal(report.summary.p50Tps, 55);
    assert.equal(report.summary.p5Tps, 14.5);
  } finally {
    database.close();
  }
});

test("报告使用真实会话 ID，并将旧路径 hash 迁移为会话 ID", async () => {
  const environment = await createTestEnvironment("codex-latency-session-id");
  const databasePath = defaultDatabasePath(environment.data);
  const sourcePath = "/tmp/rollout-2026-07-01T00-00-00-019fa939-c7cf-7842-97a0-72b6c0072806.jsonl";
  const sessionId = "019fa939-c7cf-7842-97a0-72b6c0072806";
  const legacyKey = createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
  const initial = new MonitorDatabase(databasePath);
  initial.close();

  const legacy = new Database(databasePath);
  legacy.prepare("INSERT INTO source_files (source_path, offset_bytes, updated_at_ms) VALUES (?, ?, ?)")
    .run(sourcePath, 0, 0);
  legacy.prepare(`
    INSERT INTO turns (
      turn_id, session_key, started_at_ms, completed_at_ms, duration_ms,
      ttft_ms, output_tokens, tps, has_tool, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-turn", legacyKey, 1_000, 2_000, 1_000, 100, 10, 10, 0, "completed");
  legacy.close();

  const migrated = new MonitorDatabase(databasePath);
  try {
    assert.equal(migrated.listRecent(1)[0]?.sessionId, sessionId);
    migrated.startTurn("new-turn", sourcePath, 3_000);
    assert.equal(migrated.getPending("new-turn")?.sessionId, sessionId);
  } finally {
    migrated.close();
  }
});

test("报告展示最近 50 轮，SwiftBar 仍只展示最近 10 轮", async () => {
  const environment = await createTestEnvironment("codex-latency-report-limit");
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  const now = Date.now();
  try {
    for (let index = 0; index < 55; index += 1) {
      database.completeTurn(turn(`turn-${index}`, now - index * 1_000));
    }

    const report = buildStatus(database, 0, [], now);
    assert.equal(report.recent.length, 50);
    const reportPath = writeReport(environment.data, report);
    assert.match(await readFile(reportPath, "utf8"), /最近 50 轮/);

    const menuTurns = formatSwiftBar(report)
      .split("最近 10 轮 | disabled=true\n")[1]
      .split("---")[0]
      .trim()
      .split("\n");
    assert.equal(menuTurns.length, 10);
  } finally {
    database.close();
  }
});

test("Claude 主会话按用户输入重建 Turn，排除工具结果、子代理与边车事件", async () => {
  const environment = await createTestEnvironment("codex-latency-claude");
  const sessionId = "18613844-dc4d-4728-862f-b5d1535c5b08";
  const secret = "claude-fixture-secret-must-not-persist";
  const startedAtMs = Date.parse("2026-07-01T00:00:00.000Z");
  await writeLines(environment.claudeLog, [
    claudeEvent(new Date(startedAtMs).toISOString(), "user", {
      sessionId,
      uuid: "user-event-1",
      message: { role: "user", content: secret },
    }),
    claudeEvent(new Date(startedAtMs + 2_000).toISOString(), "assistant", {
      sessionId,
      uuid: "assistant-thinking-1",
      message: { role: "assistant", id: "thinking-1", content: [{ type: "thinking" }], usage: { output_tokens: 0 } },
    }),
    claudeEvent(new Date(startedAtMs + 4_000).toISOString(), "assistant", {
      sessionId,
      uuid: "assistant-tool-1",
      message: { role: "assistant", id: "tool-1", content: [{ type: "tool_use" }], usage: { output_tokens: 3 }, stop_reason: "tool_use" },
    }),
    claudeEvent(new Date(startedAtMs + 5_000).toISOString(), "assistant", {
      sessionId,
      uuid: "assistant-tool-2",
      message: { role: "assistant", id: "tool-1", content: [{ type: "tool_use" }], usage: { output_tokens: 5 }, stop_reason: "tool_use" },
    }),
    claudeEvent(new Date(startedAtMs + 6_000).toISOString(), "user", {
      sessionId,
      uuid: "tool-result-event",
      message: { role: "user", content: [{ type: "tool_result", content: secret }] },
    }),
    claudeEvent(new Date(startedAtMs + 10_000).toISOString(), "assistant", {
      sessionId,
      uuid: "assistant-answer-1",
      message: { role: "assistant", id: "answer-1", content: [{ type: "text" }], usage: { output_tokens: 20 }, stop_reason: "end_turn" },
    }),
    claudeEvent(new Date(startedAtMs + 11_000).toISOString(), "user", {
      sessionId,
      uuid: "sidechain-user",
      isSidechain: true,
      message: { role: "user", content: "不应计入" },
    }),
  ]);
  const subagentDirectory = join(environment.claudeProjects, "-tmp-project", "subagents");
  await mkdir(subagentDirectory, { recursive: true });
  await writeLines(join(subagentDirectory, "subagent.jsonl"), [
    claudeEvent(new Date(startedAtMs).toISOString(), "user", {
      sessionId: "subagent-session",
      uuid: "subagent-user",
      message: { role: "user", content: "不应计入" },
    }),
  ]);

  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  try {
    const result = await refreshClaudeSessions(database, environment.claudeProjects);
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.importedEvents, 7);
    const report = buildStatus(database, 0, [], startedAtMs + 20_000);
    assert.equal(report.recent.length, 1);
    assert.deepEqual(report.latest, {
      turnId: `claude:${sessionId}:user-event-1`,
      sessionId,
      provider: "claude",
      startedAtMs,
      completedAtMs: startedAtMs + 10_000,
      durationMs: 10_000,
      ttftMs: 2_000,
      outputTokens: 25,
      tps: 2.5,
      hasTool: true,
      status: "completed",
    });
    const reportPath = writeReport(environment.data, report);
    const html = await readFile(reportPath, "utf8");
    assert.match(html, /◆ Claude/);
    assert.doesNotMatch(html, new RegExp(secret));
  } finally {
    database.close();
  }
});

test("未安装 Claude Code 时跳过其日志目录，不影响刷新", async () => {
  const environment = await createTestEnvironment("codex-latency-claude-missing");
  const database = new MonitorDatabase(defaultDatabasePath(environment.data));
  try {
    const result = await refreshClaudeSessions(database, join(environment.root, "no-claude-projects"));
    assert.deepEqual(result, { importedEvents: 0, diagnostics: [] });
  } finally {
    database.close();
  }
});

test("已有历史 Turn 在升级后重新计算 TPS", async () => {
  const environment = await createTestEnvironment("codex-latency-tps-migration");
  const databasePath = defaultDatabasePath(environment.data);
  const initial = new MonitorDatabase(databasePath);
  initial.close();

  const legacy = new Database(databasePath);
  legacy.prepare("DELETE FROM monitor_metadata WHERE key = 'metric_definition'").run();
  legacy.prepare(`
    INSERT INTO turns (
      turn_id, session_key, started_at_ms, completed_at_ms, duration_ms,
      ttft_ms, output_tokens, tps, has_tool, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("old-tps-turn", "test-session", 0, 10_000, 10_000, 2_000, 20, 2.5, 0, "completed");
  legacy.close();

  const migrated = new MonitorDatabase(databasePath);
  try {
    assert.equal(migrated.listRecent(1)[0]?.tps, 2);
  } finally {
    migrated.close();
  }
});

function turn(
  turnId: string,
  completedAtMs: number,
  status: "completed" | "aborted" = "completed",
  tps = 2.5,
) {
  return {
    turnId,
    sessionId: "test-session",
    provider: "codex" as const,
    startedAtMs: completedAtMs - 5_000,
    completedAtMs,
    durationMs: 5_000,
    ttftMs: 1_000,
    outputTokens: 10,
    tps,
    hasTool: false,
    status,
  };
}
