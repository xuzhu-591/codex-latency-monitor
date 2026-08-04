import { formatMilliseconds, formatTps, percentile } from "../domain/metrics.js";
import type { ModelSummary, Provider, StatusReport, Summary, TurnRecord } from "../domain/types.js";
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
    modelSummaries: summarizeByModel(completedToday),
    importedEvents,
    diagnostics,
  };
}

export function formatSwiftBar(report: StatusReport): string {
  const lines: string[] = [headline(report.latest), "---"];

  if (report.active.length > 0) {
    const active = report.active[0];
    lines.push(`进行中 · ${providerName(active.provider)} · ${modelName(active.model)} | color=orange`);
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
  for (const entry of report.modelSummaries) {
    appendModelSummary(lines, entry);
  }
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

function summarizeByModel(turns: TurnRecord[]): ModelSummary[] {
  const groups = new Map<string, { provider: Provider; model: string | null; turns: TurnRecord[] }>();
  for (const turn of turns) {
    const key = `${turn.provider}\u0000${turn.model ?? ""}`;
    const group = groups.get(key) ?? { provider: turn.provider, model: turn.model, turns: [] };
    group.turns.push(turn);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ provider: group.provider, model: group.model, summary: summarize(group.turns) }))
    .sort((left, right) => providerOrder(left.provider) - providerOrder(right.provider) || modelName(left.model).localeCompare(modelName(right.model)));
}

function headline(latest: TurnRecord | null): string {
  if (!latest) {
    return "cx · 等待完成 Turn";
  }
  return `${providerName(latest.provider)} · ${modelName(latest.model)} · ${formatMilliseconds(latest.ttftMs)} · ${formatTps(latest.tps)}`;
}

function formatTurn(turn: TurnRecord): string {
  const completedAt = new Date(turn.completedAtMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const tool = turn.hasTool ? " · 工具" : "";
  const result = turn.status === "aborted"
    ? " · 中止"
    : ` · ${formatMilliseconds(turn.ttftMs)} · ${formatTps(turn.tps)}`;
  return `${completedAt} · ${providerName(turn.provider)} · ${modelName(turn.model)}${result}${tool} | disabled=true`;
}

function providerName(provider: Provider): string {
  return provider === "claude" ? "cc" : "cx";
}

function providerOrder(provider: Provider): number {
  return provider === "codex" ? 0 : 1;
}

function modelName(model: string | null): string {
  return model === null ? "N/A" : escapeMenuText(model);
}

function appendModelSummary(lines: string[], entry: ModelSummary): void {
  const { provider, model, summary } = entry;
  if (summary.completedCount === 0) {
    return;
  }
  const unavailable = summary.unavailableCount === 0 ? "" : ` · N/A ${summary.unavailableCount}`;
  lines.push(`${providerName(provider)} · ${modelName(model)} · ${summary.completedCount} 轮${unavailable} | disabled=true`);
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
