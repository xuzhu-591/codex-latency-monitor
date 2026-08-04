import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ActiveTurn, PendingTurn, Provider, TurnRecord } from "../domain/types.js";

export class MonitorDatabase {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#migrate();
    this.#migrateProvider();
    this.#migrateModel();
    this.#migrateTps();
    this.#migrateSessionIds();
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

  startTurn(
    turnId: string,
    sourcePath: string,
    startedAtMs: number,
    provider: Provider = "codex",
    explicitSessionId = codexSessionId(sourcePath),
    model: string | null = null,
  ): void {
    this.#database.prepare(`
      INSERT INTO pending_turns (turn_id, source_path, session_key, provider, model, started_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO NOTHING
    `).run(turnId, sourcePath, explicitSessionId, provider, model, startedAtMs);
  }

  getSourceModel(sourcePath: string): string | null {
    const row = this.#database.prepare("SELECT model FROM source_models WHERE source_path = ?")
      .get(sourcePath) as { model: string } | undefined;
    return row?.model ?? null;
  }

  setSourceModel(sourcePath: string, model: string | null): void {
    if (model === null) {
      return;
    }
    this.#database.prepare(`
      INSERT INTO source_models (source_path, model)
      VALUES (?, ?)
      ON CONFLICT(source_path) DO UPDATE SET model = excluded.model
    `).run(sourcePath, model);
  }

  setLatestPendingModel(sourcePath: string, model: string | null): void {
    if (model === null) {
      return;
    }
    this.#database.prepare(`
      UPDATE pending_turns
      SET model = ?
      WHERE turn_id = (
        SELECT turn_id FROM pending_turns
        WHERE source_path = ?
        ORDER BY started_at_ms DESC LIMIT 1
      )
    `).run(model, sourcePath);
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

  addOutputTokensForMessage(sourcePath: string, messageId: string, outputTokens: number): void {
    if (!Number.isFinite(outputTokens) || outputTokens < 0) {
      return;
    }
    const pending = this.getLatestPending(sourcePath);
    if (!pending) {
      return;
    }
    const previous = this.#database.prepare(`
      SELECT output_tokens FROM message_token_usage WHERE turn_id = ? AND message_id = ?
    `).get(pending.turnId, messageId) as { output_tokens: number } | undefined;
    const current = Math.floor(outputTokens);
    const delta = current - (previous?.output_tokens ?? 0);
    if (delta <= 0) {
      return;
    }
    this.#database.prepare(`
      INSERT INTO message_token_usage (turn_id, message_id, output_tokens)
      VALUES (?, ?, ?)
      ON CONFLICT(turn_id, message_id) DO UPDATE SET output_tokens = excluded.output_tokens
    `).run(pending.turnId, messageId, current);
    this.#database.prepare("UPDATE pending_turns SET output_tokens = output_tokens + ? WHERE turn_id = ?")
      .run(delta, pending.turnId);
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

  getLatestPending(sourcePath: string): PendingTurn | null {
    const row = this.#database.prepare(`
      SELECT * FROM pending_turns WHERE source_path = ? ORDER BY started_at_ms DESC LIMIT 1
    `).get(sourcePath);
    return row ? mapPending(row as PendingRow) : null;
  }

  completeTurn(record: TurnRecord): void {
    this.#database.prepare(`
      INSERT INTO turns (
        turn_id, session_key, started_at_ms, completed_at_ms, duration_ms,
        ttft_ms, output_tokens, tps, has_tool, status, provider, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        session_key = excluded.session_key,
        started_at_ms = excluded.started_at_ms,
        completed_at_ms = excluded.completed_at_ms,
        duration_ms = excluded.duration_ms,
        ttft_ms = excluded.ttft_ms,
        output_tokens = excluded.output_tokens,
        tps = excluded.tps,
        has_tool = excluded.has_tool,
        status = excluded.status,
        provider = excluded.provider,
        model = excluded.model
    `).run(
      record.turnId,
      record.sessionId,
      record.startedAtMs,
      record.completedAtMs,
      record.durationMs,
      record.ttftMs,
      record.outputTokens,
      record.tps,
      Number(record.hasTool),
      record.status,
      record.provider,
      record.model,
    );
    this.#database.prepare("DELETE FROM pending_turns WHERE turn_id = ?").run(record.turnId);
    this.#database.prepare("DELETE FROM message_token_usage WHERE turn_id = ?").run(record.turnId);
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
      SELECT turn_id, session_key, provider, model, started_at_ms, first_agent_at_ms, has_tool
      FROM pending_turns ORDER BY started_at_ms DESC
    `).all() as PendingRow[];
    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionId: row.session_key,
      provider: row.provider,
      model: row.model,
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
        provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex', 'claude')),
        model TEXT,
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
        status TEXT NOT NULL CHECK(status IN ('completed', 'aborted')),
        provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex', 'claude')),
        model TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_turns_completed
        ON turns(completed_at_ms DESC);
      CREATE TABLE IF NOT EXISTS message_token_usage (
        turn_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        output_tokens INTEGER NOT NULL,
        PRIMARY KEY (turn_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS source_models (
        source_path TEXT PRIMARY KEY,
        model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monitor_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  #migrateProvider(): void {
    this.#ensureColumn("pending_turns", "provider", "TEXT NOT NULL DEFAULT 'codex'");
    this.#ensureColumn("turns", "provider", "TEXT NOT NULL DEFAULT 'codex'");
  }

  #migrateModel(): void {
    this.#ensureColumn("pending_turns", "model", "TEXT");
    this.#ensureColumn("turns", "model", "TEXT");
    const row = this.#database.prepare("SELECT value FROM monitor_metadata WHERE key = 'turn_model'")
      .get() as { value: string } | undefined;
    if (row?.value === "v1") {
      return;
    }
    this.#database.transaction(() => {
      this.#database.prepare("UPDATE source_files SET offset_bytes = 0").run();
      this.#database.prepare("DELETE FROM source_models").run();
      this.#database.prepare("DELETE FROM pending_turns").run();
      this.#database.prepare("DELETE FROM message_token_usage").run();
      this.#database.prepare(`
        INSERT INTO monitor_metadata (key, value) VALUES ('turn_model', 'v1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();
    })();
  }

  #migrateTps(): void {
    const row = this.#database.prepare("SELECT value FROM monitor_metadata WHERE key = 'metric_definition'")
      .get() as { value: string } | undefined;
    if (row) {
      return;
    }
    this.#database.transaction(() => {
      this.#database.prepare(`
        UPDATE turns
        SET tps = CASE
          WHEN duration_ms > 0 AND output_tokens > 0 THEN output_tokens * 1000.0 / duration_ms
          ELSE NULL
        END
      `).run();
      this.#database.prepare(`
        INSERT INTO monitor_metadata (key, value) VALUES ('metric_definition', 'tps-v2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();
    })();
  }

