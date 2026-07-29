import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { formatSwiftBar, buildStatus } from "./status.js";
import { refreshSessions } from "../ingest/ingest.js";
import { writeReport } from "../report/report.js";
import { MonitorDatabase, defaultDatabasePath } from "../storage/database.js";

export async function runCli(argumentsList: string[], environment = process.env): Promise<string> {
  const command = argumentsList[0] ?? "status";
  const format = valueAfter(argumentsList, "--format") ?? "text";
  const sessionsDirectory = environment.CODEX_LATENCY_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions");
  const dataDirectory = environment.CODEX_LATENCY_DATA_DIR ?? join(homedir(), "Library", "Application Support", "CodexLatencyMonitor");
  await mkdir(dataDirectory, { recursive: true });
  const database = new MonitorDatabase(defaultDatabasePath(dataDirectory));

  try {
    if (command === "doctor") {
      return JSON.stringify(await doctor(sessionsDirectory, dataDirectory), null, 2);
    }

    const refreshResult = await refreshSessions(database, sessionsDirectory);
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
        ? `TTFT ${report.latest.ttftMs ?? "N/A"}ms · TPS ${report.latest.tps?.toFixed(1) ?? "N/A"}/s\n`
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

async function doctor(sessionsDirectory: string, dataDirectory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {
    node: process.version,
    sessionsDirectory,
    dataDirectory,
  };
  try {
    await access(sessionsDirectory);
    result.sessions = "ok";
  } catch {
    result.sessions = "不可读取";
  }
  return result;
}

function valueAfter(argumentsList: string[], flag: string): string | null {
  const index = argumentsList.indexOf(flag);
  return index >= 0 && typeof argumentsList[index + 1] === "string" ? argumentsList[index + 1] : null;
}

function usage(): string {
  return "用法：codex-latency <refresh|status|report|doctor> [--format text|json|swiftbar] [--open]\n";
}
