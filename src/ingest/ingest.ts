import { createHash } from "node:crypto";
import { opendir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { calculateMetrics } from "../domain/metrics.js";
import type { TurnRecord } from "../domain/types.js";
import { MonitorDatabase } from "../storage/database.js";

interface LogEvent {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

export interface RefreshResult {
  importedEvents: number;
  diagnostics: string[];
}

export async function refreshSessions(
  database: MonitorDatabase,
  sessionsDirectory: string,
): Promise<RefreshResult> {
  const diagnostics: string[] = [];
  let importedEvents = 0;
  let paths: string[];

  try {
    paths = await findJsonlFiles(sessionsDirectory);
  } catch (error) {
    return {
      importedEvents,
      diagnostics: [`无法读取 Codex 会话目录：${toMessage(error)}`],
    };
  }

  for (const sourcePath of paths) {
    const result = await ingestFile(database, sourcePath);
    importedEvents += result.importedEvents;
    diagnostics.push(...result.diagnostics);
  }

  return { importedEvents, diagnostics };
}

async function ingestFile(database: MonitorDatabase, sourcePath: string): Promise<RefreshResult> {
  const diagnostics: string[] = [];
  const fileStat = await stat(sourcePath);
  const savedOffset = database.getOffset(sourcePath);
  const offset = fileStat.size < savedOffset ? 0 : savedOffset;
  const { text, nextOffset } = await readCompleteLines(sourcePath, offset);

  if (nextOffset === offset) {
    return { importedEvents: 0, diagnostics };
  }

  const events: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      diagnostics.push(`跳过无法解析的 JSONL 事件：${shortFileName(sourcePath)}`);
    }
  }

  database.transaction(() => {
    for (const event of events) {
      applyEvent(database, sourcePath, event);
    }
    database.saveOffset(sourcePath, nextOffset);
  });

  return { importedEvents: events.length, diagnostics };
}

function applyEvent(database: MonitorDatabase, sourcePath: string, event: LogEvent): void {
  const eventType = getEventType(event);
  const atMs = timestampMs(event.timestamp);
  if (!eventType || atMs === null) {
    return;
  }
  const turnId = getTurnId(event);

  if (eventType === "task_started" && turnId) {
    database.startTurn(turnId, sourcePath, atMs);
    return;
  }

  if (eventType === "agent_reasoning" || eventType === "agent_message") {
    database.markFirstAgentEvent(sourcePath, atMs);
    return;
  }

  if (eventType === "token_count") {
    database.addOutputTokens(sourcePath, numberAt(event.payload, ["info", "last_token_usage", "output_tokens"]) ?? 0);
    return;
  }

  if (eventType === "custom_tool_call") {
    database.markToolCall(sourcePath, turnId);
    return;
  }

  if ((eventType === "task_complete" || eventType === "turn_aborted") && turnId) {
    finalizeTurn(database, turnId, atMs, eventType === "task_complete", event.payload ?? {});
  }
}

function finalizeTurn(
  database: MonitorDatabase,
  turnId: string,
  completedAtMs: number,
  completed: boolean,
  payload: Record<string, unknown>,
): void {
  const pending = database.getPending(turnId);
  if (!pending) {
    return;
  }

  const durationMs = numberAt(payload, ["duration_ms"]) ?? Math.max(0, completedAtMs - pending.startedAtMs);
  const fallbackTtft = pending.firstAgentAtMs === null
    ? null
    : Math.max(0, pending.firstAgentAtMs - pending.startedAtMs);
  const ttftMs = completed ? numberAt(payload, ["time_to_first_token_ms"]) ?? fallbackTtft : null;
  const metric = calculateMetrics({
    durationMs,
    ttftMs,
    outputTokens: pending.outputTokens,
  });

  const record: TurnRecord = {
    turnId,
    sessionId: pending.sessionId,
    startedAtMs: pending.startedAtMs,
    completedAtMs,
    durationMs: metric.durationMs,
    ttftMs: metric.ttftMs,
    outputTokens: metric.outputTokens,
    tps: completed ? metric.tps : null,
    hasTool: pending.hasTool,
    status: completed ? "completed" : "aborted",
  };
  database.completeTurn(record);
}

async function readCompleteLines(sourcePath: string, offset: number): Promise<{ text: string; nextOffset: number }> {
  const handle = await open(sourcePath, "r");
  try {
    const fileStat = await handle.stat();
    const bytesToRead = fileStat.size - offset;
    if (bytesToRead <= 0) {
      return { text: "", nextOffset: offset };
    }
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, offset);
    const lastLineBreak = buffer.lastIndexOf(0x0a);
    if (lastLineBreak < 0) {
      return { text: "", nextOffset: offset };
    }
    return {
      text: buffer.subarray(0, lastLineBreak + 1).toString("utf8"),
      nextOffset: offset + lastLineBreak + 1,
    };
  } finally {
    await handle.close();
  }
}

async function findJsonlFiles(directory: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    const entries = await opendir(current);
    for await (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(entryPath);
      }
    }
  }
  return results.sort();
}

function getEventType(event: LogEvent): string | null {
  const payloadType = typeof event.payload?.type === "string" ? event.payload.type : null;
  if (event.type === "event_msg") {
    return payloadType;
  }
  if (event.type === "response_item" && payloadType === "custom_tool_call") {
    return "custom_tool_call";
  }
  return payloadType;
}

function getTurnId(event: LogEvent): string | null {
  const direct = event.payload?.turn_id;
  if (typeof direct === "string") {
    return direct;
  }
  const metadata = event.payload?.internal_chat_message_metadata_passthrough;
  if (isRecord(metadata) && typeof metadata.turn_id === "string") {
    return metadata.turn_id;
  }
  return null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberAt(record: Record<string, unknown> | undefined, path: string[]): number | null {
  let current: unknown = record;
  for (const part of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortFileName(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
