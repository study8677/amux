import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { AMUX_HOME, HOME_DIR } from "../core/paths.js";

const domain = () => `gui/${process.getuid!()}`;
const labels = { daemon: "com.amux.daemon", dashboard: "com.amux.dashboard" };
const plistPath = (kind: keyof typeof labels) => path.join(HOME_DIR, "Library", "LaunchAgents", `${labels[kind]}.plist`);
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Run installed artifacts independently of the development checkout and its permissions. */
export function prepareServiceRuntime(cliPath: string): string {
  const source = path.dirname(fs.realpathSync(cliPath));
  const dependency = path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json"));
  const hash = createHash("sha256");
  for (const file of fs.readdirSync(source).filter((name) => name.endsWith(".js")).sort()) {
    hash.update(file).update(fs.readFileSync(path.join(source, file)));
  }
  hash.update(fs.readFileSync(path.join(dependency, "package.json")));
  const runtime = path.join(AMUX_HOME, "runtime", hash.digest("hex").slice(0, 16));
  const destination = path.join(runtime, "dist", path.basename(cliPath));
  if (fs.existsSync(path.join(runtime, "ready"))) return destination;
  const temporary = `${runtime}-${process.pid}`;
  fs.mkdirSync(temporary, { recursive: true });
  fs.cpSync(source, path.join(temporary, "dist"), { recursive: true, dereference: true });
  fs.cpSync(dependency, path.join(temporary, "node_modules", "better-sqlite3"), { recursive: true, dereference: true });
  fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  fs.writeFileSync(path.join(temporary, "ready"), "ready\n");
  try { fs.renameSync(temporary, runtime); } catch (error) {
    if (!fs.existsSync(path.join(runtime, "ready"))) throw error;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return destination;
}

export function serviceInstalled(): boolean {
  return process.platform === "darwin" && fs.existsSync(plistPath("daemon"));
}

/** launchd owns restart and login startup. Each service has its own failure domain. */
export async function installServices(cliPath: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("后台保活服务目前支持 macOS");
  fs.mkdirSync(AMUX_HOME, { recursive: true });
  const installedCli = prepareServiceRuntime(cliPath);
  for (const kind of ["daemon", "dashboard"] as const) {
    const label = labels[kind];
    const args = [process.execPath, installedCli, ...(kind === "daemon" ? ["daemon", "run", "--quiet"] : ["dashboard"])];
    const env = { PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin", AMUX_HOME,
      ...Object.fromEntries(["CODEX_HOME", "AMUX_AGY_HOME", "AMUX_AGY_PROJECTS_DIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])) };
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(AMUX_HOME)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>StandardOutPath</key><string>${xml(path.join(AMUX_HOME, `${kind}-service.log`))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(AMUX_HOME, `${kind}-service.log`))}</string>
</dict></plist>\n`;
    const file = plistPath(kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    try { execFileSync("launchctl", ["bootout", `${domain()}/${label}`], { stdio: "pipe" }); } catch {}
    execFileSync("launchctl", ["enable", `${domain()}/${label}`]);
    // bootout returns before launchd necessarily releases the old service label.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        execFileSync("launchctl", ["bootstrap", domain(), file], { stdio: "pipe" });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

export function stopService(): void {
  if (!serviceInstalled()) return;
  execFileSync("launchctl", ["disable", `${domain()}/${labels.daemon}`]);
  try { execFileSync("launchctl", ["bootout", `${domain()}/${labels.daemon}`], { stdio: "pipe" }); } catch {}
}
