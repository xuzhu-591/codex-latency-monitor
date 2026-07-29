import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import test from "node:test";
import { buildStatus, formatSwiftBar } from "../src/cli/status.js";
import { refreshSessions } from "../src/ingest/ingest.js";
import { writeReport } from "../src/report/report.js";
import { MonitorDatabase, defaultDatabasePath } from "../src/storage/database.js";
import { appendRaw, completedTurnLines, createTestEnvironment, event, writeLines } from "./helpers.js";

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

test("工具 Turn 保留等待时间，报告不泄露消息正文", async () => {
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
    assert.equal(report.latest?.tps, 2);
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

test("菜单栏仅在存在不可计算 Turn 时显示 N/A 数量", () => {
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
      p95Tps: 20,
    },
    importedEvents: 0,
    diagnostics: [],
  });

  assert.match(text, /今天 · 3 轮 · N\/A 1/);
  assert.match(text, /TTFT p50 2\.0s · p95 4\.0s/);
  assert.match(text, /TPS p50 10\.0\/s · p95 20\.0\/s/);
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

function turn(turnId: string, completedAtMs: number, status: "completed" | "aborted" = "completed") {
  return {
    turnId,
    sessionId: "test-session",
    startedAtMs: completedAtMs - 5_000,
    completedAtMs,
    durationMs: 5_000,
    ttftMs: 1_000,
    outputTokens: 10,
    tps: 2.5,
    hasTool: false,
    status,
  };
}