  #ensureColumn(table: "pending_turns" | "turns", column: string, definition: string): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  #migrateSessionIds(): void {
    const sourceFiles = this.#database.prepare("SELECT source_path FROM source_files")
      .all() as Array<{ source_path: string }>;
    const updateTurns = this.#database.prepare("UPDATE turns SET session_key = ? WHERE session_key = ?");
    const updatePendingTurns = this.#database.prepare("UPDATE pending_turns SET session_key = ? WHERE session_key = ?");

    this.#database.transaction(() => {
      for (const sourceFile of sourceFiles) {
        if (!basename(sourceFile.source_path).startsWith("rollout-")) {
          continue;
        }
        const legacyKey = legacySessionKey(sourceFile.source_path);
        const id = codexSessionId(sourceFile.source_path);
        if (id === legacyKey) {
          continue;
        }
        updateTurns.run(id, legacyKey);
        updatePendingTurns.run(id, legacyKey);
      }
    })();
  }
}

export function defaultDatabasePath(dataDirectory: string): string {
  return join(dataDirectory, "monitor.db");
}

function codexSessionId(sourcePath: string): string {
  const match = basename(sourcePath).match(/-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? "N/A";
}

function legacySessionKey(sourcePath: string): string {
  return createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
}

interface PendingRow {
  turn_id: string;
  source_path: string;
  session_key: string;
  provider: Provider;
  model: string | null;
  started_at_ms: number;
  first_agent_at_ms: number | null;
  output_tokens: number;
  has_tool: number;
}

interface TurnRow {
  turn_id: string;
  session_key: string;
  provider: Provider;
  model: string | null;
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
    sessionId: row.session_key,
    provider: row.provider,
    model: row.model,
    startedAtMs: row.started_at_ms,
    firstAgentAtMs: row.first_agent_at_ms,
    outputTokens: row.output_tokens,
    hasTool: Boolean(row.has_tool),
  };
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    turnId: row.turn_id,
    sessionId: row.session_key,
    provider: row.provider,
    model: row.model,
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
