import { createHash } from "node:crypto";
import { access, opendir, open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { calculateMetrics } from "../domain/metrics.js";
import type { TurnRecord } from "../domain/types.js";
import { MonitorDatabase } from "../storage/database.js";

interface LogEvent {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
  message?: Record<string, unknown>;
  sessionId?: unknown;
  session_id?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
}

export interface RefreshResult {
  importedEvents: number;
  diagnostics: string[];
}

type EventApplicator = (database: MonitorDatabase, sourcePath: string, event: LogEvent) => void;

export async function refreshSessions(database: MonitorDatabase, sessionsDirectory: string): Promise<RefreshResult> {
  return refreshDirectory(database, sessionsDirectory, applyCodexEvent, "Codex");
}

export async function refreshClaudeSessions(database: MonitorDatabase, sessionsDirectory: string): Promise<RefreshResult> {
  try {
    await access(sessionsDirectory);
  } catch (error) {
    if (isNotFound(error)) {
      return { importedEvents: 0, diagnostics: [] };
    }
    return { importedEvents: 0, diagnostics: [`无法读取 Claude 会话目录：${toMessage(error)}`] };
  }
  return refreshDirectory(database, sessionsDirectory, applyClaudeEvent, "Claude", (name) => name === "subagents");
}

async function refreshDirectory(
  database: MonitorDatabase,
  sessionsDirectory: string,
  applyEvent: EventApplicator,
  sourceName: string,
  shouldSkipDirectory: (name: string) => boolean = () => false,
): Promise<RefreshResult> {
  const diagnostics: string[] = [];
  let importedEvents = 0;
  let paths: string[];

  try {
    paths = await findJsonlFiles(sessionsDirectory, shouldSkipDirectory);
  } catch (error) {
    return {
      importedEvents,
      diagnostics: [`无法读取 ${sourceName} 会话目录：${toMessage(error)}`],
    };
  }

  for (const sourcePath of paths) {
    const result = await ingestFile(database, sourcePath, applyEvent);
    importedEvents += result.importedEvents;
    diagnostics.push(...result.diagnostics);
  }

  return { importedEvents, diagnostics };
}

async function ingestFile(
  database: MonitorDatabase,
  sourcePath: string,
  applyEvent: EventApplicator,
): Promise<RefreshResult> {
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

function applyCodexEvent(database: MonitorDatabase, sourcePath: string, event: LogEvent): void {
  const eventType = getCodexEventType(event);
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
    finalizeCodexTurn(database, turnId, atMs, eventType === "task_complete", event.payload ?? {});
  }
}

function finalizeCodexTurn(
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
    provider: pending.provider,
    startedAtMs: pending.startedAtMs,
    completedAtMs,
    durationMs: metric.durationMs,
    ttftMs: metric.ttftMs,
    outputTokens: metric.outputTokens,
    effectiveTps: completed ? metric.effectiveTps : null,
    hasTool: pending.hasTool,
    status: completed ? "completed" : "aborted",
  };
  database.completeTurn(record);
}

function applyClaudeEvent(database: MonitorDatabase, sourcePath: string, event: LogEvent): void {
  const atMs = timestampMs(event.timestamp);
  const message = isRecord(event.message) ? event.message : null;
  if (atMs === null || message === null || !isClaudePrimaryEvent(event)) {
    return;
  }
  const role = stringAt(message, ["role"]);

  if (event.type === "user" && role === "user" && isClaudeUserPrompt(message)) {
    const sessionId = claudeSessionId(event, sourcePath);
    const userEventId = typeof event.uuid === "string" ? event.uuid : null;
    if (sessionId !== null && userEventId !== null) {
      database.startTurn(`claude:${sessionId}:${userEventId}`, sourcePath, atMs, "claude", sessionId);
    }
    return;
  }

  if (event.type !== "assistant" || role !== "assistant") {
    return;
  }

  const contentTypes = claudeContentTypes(message);
  if (contentTypes.includes("thinking") || contentTypes.includes("text")) {
    database.markFirstAgentEvent(sourcePath, atMs);
  }
  const outputTokens = numberAt(message, ["usage", "output_tokens"]);
  const messageId = stringAt(message, ["id"]) ?? (typeof event.uuid === "string" ? event.uuid : null);
  if (outputTokens !== null && messageId !== null) {
    database.addOutputTokensForMessage(sourcePath, messageId, outputTokens);
  }
  if (contentTypes.includes("tool_use") || stringAt(message, ["stop_reason"]) === "tool_use") {
    database.markToolCall(sourcePath, null);
  }
  if (stringAt(message, ["stop_reason"]) === "end_turn") {
    finalizeClaudeTurn(database, sourcePath, atMs);
  }
}

function finalizeClaudeTurn(database: MonitorDatabase, sourcePath: string, completedAtMs: number): void {
  const pending = database.getLatestPending(sourcePath);
  if (!pending) {
    return;
  }
  const durationMs = Math.max(0, completedAtMs - pending.startedAtMs);
  const ttftMs = pending.firstAgentAtMs === null ? null : Math.max(0, pending.firstAgentAtMs - pending.startedAtMs);
  const metric = calculateMetrics({ durationMs, ttftMs, outputTokens: pending.outputTokens });
  database.completeTurn({
    turnId: pending.turnId,
    sessionId: pending.sessionId,
    provider: pending.provider,
    startedAtMs: pending.startedAtMs,
    completedAtMs,
    durationMs: metric.durationMs,
    ttftMs: metric.ttftMs,
    outputTokens: metric.outputTokens,
    effectiveTps: metric.effectiveTps,
    hasTool: pending.hasTool,
    status: "completed",
  });
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

async function findJsonlFiles(
  directory: string,
  shouldSkipDirectory: (name: string) => boolean,
): Promise<string[]> {
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
      if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) {
        queue.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(entryPath);
      }
    }
  }
  return results.sort();
}

function getCodexEventType(event: LogEvent): string | null {
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

function isClaudePrimaryEvent(event: LogEvent): boolean {
  return event.isSidechain !== true && event.isMeta !== true && event.isCompactSummary !== true;
}

function isClaudeUserPrompt(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => isRecord(block) && (block.type === "text" || block.type === "image"));
}

function claudeContentTypes(message: Record<string, unknown>): string[] {
  const content = message.content;
  if (typeof content === "string") {
    return ["text"];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => isRecord(block) && typeof block.type === "string" ? [block.type] : []);
}

function claudeSessionId(event: LogEvent, sourcePath: string): string | null {
  if (typeof event.sessionId === "string") {
    return event.sessionId;
  }
  if (typeof event.session_id === "string") {
    return event.session_id;
  }
  const fallback = basename(sourcePath).replace(/\.jsonl$/i, "");
  return fallback.length > 0 ? fallback : null;
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

function stringAt(record: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = record;
  for (const part of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return typeof current === "string" ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function shortFileName(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
