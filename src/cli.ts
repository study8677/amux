import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { watch } from "chokidar";
import { exists, resolveWorkspace, relToRoots, HOME_DIR } from "./core/paths.js";
import { loadConfig, saveConfig, CONFIG_FILE } from "./core/config.js";
import { log } from "./core/log.js";
import { fmtDateTime, truncate } from "./core/text.js";
import { getHarnesses } from "./harness/registry.js";
import { label } from "./core/compactor/rules.js";
import { ProjectStore } from "./core/store.js";
import { routeSessions } from "./core/router.js";
import { ActivityTracker, ACTIVE_WINDOW_MS } from "./core/activity.js";
import { discoverSessions, listContextProjects, projectForWorkspace, syncProjectContext, syncWorkspace } from "./core/engine.js";
import { syncProjects, loadRegistry, REGISTRY_FILE } from "./projects/sync.js";
import type { Action } from "./projects/reconcile.js";
import { setupGlobal, mcpCommand } from "./injectors/global-setup.js";
import { projectRuleBody, removeBlock, upsertBlock, writeWithBackup } from "./injectors/blocks.js";
import { ensureGitExclude } from "./collectors/git.js";
import { daemonPid, LOG_FILE, runDaemon, startDaemonDetached, stopDaemon } from "./daemon/daemon.js";

const program = new Command();
program
  .name("amux")
  .description("Agent Multiplexer — 在 Codex / Antigravity 等 AI 编程 Agent 之间同步项目与上下文")
  .version("0.1.0");

const short = (p: string) => (p.startsWith(HOME_DIR) ? "~" + p.slice(HOME_DIR.length) : p);
const cliPath = () => (process.argv[1]?.endsWith(".js") ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url));

function describeAction(a: Action): string {
  if (a.type === "create") return `${pc.green("+ 新建")} ${pc.bold(label(a.harness))} 「${a.name}」 ${pc.dim(a.roots.map(short).join(", "))}`;
  if (a.type === "update")
    return `${pc.yellow("~ 更新")} ${pc.bold(label(a.harness))} ${a.name ? `名称 → 「${a.name}」 ` : ""}${a.roots ? `根目录 → ${a.roots.map(short).join(", ")}` : ""}`;
  return `${pc.red("- 删除")} ${pc.bold(label(a.harness))} 「${a.name}」 ${pc.dim(a.reason)}`;
}

// ---------------- setup ----------------
program
  .command("setup")
  .description("一次性全局配置：写入全局规则块（~/.codex/AGENTS.md、~/.gemini/GEMINI.md），并在 Codex / Antigravity 注册 amux MCP")
  .option("--remove", "卸载全局规则块与 MCP 注册")
  .action((o) => {
    for (const s of setupGlobal({ remove: o.remove })) console.log(`${s.ok ? pc.green("✔") : pc.red("✘")} ${s.step}: ${pc.dim(s.detail)}`);
  });

// ---------------- projects ----------------
const projects = program.command("projects").description("跨工具的项目列表同步");
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
      const tag = e.excluded ? pc.yellow(" [排除]") : e.aliases?.length ? pc.dim(` [别名: ${e.aliases.map((a) => a.name).join(", ")}]`) : "";
      console.log(`  ${pc.bold(e.name)}${tag}\n    ${marks}\n    ${pc.dim(e.roots.map(short).join("  "))}`);
    }
    if (res.plan.actions.length) {
      console.log(pc.bold(`\n待同步操作（${res.plan.actions.length}）`));
      for (const a of res.plan.actions) console.log("  " + describeAction(a));
    }
    for (const s of res.plan.skipped) console.log(pc.dim(`  ⏭  ${s.name}：${s.reason}`));
  });

