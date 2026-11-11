import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ANTIGRAVITY_APP_DATA } from '../core/paths.js';

interface Endpoint { pid: number; httpPort: number; csrfToken: string }

/** Use the running app's own loopback endpoint, bypassing outbound proxy settings. */
export function antigravityRequest<T = any>(method: string, body: unknown): Promise<T> {
  const dir = path.join(ANTIGRAVITY_APP_DATA, 'daemon');
  let endpoint: Endpoint | undefined;
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^hub_\d+\.json$/.test(file)) continue;
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Endpoint;
      process.kill(candidate.pid, 0);
      if (Number.isInteger(candidate.httpPort) && candidate.httpPort > 0 && candidate.csrfToken) endpoint = candidate;
    } catch { /* A stale endpoint is expected after an app restart. */ }
  }
  if (!endpoint) throw new Error('Antigravity 未运行，等待应用启动后重试原生镜像');
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: endpoint.httpPort, method: 'POST',
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': endpoint.csrfToken, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Antigravity ${method} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`Antigravity ${method} 超时`)));
    req.on('error', reject);
    req.end(payload);
  });
}
