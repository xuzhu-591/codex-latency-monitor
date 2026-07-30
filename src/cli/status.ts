import { formatMilliseconds, formatTps, percentile } from "../domain/metrics.js";
import type { Provider, StatusReport, Summary, TurnRecord } from "../domain/types.js";
import { MonitorDatabase } from "../storage/database.js";

export function buildStatus(
  database: MonitorDatabase,
  importedEvents: number,
  diagnostics: string[],
  nowMs = Date.now(),
): StatusReport {
  const recent = database.listRecent(50);
  const latest = recent.find((turn) => turn.status === "completed") ?? null;
  const completedToday = database.listCompletedSince(startOfLocalDay(nowMs));
  const trend = database.listCompletedSince(startOfPreviousLocalDay(nowMs))
    .filter((turn) => turn.status === "completed" && turn.completedAtMs <= nowMs);
  return {
    latest,
    recent,
    trend,
    active: database.listActive(nowMs),
    summary: summarize(completedToday),
    providerSummaries: {
      codex: summarize(completedToday.filter((turn) => turn.provider === "codex")),
      claude: summarize(completedToday.filter((turn) => turn.provider === "claude")),
    },
    importedEvents,
    diagnostics,
  };
}

export function formatSwiftBar(report: StatusReport): string {
  const lines: string[] = [headline(report.latest), "---"];

  if (report.active.length > 0) {
    const active = report.active[0];
    const estimate = active.estimatedTtftMs === null ? "尚未出现首个助手事件" : `预估 TTFT ${formatMilliseconds(active.estimatedTtftMs)}`;
    lines.push(`进行中 · ${providerName(active.provider)} · ${estimate} | color=orange`);
  }

  lines.push("最近 10 轮 | disabled=true");
  const menuRecent = report.recent.slice(0, 10);
  if (menuRecent.length === 0) {
    lines.push("暂无完成 Turn | disabled=true");
  } else {
    for (const turn of menuRecent) {
      lines.push(formatTurn(turn));
    }
  }

  lines.push("---");
  lines.push(`今天 · ${report.summary.completedCount} 轮 | disabled=true`);
  appendProviderSummary(lines, "codex", report.providerSummaries.codex);
  appendProviderSummary(lines, "claude", report.providerSummaries.claude);
  if (report.diagnostics.length > 0) {
    lines.push("---");
    lines.push(`诊断：${escapeMenuText(report.diagnostics[0])} | color=red`);
  }
  return `${lines.join("\n")}\n`;
}

function summarize(turns: TurnRecord[]): Summary {
  const completed = turns.filter((turn) => turn.status === "completed");
  const ttft = completed.flatMap((turn) => turn.ttftMs === null ? [] : [turn.ttftMs]);
  const tps = completed.flatMap((turn) => turn.tps === null ? [] : [turn.tps]);
  return {
    completedCount: completed.length,
    unavailableCount: completed.filter((turn) => turn.ttftMs === null || turn.tps === null).length,
    p50TtftMs: percentile(ttft, 0.5),
    p95TtftMs: percentile(ttft, 0.95),
    p50Tps: percentile(tps, 0.5),
    p5Tps: percentile(tps, 0.05),
  };
}

function headline(latest: TurnRecord | null): string {
  if (!latest) {
    return "Codex · 等待完成 Turn";
  }
  return `${providerName(latest.provider)} · TTFT ${formatMilliseconds(latest.ttftMs)} · TPS ${formatTps(latest.tps)}`;
}

function formatTurn(turn: TurnRecord): string {
  const completedAt = new Date(turn.completedAtMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const tool = turn.hasTool ? " · 工具" : "";
  const state = turn.status === "aborted"
    ? "中止"
    : `TTFT ${formatMilliseconds(turn.ttftMs)} · TPS ${formatTps(turn.tps)}`;
  return `${completedAt} · ${providerName(turn.provider)} · ${state}${tool} | disabled=true`;
}

function providerName(provider: Provider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function appendProviderSummary(lines: string[], provider: Provider, summary: Summary): void {
  if (summary.completedCount === 0) {
    return;
  }
  const unavailable = summary.unavailableCount === 0 ? "" : ` · N/A ${summary.unavailableCount}`;
  lines.push(`${providerName(provider)} · ${summary.completedCount} 轮${unavailable} | disabled=true`);
  lines.push(`TTFT p50 ${formatMilliseconds(summary.p50TtftMs)} · p95 ${formatMilliseconds(summary.p95TtftMs)} | disabled=true`);
  lines.push(`TPS p50 ${formatTps(summary.p50Tps)} · p5 ${formatTps(summary.p5Tps)} | disabled=true`);
}

function startOfLocalDay(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfPreviousLocalDay(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
}

function escapeMenuText(value: string): string {
  return value.replace(/[\r\n|]/g, " ");
}
