# Codex Latency Monitor

在 macOS 菜单栏被动查看本机 Codex Turn 的 TTFT 与 TPS。

它只读取本机 `~/.codex/sessions/` 的 JSONL，会话正文、工具输入输出和工作区路径都不会写入数据库、报告或菜单栏；不会发探针、修改 Codex 配置或请求外部服务。

## 指标

- **TTFT**：Codex 记录的首 token 等待时间。
- **TPS**：Turn 内的模型输出 token，总计除以首 token 到 Turn 完成的时长。工具等待保留在该时长中，因此它反映实际体感。
- 工具时间扣减 TPS 和逐 SSE token 吞吐不在本工具范围内。

## 前置条件

- macOS
- Node.js 22 或更高版本
- [SwiftBar](https://swiftbar.app/)（仅菜单栏展示需要）

## 安装

```bash
npm install
npm run build
npm run install:swiftbar
```

最后一条命令会在 SwiftBar 插件目录创建指向本仓库插件文件的符号链接，不会覆盖已有的同名非本工具插件。打开 SwiftBar 后，菜单栏会每 10 秒刷新一次。

## 本地命令

```bash
node bin/codex-latency.mjs status
node bin/codex-latency.mjs status --format json
node bin/codex-latency.mjs report --open
node bin/codex-latency.mjs doctor
```

运行时数据位于：`~/Library/Application Support/CodexLatencyMonitor/`。

本地 HTML 报告会展示昨天零点至当前的完成 Turn 的 TTFT 与 TPS 时序图；将鼠标悬停在采样点上可查看完成时间和指标值。报告表格展示真实会话 ID，不出现在菜单栏。

## 验证

```bash
npm run lint
npm test
npm run test:integration
npm run test:e2e
```

端到端测试使用临时目录和人工构造的脱敏 JSONL，不会读取真实会话。

完整架构、数据边界和测试策略见 [技术设计](docs/technical-design.md)。

## 许可证

[MIT License](LICENSE) © 2026 xuzhu-591。
