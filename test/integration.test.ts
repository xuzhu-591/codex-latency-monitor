import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStatus } from "../src/cli/status.js";
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
