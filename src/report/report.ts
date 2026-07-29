import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatMilliseconds, formatTps } from "../domain/metrics.js";
import type { StatusReport, TurnRecord } from "../domain/types.js";

export function writeReport(dataDirectory: string, report: StatusReport): string {
  mkdirSync(dataDirectory, { recursive: true });
  const outputPath = join(dataDirectory, "report.html");
  writeFileSync(outputPath, renderReport(report), "utf8");
  return outputPath;
}

function renderReport(report: StatusReport): string {
  const rows = report.recent.map(renderRow).join("\n") || "<tr><td colspan=\"6\">暂无完成 Turn</td></tr>";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex 延迟报告</title>
<style>
body { max-width: 960px; margin: 40px auto; padding: 0 20px; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color: #18212f; }
h1 { margin-bottom: 8px; } .summary { display: flex; gap: 24px; margin: 24px 0; } .card { background: #f3f6fb; border-radius: 10px; padding: 14px; min-width: 130px; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #dde3ee; } th { color: #56627a; }
</style>
</head>
<body>
<h1>Codex 本地延迟报告</h1>
<p>仅包含本机汇总指标，不包含会话正文、工具参数或工作区路径。</p>
<section class="summary">
  <div class="card">完成 Turn<br><strong>${report.summary.completedCount}</strong></div>
  <div class="card">p50 TTFT<br><strong>${formatMilliseconds(report.summary.p50TtftMs)}</strong></div>
  <div class="card">p95 TTFT<br><strong>${formatMilliseconds(report.summary.p95TtftMs)}</strong></div>
  <div class="card">p50 TPS<br><strong>${formatTps(report.summary.p50Tps)}</strong></div>
</section>
<h2>最近 10 轮</h2>
<table><thead><tr><th>完成时间</th><th>会话</th><th>TTFT</th><th>TPS</th><th>总时长</th><th>工具</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function renderRow(turn: TurnRecord): string {
  return `<tr><td>${escapeHtml(new Date(turn.completedAtMs).toLocaleString("zh-CN"))}</td><td>${escapeHtml(turn.sessionKey)}</td><td>${formatMilliseconds(turn.ttftMs)}</td><td>${formatTps(turn.tps)}</td><td>${formatMilliseconds(turn.durationMs)}</td><td>${turn.hasTool ? "是" : "否"}</td></tr>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}
