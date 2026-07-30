import assert from "node:assert/strict";
import test from "node:test";
import { calculateMetrics, percentile } from "../src/domain/metrics.js";

test("Effective TPS 从 Turn 开始到完成计算，包含 TTFT 与工具等待", () => {
  const result = calculateMetrics({ durationMs: 10_000, ttftMs: 2_000, outputTokens: 20 });
  assert.equal(result.effectiveTps, 2);
  assert.equal(result.durationMs, 10_000);
});

test("缺少 TTFT 仍可计算 Effective TPS，缺少总时长或输出时为 N/A", () => {
  assert.equal(calculateMetrics({ durationMs: 1_000, ttftMs: null, outputTokens: 10 }).effectiveTps, 10);
  assert.equal(calculateMetrics({ durationMs: 0, ttftMs: 0, outputTokens: 10 }).effectiveTps, null);
  assert.equal(calculateMetrics({ durationMs: 1_000, ttftMs: 100, outputTokens: 0 }).effectiveTps, null);
});

test("百分位在空集、小样本和偶数样本上稳定", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 3], 0.5), 2);
});
