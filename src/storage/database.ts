import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ActiveTurn, PendingTurn, TurnRecord } from "../domain/types.js";

export class MonitorDatabase {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation)();
  }

  getOffset(sourcePath: string): number {
    const row = this.#database.prepare("SELECT offset_bytes FROM source_files WHERE source_path = ?")
      .get(sourcePath) as { offset_bytes: number } | undefined;
    return row?.offset_bytes ?? 0;
  }

  saveOffset(sourcePath: string, offsetBytes: number): void {
    this.#database.prepare(`
      INSERT INTO source_files (source_path, offset_bytes, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        offset_bytes = excluded.offset_bytes,
        updated_at_ms = excluded.updated_at_ms
    `).run(sourcePath, offsetBytes, Date.now());
  }

  startTurn(turnId: string, sourcePath: string, startedAtMs: number): void {
    this.#database.prepare(`
      INSERT INTO pending_turns (turn_id, source_path, session_key, started_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(turn_id) DO NOTHING
    `).run(turnId, sourcePath, sessionKey(sourcePath), startedAtMs);
  }

  markFirstAgentEvent(sourcePath: string, atMs: number): void {
    this.#database.prepare(`
      UPDATE pending_turns
      SET first_agent_at_ms = COALESCE(first_agent_at_ms, ?)
      WHERE turn_id = (
        SELECT turn_id FROM pending_turns
        WHERE source_path = ?
        ORDER BY started_at_ms DESC LIMIT 1
      )
    `).run(atMs, sourcePath);
  }

  addOutputTokens(sourcePath: string, outputTokens: number): void {
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
      return;
    }
    this.#database.prepare(`
      UPDATE pending_turns
      SET output_tokens = output_tokens + ?
      WHERE turn_id = (
        SELECT turn_id FROM pending_turns
        WHERE source_path = ?
        ORDER BY started_at_ms DESC LIMIT 1
      )
    `).run(Math.floor(outputTokens), sourcePath);
  }

  markToolCall(sourcePath: string, turnId: string | null): void {
    if (turnId) {
      this.#database.prepare("UPDATE pending_turns SET has_tool = 1 WHERE turn_id = ?").run(turnId);
      return;
    }
    this.#database.prepare(`
      UPDATE pending_turns
      SET has_tool = 1
      WHERE turn_id = (
        SELECT turn_id FROM pending_turns
        WHERE source_path = ?
        ORDER BY started_at_ms DESC LIMIT 1
      )
    `).run(sourcePath);
  }

  getPending(turnId: string): PendingTurn | null {
    const row = this.#database.prepare("SELECT * FROM pending_turns WHERE turn_id = ?").get(turnId);
    return row ? mapPending(row as PendingRow) : null;
  }

  completeTurn(record: TurnRecord): void {
    this.#database.prepare(`
      INSERT INTO turns (
        turn_id, session_key, started_at_ms, completed_at_ms, duration_ms,
        ttft_ms, output_tokens, tps, has_tool, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        session_key = excluded.session_key,
        started_at_ms = excluded.started_at_ms,
        completed_at_ms = excluded.completed_at_ms,
        duration_ms = excluded.duration_ms,
        ttft_ms = excluded.ttft_ms,
        output_tokens = excluded.output_tokens,
        tps = excluded.tps,
        has_tool = excluded.has_tool,
        status = excluded.status
    `).run(
      record.turnId,
      record.sessionKey,
      record.startedAtMs,
      record.completedAtMs,
      record.durationMs,
      record.ttftMs,
      record.outputTokens,
      record.tps,
      Number(record.hasTool),
      record.status,
    );
    this.#database.prepare("DELETE FROM pending_turns WHERE turn_id = ?").run(record.turnId);
  }

  listRecent(limit: number): TurnRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM turns ORDER BY completed_at_ms DESC LIMIT ?
    `).all(limit) as TurnRow[];
    return rows.map(mapTurn);
  }

  listCompletedSince(startAtMs: number): TurnRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM turns WHERE completed_at_ms >= ? ORDER BY completed_at_ms ASC
    `).all(startAtMs) as TurnRow[];
    return rows.map(mapTurn);
  }

  listActive(nowMs: number): ActiveTurn[] {
    const rows = this.#database.prepare(`
      SELECT turn_id, session_key, started_at_ms, first_agent_at_ms, has_tool
      FROM pending_turns ORDER BY started_at_ms DESC
    `).all() as PendingRow[];
    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionKey: row.session_key,
      startedAtMs: row.started_at_ms,
      estimatedTtftMs: row.first_agent_at_ms === null ? null : Math.max(0, row.first_agent_at_ms - row.started_at_ms),
      hasTool: Boolean(row.has_tool),
    })).filter((turn) => turn.startedAtMs <= nowMs);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS source_files (
        source_path TEXT PRIMARY KEY,
        offset_bytes INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_turns (
        turn_id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        session_key TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        first_agent_at_ms INTEGER,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        has_tool INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pending_source_started
        ON pending_turns(source_path, started_at_ms DESC);
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER NOT NULL,
        duration_ms INTEGER,
        ttft_ms INTEGER,
        output_tokens INTEGER,
        tps REAL,
        has_tool INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed', 'aborted'))
      );
      CREATE INDEX IF NOT EXISTS idx_turns_completed
        ON turns(completed_at_ms DESC);
    `);
  }
}

export function defaultDatabasePath(dataDirectory: string): string {
  return join(dataDirectory, "monitor.db");
}

function sessionKey(sourcePath: string): string {
  return createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
}

interface PendingRow {
  turn_id: string;
  source_path: string;
  session_key: string;
  started_at_ms: number;
  first_agent_at_ms: number | null;
  output_tokens: number;
  has_tool: number;
}

interface TurnRow {
  turn_id: string;
  session_key: string;
  started_at_ms: number;
  completed_at_ms: number;
  duration_ms: number | null;
  ttft_ms: number | null;
  output_tokens: number | null;
  tps: number | null;
  has_tool: number;
  status: "completed" | "aborted";
}

function mapPending(row: PendingRow): PendingTurn {
  return {
    turnId: row.turn_id,
    sourcePath: row.source_path,
    sessionKey: row.session_key,
    startedAtMs: row.started_at_ms,
    firstAgentAtMs: row.first_agent_at_ms,
    outputTokens: row.output_tokens,
    hasTool: Boolean(row.has_tool),
  };
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    turnId: row.turn_id,
    sessionKey: row.session_key,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
    durationMs: row.duration_ms,
    ttftMs: row.ttft_ms,
    outputTokens: row.output_tokens,
    tps: row.tps,
    hasTool: Boolean(row.has_tool),
    status: row.status,
  };
}
