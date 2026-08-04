import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatMilliseconds, formatTps } from "../domain/metrics.js";
import type { ModelSummary, Provider, StatusReport, TurnRecord } from "../domain/types.js";

export function writeReport(dataDirectory: string, report: StatusReport): string {
  mkdirSync(dataDirectory, { recursive: true });
  const outputPath = join(dataDirectory, "report.html");
  writeFileSync(outputPath, renderReport(report), "utf8");
  return outputPath;
}

function renderReport(report: StatusReport): string {
  const rows = report.recent.map(renderRow).join("\n") || "<tr><td colspan=\"8\">暂无完成 Turn</td></tr>";
  const ttftChart = renderChart("昨日及今日 TTFT 时序", "TTFT", report.trend, (turn) => turn.ttftMs, "#2563eb", formatMilliseconds);
  const tpsChart = renderChart("昨日及今日 TPS 时序", "TPS", report.trend, (turn) => turn.tps, "#059669", formatTps);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex 与 Claude 延迟报告</title>
<style>
body { max-width: 960px; margin: 40px auto; padding: 0 20px; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color: #18212f; }
h1 { margin-bottom: 8px; } h2 { margin-top: 32px; } .summary { display: flex; flex-wrap: wrap; gap: 14px; margin: 24px 0; } .card { background: #f3f6fb; border-radius: 10px; padding: 14px; min-width: 130px; }
.charts { display: grid; gap: 18px; } .chart { border: 1px solid #dde3ee; border-radius: 12px; padding: 16px; background: #fff; } .chart h3 { margin: 0; font-size: 15px; } .chart-heading { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; margin-bottom: 12px; } .chart-empty { color: #56627a; margin: 20px 0; }
.chart-legend { display: flex; gap: 12px; color: #56627a; font-size: 12px; white-space: nowrap; } .legend-codex { color: #2563eb; } .legend-claude { color: #d97706; } .provider-badge { font-weight: 600; white-space: nowrap; } .provider-badge.codex { color: #1d4ed8; } .provider-badge.claude { color: #b45309; }
svg { display: block; width: 100%; height: auto; } .grid { stroke: #e8edf5; stroke-width: 1; } .axis-label { fill: #6a7588; font-size: 11px; } .line { fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; } .point { stroke: #fff; stroke-width: 2; pointer-events: none; } .point.codex { fill: #2563eb; } .point.claude { fill: #d97706; } .point-hit-area { fill: transparent; cursor: default; } .chart-tooltip { position: fixed; z-index: 1; max-width: calc(100vw - 16px); padding: 7px 10px; border-radius: 7px; background: #18212f; color: #fff; font-size: 12px; line-height: 1.4; pointer-events: none; box-shadow: 0 4px 16px rgb(24 33 47 / 20%); }
table { width: 100%; border-collapse: collapse; } th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #dde3ee; } th { color: #56627a; }
</style>
</head>
<body>
<h1>Codex 与 Claude 本地延迟报告</h1>
<p>仅包含本机汇总指标，不包含会话正文、工具参数或工作区路径。</p>
<section class="summary">
  ${renderModelSummaryCards(report.modelSummaries)}
</section>
<section class="charts">${ttftChart}${tpsChart}</section>
<h2>最近 50 轮</h2>
<table><thead><tr><th>完成时间</th><th>来源</th><th>模型</th><th>会话 ID</th><th>TTFT</th><th>TPS</th><th>总时长</th><th>工具</th></tr></thead><tbody>${rows}</tbody></table>
<div class="chart-tooltip" data-chart-tooltip hidden></div>
<script>
(() => {
  const tooltip = document.querySelector("[data-chart-tooltip]");
  if (!(tooltip instanceof HTMLElement)) return;

  const positionTooltip = (event) => {
    const gap = 12;
    const left = Math.max(8, Math.min(event.clientX + gap, window.innerWidth - tooltip.offsetWidth - 8));
    const top = Math.max(8, Math.min(event.clientY + gap, window.innerHeight - tooltip.offsetHeight - 8));
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  };

  for (const point of document.querySelectorAll("[data-chart-point]")) {
    point.addEventListener("pointerenter", (event) => {
      tooltip.textContent = point.dataset.provider + " · " + point.dataset.model + " · " + point.dataset.time + " · " + point.dataset.metric + " " + point.dataset.value;
      tooltip.hidden = false;
      positionTooltip(event);
    });
    point.addEventListener("pointermove", positionTooltip);
    point.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
  }
})();
</script>
</body></html>`;
}

function renderModelSummaryCards(summaries: ModelSummary[]): string {
  if (summaries.length === 0) {
    return "<div class=\"card\">完成 Turn<br><strong>0</strong></div>";
  }
  return summaries.map(({ provider, model, summary }) => `<div class="card">${providerBadge(provider)} · ${escapeHtml(modelName(model))}<br><strong>${summary.completedCount} 轮</strong><br>TTFT p50 ${formatMilliseconds(summary.p50TtftMs)} · p95 ${formatMilliseconds(summary.p95TtftMs)}<br>TPS p50 ${formatTps(summary.p50Tps)} · p5 ${formatTps(summary.p5Tps)}</div>`).join("\n");
}

function renderChart(
  title: string,
  metricLabel: string,
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
    const provider = providerName(point.turn.provider);
    const model = modelName(point.turn.model);
    const detail = `${provider} · ${model} · ${formatDateTime(point.turn.completedAtMs)} · ${metricLabel} ${format(point.value)}`;
    const data = `data-chart-point data-provider="${provider}" data-model="${escapeHtml(model)}" data-time="${escapeHtml(formatDateTime(point.turn.completedAtMs))}" data-metric="${escapeHtml(metricLabel)}" data-value="${escapeHtml(format(point.value))}"`;
    const marker = point.turn.provider === "claude"
      ? `<polygon class="point claude" points="${x.toFixed(1)},${(y - 5).toFixed(1)} ${(x + 5).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${(y + 5).toFixed(1)} ${(x - 5).toFixed(1)},${y.toFixed(1)}"/>`
      : `<circle class="point codex" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>`;
    return `<circle class="point-hit-area" ${data} cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10"><title>${escapeHtml(detail)}</title></circle>${marker}`;
  }).join("");
  const firstTime = new Date(points[0].turn.completedAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const lastTime = new Date(points.at(-1)?.turn.completedAtMs ?? points[0].turn.completedAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

  return `<article class="chart"><div class="chart-heading"><h3>${title}</h3><div class="chart-legend"><span class="legend-codex">● cx</span><span class="legend-claude">◆ cc</span></div></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">${grid}<polyline class="line" stroke="${color}" points="${polyline}"/>${circles}<text class="axis-label" x="${left}" y="${height - 8}">${escapeHtml(firstTime)}</text><text class="axis-label" x="${width - right}" y="${height - 8}" text-anchor="end">${escapeHtml(lastTime)}</text></svg></article>`;
}

function renderRow(turn: TurnRecord): string {
  return `<tr><td>${escapeHtml(new Date(turn.completedAtMs).toLocaleString("zh-CN"))}</td><td>${providerBadge(turn.provider)}</td><td>${escapeHtml(modelName(turn.model))}</td><td>${escapeHtml(turn.sessionId)}</td><td>${formatMilliseconds(turn.ttftMs)}</td><td>${formatTps(turn.tps)}</td><td>${formatMilliseconds(turn.durationMs)}</td><td>${turn.hasTool ? "是" : "否"}</td></tr>`;
}

function providerBadge(provider: Provider): string {
  return provider === "claude"
    ? "<span class=\"provider-badge claude\">◆ cc</span>"
    : "<span class=\"provider-badge codex\">● cx</span>";
}

function providerName(provider: Provider): string {
  return provider === "claude" ? "cc" : "cx";
}

function modelName(model: string | null): string {
  return model ?? "N/A";
}

function formatDateTime(atMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(atMs));
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
