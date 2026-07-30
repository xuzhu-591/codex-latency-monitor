export interface MetricInput {
  durationMs: number | null;
  ttftMs: number | null;
  outputTokens: number;
}

export interface MetricResult {
  durationMs: number | null;
  ttftMs: number | null;
  outputTokens: number | null;
  tps: number | null;
}

export function calculateMetrics(input: MetricInput): MetricResult {
  const durationMs = isNonNegativeFinite(input.durationMs) ? input.durationMs : null;
  const ttftMs = isNonNegativeFinite(input.ttftMs) ? input.ttftMs : null;
  const outputTokens = Number.isFinite(input.outputTokens) && input.outputTokens > 0
    ? Math.floor(input.outputTokens)
    : null;

  if (durationMs === null || outputTokens === null || durationMs <= 0) {
    return { durationMs, ttftMs, outputTokens, tps: null };
  }

  return {
    durationMs,
    ttftMs,
    outputTokens,
    tps: outputTokens / (durationMs / 1_000),
  };
}

export function percentile(values: number[], quantile: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function formatMilliseconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "N/A";
  }
  return `${(value / 1_000).toFixed(1)}s`;
}

export function formatTps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "N/A";
  }
  return `${value.toFixed(1)}/s`;
}

function isNonNegativeFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}
