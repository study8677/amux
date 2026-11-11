import http from "node:http";
import { dashboardHtml } from "./page.js";
import { getDashboardStatus } from "./status.js";

export async function startDashboard(options: { port?: number } = {}): Promise<http.Server> {
  const port = options.port ?? 4317;
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? "") || request.headers["sec-fetch-site"] === "cross-site") {
      response.writeHead(403).end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/status" || pathname === "/healthz") {
      try {
        const status = getDashboardStatus();
        response.writeHead(pathname === "/healthz" && status.state !== "running" ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(status));
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "状态数据读取失败" }));
      }
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(dashboardHtml);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
