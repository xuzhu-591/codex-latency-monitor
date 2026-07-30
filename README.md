# Codex Latency Monitor

在 macOS 菜单栏被动查看本机 **Codex** 和 **Claude Code** 的响应体验：TTFT 与 TPS。

它只读取已经落盘的本地会话 JSONL，不发探针、不修改任一工具的配置，也不会将会话正文、工具输入输出或工作区路径写入数据库、报告或菜单栏。

## 指标

- **TTFT**：从用户提交 Turn 到第一个助手输出的等待时间，越小越好。
- **TPS**：该 Turn 的输出 token 总数 ÷ 用户提交到 Turn 完成的总时长，越大越好。它包含 TTFT、模型思考、网络与工具等待，代表从“提问”到“拿到结果”的端到端效率。

它不展示“首 token 后 TPS”或逐 SSE token 的原始输出速度：本地日志没有可靠的逐 token 到达时间，使用这类值容易把长时间等待误显示为很高的吞吐。

完整定义、分位数和排查方法见 [指标解读](docs/metrics-guide.md)。

## 数据来源

| 工具 | 默认读取位置 | Turn 完成条件 |
| --- | --- | --- |
| Codex | `~/.codex/sessions/` | Codex 记录的完成事件 |
| Claude Code | `~/.claude/projects/` | 主会话的 `end_turn`；自动排除 `subagents/` |

Claude 未安装或尚无本地会话日志时会被自动跳过，不影响 Codex 监控。

## 安装

前置条件：macOS、Node.js 22+，以及用于菜单栏展示的 [SwiftBar](https://swiftbar.app/)。

```bash
npm install
npm run build
npm run install:swiftbar
```

最后一条命令会在 SwiftBar 插件目录创建指向本仓库插件文件的符号链接，不会覆盖已有的同名非本工具插件。SwiftBar 默认每 10 秒刷新一次。

## 界面

菜单栏始终展示最近完成的一轮，例如：

```text
Claude · TTFT 2.8s · TPS 12.5/s
```

展开后，最近 10 轮会明确标注 `Codex` 或 `Claude`。当天汇总分别展示两种来源的轮数、TTFT p50/p95 与 TPS p50/p5。

本地 HTML 报告展示昨天零点至当前的时序图和最近 50 轮。图中的 `● Codex` 与 `◆ Claude` 标记、表格来源列和悬停提示均可区分数据来源；报告表格展示真实会话 ID，菜单栏不展示。

## 本地命令

```bash
node bin/codex-latency.mjs status
node bin/codex-latency.mjs status --format json
node bin/codex-latency.mjs report --open
node bin/codex-latency.mjs doctor
```

运行时数据位于 `~/Library/Application Support/CodexLatencyMonitor/`。

## 验证

```bash
npm run lint
npm test
npm run test:integration
npm run test:e2e
```

自动化测试只使用临时目录和人工构造的脱敏 JSONL，不会读取真实会话。

完整架构、适配规则和测试策略见 [技术设计](docs/technical-design.md)。

## 许可证

[MIT License](LICENSE) © 2026 xuzhu-591。