projects
  .command("sync")
  .description("对齐各工具的项目列表（默认预览；--yes 执行）")
  .option("--dry-run", "只预览，不写入（默认）")
  .option("-y, --yes", "确认执行（也确认被护栏暂停的删除）")
  .option("--no-propagate-deletes", "本次不传播删除")
  .action(async (o) => {
    const apply = !!o.yes && !o.dryRun;
    const res = await syncProjects({ apply, confirmDeletes: apply, propagateDeletes: o.propagateDeletes });
    const acts = res.plan.actions;
    if (!acts.length && !res.plan.heldDeletes.length) console.log(pc.green("✔ 各工具的项目列表已一致"));
    for (const a of acts) {
      const r = res.applied.find((x) => x.action === a);
      console.log(`  ${describeAction(a)}${r ? (r.ok ? pc.green("  ✔") : pc.red(`  ✘ ${r.error}`)) : ""}`);
    }
    for (const a of res.plan.heldDeletes) console.log(`  ${describeAction(a)} ${pc.yellow("（已暂停，需要 --yes 确认）")}`);
    for (const s of res.plan.skipped) console.log(pc.dim(`  ⏭  ${s.name}：${s.reason}`));
    if (!apply && acts.length) console.log(pc.cyan(`\n以上为预览。确认后执行：amux projects sync --yes`));
    for (const h of res.hints) console.log(pc.yellow(`ℹ ${h}`));
    if (apply) console.log(pc.dim(`registry: ${REGISTRY_FILE}`));
  });

projects
  .command("exclude <pathOrName>")
  .description("把某个项目（根目录或名称）加入排除列表")
  .action((v: string) => {
    const cfg = loadConfig();
    const val = v.includes("/") ? resolveWorkspace(v) : v;
    if (!cfg.projects.exclude.includes(val)) cfg.projects.exclude.push(val);
    saveConfig(cfg);
    console.log(pc.green(`✔ 已排除 ${val}`) + pc.dim(`  (${CONFIG_FILE})`));
  });

// ---------------- daemon ----------------
const daemon = program.command("daemon").description("全局后台守护进程（整台电脑的所有项目）");
daemon
  .command("start")
  .description("后台启动守护进程")
  .action(() => {
    const pid = daemonPid();
    if (pid) return console.log(pc.yellow(`守护进程已在运行（pid ${pid}）`));
    const np = startDaemonDetached(cliPath());
    console.log(pc.green(`✔ 守护进程已启动（pid ${np}）`) + pc.dim(`  日志：${LOG_FILE}  ·  amux daemon logs`));
  });
daemon
  .command("stop")
  .description("停止守护进程")
  .action(() => console.log(stopDaemon() ? pc.green("✔ 已发送停止信号") : pc.dim("守护进程未运行")));
daemon
  .command("status")
  .description("查看守护进程状态")
  .action(async () => {
    const pid = daemonPid();
    const reg = loadRegistry();
    console.log(pid ? pc.green(`● 运行中 pid ${pid}`) : pc.dim("○ 未运行"));
    console.log(`  项目同步：${reg.initialized ? pc.green("已初始化") : pc.yellow("未初始化（amux projects sync --yes）")} · ${reg.projects.length} 个统一项目`);
    console.log(`  Harness：${getHarnesses().map((h) => h.displayName).join(", ")}`);
    console.log(pc.dim(`  日志：${LOG_FILE}`));
  });
daemon
  .command("logs")
  .description("查看守护进程日志（-f 持续跟随）")
  .option("-f, --follow", "持续输出")
  .option("-n, --lines <n>", "行数", "40")
  .action((o) => {
    if (!exists(LOG_FILE)) return console.log(pc.dim("暂无日志"));
    const lines = fs.readFileSync(LOG_FILE, "utf8").trimEnd().split("\n");
    console.log(lines.slice(-Number(o.lines)).join("\n"));
    if (o.follow) {
      let size = fs.statSync(LOG_FILE).size;
      fs.watchFile(LOG_FILE, { interval: 500 }, (cur) => {
        if (cur.size > size) {
          const fd = fs.openSync(LOG_FILE, "r");
          const buf = Buffer.alloc(cur.size - size);
          fs.readSync(fd, buf, 0, buf.length, size);
          fs.closeSync(fd);
          process.stdout.write(buf.toString("utf8"));
        }
        size = cur.size;
      });
    }
  });
daemon
  .command("run")
  .description("前台运行守护进程（调试用）")
  .option("--quiet", "不输出到终端（只写日志）")
  .action(async (o) => {
    if (o.quiet) (await import("./core/log.js")).setQuiet(true);
    await runDaemon({ quiet: o.quiet });
  });

