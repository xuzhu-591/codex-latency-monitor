import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTestEnvironment(prefix: string): Promise<{
  root: string;
  sessions: string;
  data: string;
  log: string;
  claudeProjects: string;
  claudeLog: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const sessions = join(root, "sessions", "2026", "07", "01");
  const data = join(root, "data");
  const log = join(sessions, "rollout-2026-07-01T00-00-00-019fa939-c7cf-7842-97a0-72b6c0072806.jsonl");
  const claudeProjects = join(root, "claude", "projects");
  const claudeLog = join(claudeProjects, "-tmp-project", "18613844-dc4d-4728-862f-b5d1535c5b08.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(join(claudeProjects, "-tmp-project"), { recursive: true });
  return { root, sessions: join(root, "sessions"), data, log, claudeProjects, claudeLog };
}

export function event(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

export function completedTurnLines(
  turnId = "turn-complete",
  startedAtMs = Date.parse("2026-07-01T00:00:00.000Z"),
  model = "gpt-5.6-sol",
): string[] {
  return [
    event(new Date(startedAtMs).toISOString(), "turn_context", { model }),
    event(new Date(startedAtMs).toISOString(), "event_msg", { type: "task_started", turn_id: turnId }),
    event(new Date(startedAtMs + 2_000).toISOString(), "event_msg", { type: "agent_reasoning" }),
    event(new Date(startedAtMs + 3_000).toISOString(), "event_msg", { type: "token_count", info: { last_token_usage: { output_tokens: 20 } } }),
    event(new Date(startedAtMs + 10_000).toISOString(), "event_msg", { type: "task_complete", turn_id: turnId, duration_ms: 10_000, time_to_first_token_ms: 2_000 }),
  ];
}

export function completedClaudeTurnLines(
  sessionId = "18613844-dc4d-4728-862f-b5d1535c5b08",
  startedAtMs = Date.parse("2026-07-01T00:00:00.000Z"),
): string[] {
  return [
    claudeEvent(new Date(startedAtMs).toISOString(), "user", {
      sessionId,
      uuid: "user-event-1",
      message: { role: "user", content: "脱敏用户问题" },
    }),
    claudeEvent(new Date(startedAtMs + 2_000).toISOString(), "assistant", {
      sessionId,
      uuid: "assistant-thinking-1",
      message: { role: "assistant", id: "thinking-1", model: "claude-opus-4-8", content: [{ type: "thinking" }], usage: { output_tokens: 0 } },
    }),
    claudeEvent(new Date(startedAtMs + 10_000).toISOString(), "assistant", {
      sessionId,
      uuid: "assistant-answer-1",
      message: { role: "assistant", id: "answer-1", model: "claude-opus-4-8", content: [{ type: "text" }], usage: { output_tokens: 12 }, stop_reason: "end_turn" },
    }),
  ];
}

export function claudeEvent(timestamp: string, type: string, details: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, ...details });
}

export async function writeLines(path: string, lines: string[]): Promise<void> {
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

export async function appendRaw(path: string, content: string): Promise<void> {
  await appendFile(path, content, "utf8");
}
