import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { resolveWorkspace, HOME_DIR } from "./core/paths.js";
import { loadConfig, saveConfig, CONFIG_FILE } from "./core/config.js";
import { getHarnesses } from "./harness/registry.js";
import { label } from "./core/compactor/rules.js";
import { syncProjects, loadRegistry, REGISTRY_FILE } from "./projects/sync.js";
import type { Action } from "./projects/reconcile.js";
import { daemonPid, HEALTH_FILE, LOG_FILE, runDaemon, startDaemonDetached, stopDaemon } from "./daemon/daemon.js";
import { mirrorLatestSession, reconcileMirrorDuplicates } from "./mirror/index.js";
import { installServices, serviceInstalled, stopService } from "./daemon/service.js";
import { startDashboard } from "./dashboard/index.js";
import { getDashboardStatus } from "./dashboard/status.js";
import { readJson } from "./core/jsonl.js";

const short = (p: string) => (p.startsWith(HOME_DIR) ? "~" + p.slice(HOME_DIR.length) : p);

const program = new Command();
program
  .name("amux")
  .description("Agent Multiplexer — 在 OpenAI Codex 与 Google Antigravity 之间双向克隆原生会话与同步项目")
  .version("0.1.0");

const cliPath = () => (process.argv[1]?.endsWith(".js") ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url));

function describeAction(a: Action): string {
  if (a.type === "create") return `${pc.green("+ 新建")} ${pc.bold(label(a.harness))} 「${a.name}」 ${pc.dim(a.roots.map(short).join(", "))}`;
  if (a.type === "update")
    return `${pc.yellow("~ 更新")} ${pc.bold(label(a.harness))} ${a.name ? `名称 → 「${a.name}」 ` : ""}${a.roots ? `根目录 → ${a.roots.map(short).join(", ")}` : ""}`;
  return `${pc.red("- 删除")} ${pc.bold(label(a.harness))} 「${a.name}」 ${pc.dim(a.reason)}`;
}

// ---------------- mirror (核心命令) ----------------
program
  .command("mirror")
  .description("将当前项目最新的对话完整克隆到另一款 Agent（去除 ls/cat 等工具噪音，生成原生会话气泡）")
  .option("-w, --workspace <path>", "工作区目录（默认为当前目录）", process.cwd())
  .option("-a, --all", "对本机所有项目执行一次性全量会话镜像")
  .option("--to <agent>", "目标 Agent: codex 或 antigravity（不填则自动识别反向注入）")
  .option("--from <agent>", "源 Agent: codex 或 antigravity")
  .action(async (o) => {
    const { listContextProjects } = await import("./core/engine.js");
    if (o.all) {
      console.log(pc.bold(`amux mirror --all`) + pc.dim(` · 正在对本机所有项目执行全量会话克隆...`));
      const cleaned = await reconcileMirrorDuplicates().catch(() => ({ antigravityDeleted: 0, codexArchived: 0 }));
      if (cleaned.antigravityDeleted > 0 || cleaned.codexArchived > 0) {
        console.log(`  ${pc.cyan("✦")} 已清理历史重复镜像会话 (Antigravity: ${cleaned.antigravityDeleted}, Codex: ${cleaned.codexArchived})`);
      }
      const projects = await listContextProjects();
      let successCount = 0;
      for (const p of projects) {
        if (!p.roots.length) continue;
        const root = p.roots[0];
        try {
          const res = await mirrorLatestSession({
            workspacePath: root,
            source: o.from,
            target: o.to,
          });
          if (!res.skipped) {
            successCount++;
            const targetLabel = res.targetAgent === "codex" ? "Codex" : "Antigravity";
            console.log(`  ${pc.green("✔")} [${p.name}] 成功克隆到 ${targetLabel}「${res.title}」(${res.turnCount} 轮)`);
          }
        } catch (e) {
          // Skip projects without valid active sessions
        }
      }
      console.log(pc.green(`\n✔ 全量镜像完成！共新增/更新 ${successCount} 个项目的会话。`));
      return;
    }

    const ws = resolveWorkspace(o.workspace);
    try {
      console.log(pc.bold(`amux mirror`) + pc.dim(` · 正在分析工作区: ${short(ws)}`));
      await reconcileMirrorDuplicates().catch(() => {});
      const res = await mirrorLatestSession({
        workspacePath: ws,
        source: o.from,
        target: o.to,
      });
      const targetLabel = res.targetAgent === "codex" ? "OpenAI Codex" : "Google Antigravity";
      if (res.skipped) {
        console.log(`${pc.green("✔")} 当前最新会话已在 ${pc.bold(targetLabel)} 中同步，无需重复创建镜像`);
      } else {
        console.log(`${pc.green("✔")} 镜像克隆成功！已注入到 ${pc.bold(targetLabel)}`);
      }
      console.log(`  · 会话标题: ${pc.cyan(res.title)}`);
      console.log(`  · 提纯轮次: ${pc.yellow(res.turnCount.toString())} 轮 (已剥离所有系统提示词与 ls/cat 工具噪音)`);
      console.log(`  · 会话 ID: ${pc.dim(res.targetSessionId)}`);
      if (res.targetAgent === "codex") {
        console.log(`  ${pc.dim("👉 打开 Codex Desktop 即可在左侧列表看到该会话，直接输入继续交流！")}`);
      } else {
        console.log(`  ${pc.dim("👉 打开 Antigravity 即可在历史列表看到该会话，直接输入继续交流！")}`);
      }
    } catch (e) {
      console.error(pc.red(`镜像失败: ${(e as Error).message}`));
      process.exit(1);
    }
  });

