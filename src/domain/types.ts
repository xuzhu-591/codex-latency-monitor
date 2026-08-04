export type TurnStatus = "completed" | "aborted";
export type Provider = "codex" | "claude";

export interface PendingTurn {
  turnId: string;
  sourcePath: string;
  sessionId: string;
  provider: Provider;
  model: string | null;
  startedAtMs: number;
  firstAgentAtMs: number | null;
  outputTokens: number;
  hasTool: boolean;
}

export interface TurnRecord {
  turnId: string;
  sessionId: string;
  provider: Provider;
  model: string | null;
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
  sessionId: string;
  provider: Provider;
  model: string | null;
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
  p5Tps: number | null;
}

export interface ModelSummary {
  provider: Provider;
  model: string | null;
  summary: Summary;
}

export interface StatusReport {
  latest: TurnRecord | null;
  recent: TurnRecord[];
  trend: TurnRecord[];
  active: ActiveTurn[];
  summary: Summary;
  modelSummaries: ModelSummary[];
  importedEvents: number;
  diagnostics: string[];
}