// ---------------- project scoped ----------------
program
  .command("init")
  .description("（可选）为当前项目挂载 AGENTS.md 标记块，并把 .amux/ 加入 .git/info/exclude")
  .option("-w, --workspace <path>", "项目路径（默认当前目录）")
  .option("--agents-rule", "额外生成 .agents/rules/amux-handoff.md")
  .option("--remove", "移除标记块")
  .action(async (o) => {
    const ws = resolveWorkspace(o.workspace);
    const agentsMd = path.join(ws, "AGENTS.md");
    const prev = exists(agentsMd) ? fs.readFileSync(agentsMd, "utf8") : "";
    writeWithBackup(agentsMd, o.remove ? removeBlock(prev) : upsertBlock(prev, projectRuleBody()));
    console.log(`${pc.green("✔")} AGENTS.md ${o.remove ? "标记块已移除" : "已挂载 amux 标记块"} ${pc.dim(agentsMd)}`);
    if (o.agentsRule && !o.remove) {
      const rule = path.join(ws, ".agents", "rules", "amux-handoff.md");
      fs.mkdirSync(path.dirname(rule), { recursive: true });
      fs.writeFileSync(rule, projectRuleBody() + "\n");
      ensureGitExclude(ws, ".agents/rules/amux-handoff.md");
      console.log(`${pc.green("✔")} ${pc.dim(rule)}`);
    }
    if (o.remove) return;
    console.log(ensureGitExclude(ws, ".amux/") ? `${pc.green("✔")} .git/info/exclude 已加入 .amux/` : pc.dim("· .git/info/exclude 已包含 .amux/（或非 git 仓库）"));
    const res = await syncWorkspace(ws, { onProgress: (d, t) => process.stdout.write(`\r${pc.dim(`  采集会话 ${d}/${t}`)}`) });
    process.stdout.write("\n");
    console.log(`${pc.green("✔")} 首次同步完成：${res.sessions} 个会话 → ${res.handoffFiles.map(short).join(", ") || "（暂无对话）"}`);
    const { command, args } = mcpCommand();
    console.log(pc.cyan(`\nMCP：执行 \`amux setup\` 一键注册；或手动 codex mcp add amux -- ${command} ${args.join(" ")}`));
  });

program
  .command("sync")
  .description("立即采集当前项目的对话并刷新 HANDOFF.md")
  .option("-w, --workspace <path>", "项目路径（默认当前目录）")
  .option("--dry-run", "只把 HANDOFF.md 输出到终端，不写任何文件")
  .action(async (o) => {
    const ws = resolveWorkspace(o.workspace);
    const t0 = Date.now();
    const res = await syncWorkspace(ws, {
      dryRun: o.dryRun,
      onProgress: (d, t) => process.stderr.write(`\r${pc.dim(`采集会话 ${d}/${t}`)}`),
    });
    process.stderr.write("\n");
    if (o.dryRun) {
      console.log(res.markdown ?? "");
      console.error(pc.dim(`(dry-run) ${res.project.name} · ${res.sessions} 个会话 · ${Object.entries(res.newEvents).map(([a, n]) => `${label(a)} ${n}`).join(" / ")} 条事件 · ${Date.now() - t0}ms`));
      return;
    }
    const parts = Object.entries(res.newTurns).map(([a, n]) => `[${label(a)} → amux] ${n} 轮新对话`);
    log("amux", `${res.project.name}：${parts.join("，") || "无新对话"}，${res.handoffFiles.length ? "HANDOFF.md 已同步" : "暂无可写入内容"}`);
  });

