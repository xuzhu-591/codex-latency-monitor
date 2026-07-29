export type TurnStatus = "completed" | "aborted";

export interface PendingTurn {
  turnId: string;
  sourcePath: string;
  sessionKey: string;
  startedAtMs: number;
  firstAgentAtMs: number | null;
  outputTokens: number;
  hasTool: boolean;
}

export interface TurnRecord {
  turnId: string;
  sessionKey: string;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number | null;
  ttftMs: number | null;
  outputTokens: number | null;
  tps: number | null;
  hasTool: boolean;
  status: TurnStatus;
}

export interface ActiveTurn {
  turnId: string;
  sessionKey: string;
  startedAtMs: number;
  estimatedTtftMs: number | null;
  hasTool: boolean;
}

export interface Summary {
  completedCount: number;
  unavailableCount: number;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  p50Tps: number | null;
}

export interface StatusReport {
  latest: TurnRecord | null;
  recent: TurnRecord[];
  trend: TurnRecord[];
  active: ActiveTurn[];
  summary: Summary;
  importedEvents: number;
  diagnostics: string[];
}
