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
  const ttftChart = renderChart("近期 TTFT 时序", report.trend, (turn) => turn.ttftMs, "#2563eb", formatMilliseconds);
  const tpsChart = renderChart("近期 TPS 时序", report.trend, (turn) => turn.tps, "#059669", formatTps);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex 延迟报告</title>
<style>
body { max-width: 960px; margin: 40px auto; padding: 0 20px; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color: #18212f; }
h1 { margin-bottom: 8px; } h2 { margin-top: 32px; } .summary { display: flex; flex-wrap: wrap; gap: 14px; margin: 24px 0; } .card { background: #f3f6fb; border-radius: 10px; padding: 14px; min-width: 130px; }
.charts { display: grid; gap: 18px; } .chart { border: 1px solid #dde3ee; border-radius: 12px; padding: 16px; background: #fff; } .chart h3 { margin: 0 0 12px; font-size: 15px; } .chart-empty { color: #56627a; margin: 20px 0; }
svg { display: block; width: 100%; height: auto; } .grid { stroke: #e8edf5; stroke-width: 1; } .axis-label { fill: #6a7588; font-size: 11px; } .line { fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; } .point { stroke: #fff; stroke-width: 2; }
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
<section class="charts">${ttftChart}${tpsChart}</section>
<h2>最近 10 轮</h2>
<table><thead><tr><th>完成时间</th><th>会话</th><th>TTFT</th><th>TPS</th><th>总时长</th><th>工具</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function renderChart(
  title: string,
  turns: TurnRecord[],
  valueOf: (turn: TurnRecord) => number | null,
  color: string,
  format: (value: number | null) => string,
): string {
  const points = turns.flatMap((turn) => {
    const value = valueOf(turn);
    return value === null || !Number.isFinite(value) ? [] : [{ turn, value }];
  });
  if (points.length === 0) {
    return `<article class="chart"><h3>${title}</h3><p class="chart-empty">暂无可用数据</p></article>`;
  }

  const width = 880;
  const height = 220;
  const left = 52;
  const right = 20;
  const top = 18;
  const bottom = 34;
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(maximum - minimum, Math.max(maximum * 0.1, 1));
  const low = Math.max(0, minimum - spread * 0.12);
  const high = maximum + spread * 0.12;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const coordinate = (point: { value: number }, index: number) => {
    const x = points.length === 1 ? left + chartWidth / 2 : left + chartWidth * index / (points.length - 1);
    const y = top + (high - point.value) * chartHeight / (high - low);
    return { x, y };
  };
  const polyline = points.map((point, index) => {
    const { x, y } = coordinate(point, index);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = top + chartHeight * ratio;
    const value = high - (high - low) * ratio;
    return `<line class="grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="axis-label" x="0" y="${y + 4}">${escapeHtml(format(value))}</text>`;
  }).join("");
  const circles = points.map((point, index) => {
    const { x, y } = coordinate(point, index);
    const detail = `${new Date(point.turn.completedAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} · ${format(point.value)}`;
    return `<circle class="point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}"><title>${escapeHtml(detail)}</title></circle>`;
  }).join("");
  const firstTime = new Date(points[0].turn.completedAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const lastTime = new Date(points.at(-1)?.turn.completedAtMs ?? points[0].turn.completedAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

  return `<article class="chart"><h3>${title}</h3><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">${grid}<polyline class="line" stroke="${color}" points="${polyline}"/>${circles}<text class="axis-label" x="${left}" y="${height - 8}">${escapeHtml(firstTime)}</text><text class="axis-label" x="${width - right}" y="${height - 8}" text-anchor="end">${escapeHtml(lastTime)}</text></svg></article>`;
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