// ---------------- projects ----------------
const projects = program.command("projects").description("跨工具的项目列表双向同步");
projects
  .command("list")
  .description("查看各工具的项目及配对关系")
  .action(async () => {
    const res = await syncProjects({ apply: false });
    const reg = loadRegistry();
    console.log(pc.bold(`统一项目（${res.plan.registry.length}）`) + pc.dim(reg.initialized ? "" : "  · 尚未初始化，以下为预览"));
    const hs = getHarnesses().filter((h) => h.projects);
    for (const e of res.plan.registry) {
      const marks = hs.map((h) => (e.ids[h.id] ? pc.green(`✔ ${h.displayName}`) : pc.dim(`· ${h.displayName}`))).join("  ");
      console.log(`  ${marks}  ${pc.bold(e.name)}  ${pc.dim(e.roots.map(short).join(", "))}`);
    }
    if (res.plan.skipped.length) {
      console.log(pc.yellow(`\n跳过的项目（${res.plan.skipped.length}）：`));
      for (const item of res.plan.skipped) console.log(`  ${item.name}  ${pc.dim(item.reason)}`);
    }
    if (res.plan.actions.length) {
      console.log(pc.cyan(`\n待执行变更（${res.plan.actions.length}）：`));
      for (const a of res.plan.actions) console.log(`  ${describeAction(a)}`);
      console.log(pc.dim("\n执行 `amux projects sync --yes` 应用变更"));
    } else {
      console.log(pc.green("\n✔ 两端项目已完全对齐，无需操作。"));
    }
  });

projects
  .command("sync")
  .description("执行双向同步，把两端的项目对齐到一致")
  .option("-y, --yes", "自动确认执行所有安全变更")
  .option("--dry-run", "仅预览，不写入任何修改")
  .action(async (o) => {
    const res = await syncProjects({ apply: !o.dryRun && !!o.yes });
    console.log(pc.bold(`项目对齐计划 · 共 ${res.plan.actions.length} 项变更`) + (o.dryRun ? pc.dim(" (预览)") : ""));
    for (const a of res.plan.actions) console.log(`  ${describeAction(a)}`);
    if (res.plan.heldDeletes.length) {
      console.log(pc.red(`\n安全保护：以下 ${res.plan.heldDeletes.length} 个删除操作超过单次阈值，已被暂停：`));
      for (const a of res.plan.heldDeletes) console.log(`  ${describeAction(a)}`);
      console.log(pc.yellow("请手动确认无误后传入 `--yes` 强制执行。"));
    }
    if (res.applied) {
      console.log(pc.green(`\n✔ 已成功应用变更，统一注册表已写入 ${short(REGISTRY_FILE)}`));
      for (const h of res.hints) console.log(`  ${pc.dim(h)}`);
    } else if (!o.dryRun && !o.yes && res.plan.actions.length) {
      console.log(pc.yellow("\n提示：未传入 `--yes`，未写入任何更改。确认请执行：\n  amux projects sync --yes"));
    }
  });

