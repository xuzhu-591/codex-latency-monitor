import assert from "node:assert/strict";
import test from "node:test";
import { calculateMetrics, percentile } from "../src/domain/metrics.js";

test("TPS 从首 token 到完成计算，且不扣除工具等待", () => {
  const result = calculateMetrics({ durationMs: 10_000, ttftMs: 2_000, outputTokens: 20 });
  assert.equal(result.tps, 2.5);
  assert.equal(result.durationMs, 10_000);
});

test("缺失数据或无输出阶段时 TPS 为 N/A", () => {
  assert.equal(calculateMetrics({ durationMs: 1_000, ttftMs: null, outputTokens: 10 }).tps, null);
  assert.equal(calculateMetrics({ durationMs: 1_000, ttftMs: 1_000, outputTokens: 10 }).tps, null);
  assert.equal(calculateMetrics({ durationMs: 1_000, ttftMs: 100, outputTokens: 0 }).tps, null);
});

test("百分位在空集、小样本和偶数样本上稳定", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 3], 0.5), 2);
});
