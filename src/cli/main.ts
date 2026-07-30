import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { formatSwiftBar, buildStatus } from "./status.js";
import { refreshClaudeSessions, refreshSessions } from "../ingest/ingest.js";
import { writeReport } from "../report/report.js";
import { MonitorDatabase, defaultDatabasePath } from "../storage/database.js";

export async function runCli(argumentsList: string[], environment = process.env): Promise<string> {
  const command = argumentsList[0] ?? "status";
  const format = valueAfter(argumentsList, "--format") ?? "text";
  const codexSessionsDirectory = environment.CODEX_LATENCY_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions");
  const claudeSessionsDirectory = environment.CODEX_LATENCY_CLAUDE_SESSIONS_DIR ?? join(homedir(), ".claude", "projects");
  const dataDirectory = environment.CODEX_LATENCY_DATA_DIR ?? join(homedir(), "Library", "Application Support", "CodexLatencyMonitor");
  await mkdir(dataDirectory, { recursive: true });
  const database = new MonitorDatabase(defaultDatabasePath(dataDirectory));

  try {
    if (command === "doctor") {
      return JSON.stringify(await doctor(codexSessionsDirectory, claudeSessionsDirectory, dataDirectory), null, 2);
    }

    const [codexRefresh, claudeRefresh] = await Promise.all([
      refreshSessions(database, codexSessionsDirectory),
      refreshClaudeSessions(database, claudeSessionsDirectory),
    ]);
    const refreshResult = {
      importedEvents: codexRefresh.importedEvents + claudeRefresh.importedEvents,
      diagnostics: [...codexRefresh.diagnostics, ...claudeRefresh.diagnostics],
    };
    const report = buildStatus(database, refreshResult.importedEvents, refreshResult.diagnostics);
    if (command === "refresh") {
      return JSON.stringify({ importedEvents: refreshResult.importedEvents, diagnostics: refreshResult.diagnostics }, null, 2);
    }
    if (command === "status") {
      if (format === "swiftbar") {
        return formatSwiftBar(report);
      }
      if (format === "json") {
        return JSON.stringify(report, null, 2);
      }
      return report.latest
        ? `${providerName(report.latest.provider)} · TTFT ${report.latest.ttftMs ?? "N/A"}ms · TPS ${report.latest.tps?.toFixed(1) ?? "N/A"}/s\n`
        : "暂无完成 Turn\n";
    }
    if (command === "report") {
      const path = writeReport(dataDirectory, report);
      if (argumentsList.includes("--open") && environment.CODEX_LATENCY_NO_OPEN !== "1") {
        execFileSync("open", [path], { stdio: "ignore" });
      }
      return `${path}\n`;
    }
    return usage();
  } finally {
    database.close();
  }
}

async function doctor(
  codexSessionsDirectory: string,
  claudeSessionsDirectory: string,
  dataDirectory: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {
    node: process.version,
    codexSessionsDirectory,
    claudeSessionsDirectory,
    dataDirectory,
  };
  result.codexSessions = await directoryStatus(codexSessionsDirectory);
  result.claudeSessions = await directoryStatus(claudeSessionsDirectory, true);
  return result;
}

async function directoryStatus(path: string, optional = false): Promise<string> {
  try {
    await access(path);
    return "ok";
  } catch {
    return optional ? "未发现" : "不可读取";
  }
}

function providerName(provider: "codex" | "claude"): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function valueAfter(argumentsList: string[], flag: string): string | null {
  const index = argumentsList.indexOf(flag);
  return index >= 0 && typeof argumentsList[index + 1] === "string" ? argumentsList[index + 1] : null;
}

function usage(): string {
  return "用法：codex-latency <refresh|status|report|doctor> [--format text|json|swiftbar] [--open]\n";
}
