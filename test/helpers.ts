import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTestEnvironment(prefix: string): Promise<{ root: string; sessions: string; data: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const sessions = join(root, "sessions", "2026", "07", "01");
  const data = join(root, "data");
  const log = join(sessions, "rollout-fixture.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(data, { recursive: true });
  return { root, sessions: join(root, "sessions"), data, log };
}

export function event(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

export function completedTurnLines(turnId = "turn-complete"): string[] {
  return [
    event("2026-07-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: turnId }),
    event("2026-07-01T00:00:02.000Z", "event_msg", { type: "agent_reasoning" }),
    event("2026-07-01T00:00:03.000Z", "event_msg", { type: "token_count", info: { last_token_usage: { output_tokens: 20 } } }),
    event("2026-07-01T00:00:10.000Z", "event_msg", { type: "task_complete", turn_id: turnId, duration_ms: 10_000, time_to_first_token_ms: 2_000 }),
  ];
}

export async function writeLines(path: string, lines: string[]): Promise<void> {
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

export async function appendRaw(path: string, content: string): Promise<void> {
  await appendFile(path, content, "utf8");
}