// ---------------- daemon ----------------
const daemon = program.command("daemon").description("全局后台守护进程（自动监听并双向克隆会话 + 项目对齐）");
daemon
  .command("start")
  .description("在后台启动常驻守护进程")
  .action(async () => {
    const pid = daemonPid();
    if (pid && !serviceInstalled()) {
      stopDaemon();
      for (let i = 0; i < 30 && daemonPid(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      if (daemonPid()) throw new Error("旧后台进程仍在退出，请稍后重试");
    }
    if (process.platform === "darwin") await installServices(cliPath());
    else if (!pid) startDaemonDetached(cliPath());
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const health = readJson<{ pid?: number; heartbeatAt?: string }>(HEALTH_FILE, {});
      if (daemonPid() === health.pid && Date.now() - Date.parse(health.heartbeatAt ?? "") < 5000) {
        console.log(pc.green(`✔ amux 后台运行中 (PID: ${health.pid})`));
        console.log(pc.dim(process.platform === "darwin" ? "  已启用登录启动和异常退出自动恢复" : "  已启动后台进程"));
        console.log("  状态页面 http://127.0.0.1:4317");
        return;
      }
    }
    throw new Error(`启动后未收到健康心跳，请查看 ${LOG_FILE}`);
  });

daemon
  .command("stop")
  .description("停止后台守护进程")
  .action(() => {
    const wasRunning = !!daemonPid();
    stopService();
    const ok = stopDaemon() || wasRunning;
    if (ok) console.log(pc.green("✔ amux daemon 已停止"));
    else console.log(pc.yellow("amux daemon 未在运行"));
  });

daemon
  .command("status")
  .description("查看后台守护进程状态")
  .action(() => {
    const status = getDashboardStatus();
    const labels = { running: "后台心跳正常", degraded: "后台需要检查", stopped: "后台已停止" };
    console.log(`${status.state === "running" ? "●" : "○"} amux ${labels[status.state]}`);
    if (status.pid) console.log(`  PID ${status.pid}`);
    if (status.health.lastError) console.log(`  最近错误 ${status.health.lastError}`);
    console.log("  状态页面 http://127.0.0.1:4317");
    console.log(pc.dim(`  日志 ${short(LOG_FILE)}`));
  });

daemon
  .command("log")
  .description("查看最近运行日志")
  .option("-n, --lines <n>", "显示行数", "30")
  .action((o) => {
    if (!fs.existsSync(LOG_FILE)) {
      console.log(pc.dim("暂无日志"));
      return;
    }
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.trim().split("\n");
    const count = parseInt(o.lines, 10) || 30;
    console.log(lines.slice(-count).join("\n"));
  });

daemon
  .command("run")
  .description("前台直接运行守护进程（开发/调试用）")
  .option("-q, --quiet", "静默模式，只写日志文件")
  .action(async (o) => {
    await runDaemon({ quiet: !!o.quiet });
  });

program.command("dashboard")
  .description("启动本机运行状态页")
  .option("--port <port>", "监听端口", "4317")
  .action(async (options) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 到 65535 的整数");
    await startDashboard({ port });
    console.log(`amux 状态页面 http://127.0.0.1:${port}`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(pc.red(`amux: ${(e as Error).message}`));
  process.exit(1);
});
