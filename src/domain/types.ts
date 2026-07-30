export type TurnStatus = "completed" | "aborted";
export type Provider = "codex" | "claude";

export interface PendingTurn {
  turnId: string;
  sourcePath: string;
  sessionId: string;
  provider: Provider;
  startedAtMs: number;
  firstAgentAtMs: number | null;
  outputTokens: number;
  hasTool: boolean;
}

export interface TurnRecord {
  turnId: string;
  sessionId: string;
  provider: Provider;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number | null;
  ttftMs: number | null;
  outputTokens: number | null;
  effectiveTps: number | null;
  hasTool: boolean;
  status: TurnStatus;
}

export interface ActiveTurn {
  turnId: string;
  sessionId: string;
  provider: Provider;
  startedAtMs: number;
  estimatedTtftMs: number | null;
  hasTool: boolean;
}

export interface Summary {
  completedCount: number;
  unavailableCount: number;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  p50EffectiveTps: number | null;
  p5EffectiveTps: number | null;
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