program
  .command("status")
  .description("打印当前项目的 HandoffState 摘要")
  .option("-w, --workspace <path>", "项目路径（默认当前目录）")
  .option("--json", "输出 JSON")
  .action(async (o) => {
    const ws = resolveWorkspace(o.workspace);
    const projectsList = await listContextProjects([ws]);
    const project = projectForWorkspace(ws, projectsList);
    const store = new ProjectStore(project.roots[0]);
    const s = store.loadState();
    if (o.json) return console.log(JSON.stringify(s, null, 2));
    if (!s) return console.log(pc.yellow(`${project.name}：尚无状态，先运行 amux sync`));
    console.log(pc.bold(`amux · ${project.name}`) + pc.dim(`  ${project.roots.map(short).join("  ")}`));
    console.log(`  上一个 Agent：${pc.cyan(s.lastActiveAgent ? label(s.lastActiveAgent) : "—")}   更新：${fmtDateTime(s.updatedAt)}   提取器：${s.compactor}`);
    console.log(`  会话：${Object.entries(s.stats.sessions).map(([k, v]) => `${label(k)} ${v}`).join(" / ")}`);
    console.log(pc.bold("\n🎯 当前目标"));
    console.log("  " + truncate(s.currentObjective, 400).replace(/\n/g, "\n  "));
    console.log(pc.bold(`\n⛔ Tried & Failed（${s.triedAndFailed.length}）`));
    for (const p of s.triedAndFailed.slice(0, 5)) console.log(`  - ${truncate(p.attempt, 100)} ${pc.dim("→ " + truncate(p.reason, 80))}`);
    console.log(pc.bold(`\n📂 热点文件（${s.activeFiles.length}）`));
    for (const f of s.activeFiles.slice(0, 8)) console.log(`  - ${f.path} ${pc.dim(`(${label(f.lastTouchedBy)}) ${truncate(f.intent, 60)}`)}`);
    console.log(pc.dim(`\n完整内容：${path.join(project.roots[0], ".amux", "HANDOFF.md")}`));
  });

program
  .command("watch")
  .alias("start")
  .description("前台实时监听当前项目（详细面板）")
  .option("-w, --workspace <path>", "项目路径（默认当前目录）")
  .action(async (o) => {
    const ws = resolveWorkspace(o.workspace);
    const cfg = loadConfig();
    const list = await listContextProjects([ws]);
    const project = projectForWorkspace(ws, list);
    const all = list.some((p) => p.key === project.key) ? list : [...list, project];
    console.log(pc.bold(`amux watch · ${project.name}`) + pc.dim(`  ${project.roots.map(short).join("  ")}`));
    const first = await syncProjectContext(project, routeSessions(discoverSessions(0), all).get(project.key) ?? []);
    log("amux", `初始同步：${first.sessions} 个会话，HANDOFF.md ${first.handoffFiles.length ? "已同步" : "暂无内容"}`);
    const tracker = new ActivityTracker();
    const recentMine = () => routeSessions(discoverSessions(Date.now() - ACTIVE_WINDOW_MS), all).get(project.key) ?? [];
    tracker.prime(recentMine());
    let timer: NodeJS.Timeout | null = null;
    let busy = false;
    const targets = [...new Set(getHarnesses().flatMap((h) => h.watchTargets()))].filter(exists);
    const w = watch([...targets, ...ActivityTracker.files(recentMine())], { ignoreInitial: true, depth: 1 });
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const recent = recentMine();
        w.add(ActivityTracker.files(recent));
        const changed = tracker.changed(recent);
        if (!changed.length) return;
        const res = await syncProjectContext(project, changed);
        const turns = Object.entries(res.newTurns);
        if (turns.length) for (const [a, n] of turns) log(`${label(a)} → amux`, `捕获 ${n} 轮新对话，HANDOFF.md 已同步`);
        else if (Object.keys(res.newEvents).length)
          log("amux", `${Object.entries(res.newEvents).map(([a, n]) => `${label(a)} ${n}`).join(" / ")} 条新事件，HANDOFF.md 已同步`);
      } catch (e) {
        log("amux", (e as Error).message, "error");
      } finally {
        busy = false;
      }
    };
    w.on("all", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, cfg.context.debounceMs);
    });
    setInterval(tick, 15000);
    log("amux", `监听中（静止 ${cfg.context.debounceMs / 1000}s 后触发增量更新）… Ctrl-C 退出`);
  });

program
  .command("mcp")
  .description("以 stdio 模式启动 MCP Server")
  .action(async () => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(pc.red(`amux: ${(e as Error).message}`));
  process.exit(1);
});

export { relToRoots };
