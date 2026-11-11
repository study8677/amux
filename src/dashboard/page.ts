export const dashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>amux · 运行状态</title>
<style>
:root{color-scheme:dark;--bg:#111519;--panel:#191e23;--line:#2c333a;--text:#edf1f3;--muted:#9aa6af;--green:#90d8bc;--yellow:#edc684;--red:#ed9c96}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 Inter,"PingFang SC","Microsoft YaHei",sans-serif}button,input{font:inherit}button{cursor:pointer}aside{position:fixed;inset:0 auto 0 0;width:218px;border-right:1px solid var(--line);padding:30px 22px;background:#151a1f;display:flex;flex-direction:column}.brand{font-size:30px;letter-spacing:-1.8px;font-weight:700}.brand span{color:var(--green)}.subtitle{color:var(--muted);font-size:11px;letter-spacing:1.8px;margin:1px 0 45px}nav{display:grid;gap:7px}nav button{text-align:left;border:0;border-radius:7px;background:transparent;padding:12px 14px;color:var(--muted)}nav button.active{background:#263930;color:#b2e6cf}nav button:hover{background:#252c32}.nav-symbol{margin-right:12px;display:inline-block;width:16px}.aside-bottom{margin-top:auto;color:var(--muted);font-size:12px}.local-dot{display:inline-block;width:6px;height:6px;border-radius:100%;background:var(--green);margin-right:8px}.aside-bottom code{display:block;margin-top:6px;font:11px/1.7 "SFMono-Regular",Consolas,monospace;color:#71808c}main{margin-left:218px;max-width:1630px;padding:34px 42px 28px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}.eyebrow{font-size:11px;color:var(--muted);letter-spacing:1.7px}.title{font-size:25px;font-weight:550;letter-spacing:-.7px;margin:5px 0 0}.tools{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--muted)}button.refresh{border:1px solid #3a454e;border-radius:6px;background:#20272d;color:var(--text);padding:7px 13px}button:focus-visible,input:focus-visible{outline:2px solid var(--green);outline-offset:3px}.hero{border:1px solid #385044;border-radius:10px;padding:28px 30px;background:linear-gradient(110deg,#1d3028,#1b2425 80%);display:flex;gap:23px;align-items:center}.hero.degraded{background:linear-gradient(110deg,#352d20,#252522);border-color:#66553a}.hero.stopped{background:linear-gradient(110deg,#322629,#242226);border-color:#66484b}.signal{flex:0 0 48px;height:48px;border:1px solid #5c977d;border-radius:100%;display:grid;place-items:center;color:var(--green);font-size:23px}.hero.degraded .signal{color:var(--yellow);border-color:#917748}.hero.stopped .signal{color:var(--red);border-color:#916467}.hero h2{font-size:22px;font-weight:550;margin:0 0 5px}.hero p{color:#a9bbb2;margin:0;font-size:13px}.hero.degraded p,.hero.stopped p{color:#c0b3ad}.live-tag{margin-left:auto;white-space:nowrap;font:11px "SFMono-Regular",Consolas,monospace;color:var(--green);border:1px solid #456650;border-radius:5px;padding:6px 10px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 32px}.stat{padding:20px 22px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.stat-label{color:var(--muted);font-size:12px}.stat-value{font-size:26px;font-weight:500;line-height:1.4;margin:9px 0 3px;letter-spacing:-.5px}.stat-note{font-size:11px;color:var(--muted)}.overview-grid{display:grid;grid-template-columns:minmax(0,1fr) 294px;gap:22px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}h3{font-size:15px;font-weight:550;margin:0}.small-label{font-size:11px;color:var(--muted)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}.event{padding:17px 20px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:13px}.event:last-child{border-bottom:0}.event-mark{border:1px solid #426653;color:var(--green);border-radius:50%;width:25px;height:25px;display:grid;place-items:center;flex:0 0 25px;font-size:12px;margin-top:3px}.event-mark.error{border-color:#855b56;color:var(--red)}.event-mark.historical{border-color:#4c5963;color:var(--muted)}.event-main{flex:1;min-width:0}.event-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event-meta{font-size:11px;color:var(--muted);margin-top:4px;display:flex;flex-wrap:wrap;gap:10px}.event-time{font-size:11px;color:var(--muted);white-space:nowrap;padding-top:3px}.event-error{font-size:12px;color:var(--red);margin-top:6px;overflow-wrap:anywhere}.flow{padding:21px}.agent{display:flex;align-items:center;gap:11px}.agent-icon{width:34px;height:34px;border:1px solid #49565e;border-radius:8px;display:grid;place-items:center;color:#ced8df;font:16px "SFMono-Regular",Consolas,monospace}.agent small{display:block;font-size:11px;color:var(--muted)}.flow-line{margin:12px 0 12px 16px;border-left:1px dashed #557367;padding:7px 0 7px 28px;color:var(--green);font-size:11px}.flow-note{margin:20px 0 0;border-top:1px solid var(--line);padding-top:15px;color:var(--muted);font-size:11px}.detail{padding:18px 21px}.detail-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:8px 0}.detail-row span:first-child{color:var(--muted)}.detail-row span:last-child{text-align:right;overflow-wrap:anywhere}.side-section{margin-top:24px}.empty{padding:36px 22px;color:var(--muted);text-align:center;font-size:13px}.warning{margin-top:15px;padding:12px 16px;border:1px solid #66553a;background:#2b271f;border-radius:6px;color:var(--yellow);font-size:12px;overflow-wrap:anywhere}footer{display:flex;justify-content:space-between;gap:15px;margin-top:30px;color:#798690;font-size:11px;border-top:1px solid var(--line);padding-top:17px}.view[hidden]{display:none}.search{background:var(--panel);border:1px solid #3a454e;border-radius:6px;color:var(--text);padding:8px 12px;min-width:230px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:15px 19px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:11px;font-weight:500}tr:last-child td{border-bottom:0}td.path{color:var(--muted);font:11px/1.7 "SFMono-Regular",Consolas,monospace;max-width:420px;overflow-wrap:anywhere}.badge{color:var(--green);font-size:11px}.badge.warn{color:var(--yellow)}pre{margin:0;padding:22px;max-height:65vh;overflow:auto;color:#aebdc7;font:11px/1.9 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.table-scroll{overflow-x:auto}.connection-error{color:var(--red)}@media(max-width:1200px){main{padding:30px 25px}.overview-grid{grid-template-columns:minmax(0,1fr) 255px}aside{width:185px}main{margin-left:185px}.stat{padding:17px}.stat-value{font-size:23px}.tools{gap:8px}}@media(max-width:960px){.overview-grid{grid-template-columns:1fr}.side-panels{display:grid;grid-template-columns:1fr 1fr;gap:20px}.side-section{margin-top:0}.stats{grid-template-columns:repeat(2,1fr)}.live-tag{display:none}}@media(max-width:680px){aside{position:static;width:100%;padding:15px 20px;display:block;border-right:0;border-bottom:1px solid var(--line)}.brand{font-size:26px}.subtitle,.aside-bottom{display:none}nav{display:flex;margin-top:12px;gap:4px}nav button{font-size:12px;padding:8px 10px}.nav-symbol{display:none}main{margin:0;padding:23px 18px}header{align-items:flex-start;margin-bottom:24px}.title{font-size:22px}.tools{flex-direction:column;align-items:flex-end;font-size:10px;gap:7px}.hero{padding:23px 18px;gap:14px}.hero h2{font-size:18px}.hero p{font-size:12px}.signal{flex-basis:38px;height:38px;font-size:19px}.stats{gap:10px;margin:16px 0 25px}.stat{padding:15px}.stat-value{font-size:23px}.side-panels{display:block}.side-section{margin-top:22px}.event{padding:15px 13px;gap:9px}.event-time{font-size:10px}.event-title{max-width:210px}.section-head{flex-wrap:wrap}.search{min-width:0;width:100%}footer{flex-direction:column;gap:4px}}
</style>
</head>
<body>
<aside><div class="brand">amux<span>.</span></div><div class="subtitle">AGENT MULTIPLEXER</div><nav aria-label="主导航"><button class="active" data-view="overview"><span class="nav-symbol">◈</span>运行概览</button><button data-view="events"><span class="nav-symbol">⇄</span>同步记录</button><button data-view="projects"><span class="nav-symbol">▦</span>项目列表</button><button data-view="logs"><span class="nav-symbol">≡</span>运行日志</button></nav><div class="aside-bottom"><span class="local-dot"></span>本机工作空间<code id="local-address">127.0.0.1</code></div></aside>
<main>
<header><div><div class="eyebrow">WORKSPACE / SYSTEM STATUS</div><h1 class="title" id="page-title">运行概览</h1></div><div class="tools"><span id="refresh-label" aria-live="polite">正在连接本机服务</span><button class="refresh" id="refresh">↻ 刷新</button></div></header>
<section id="view-overview" class="view">
<div id="hero" class="hero stopped" role="status"><div class="signal" id="signal">…</div><div><h2 id="state-title">正在读取运行状态</h2><p id="state-description">读取后台心跳与同步记录</p></div><span class="live-tag" id="live-tag">LOCAL</span></div>
<div class="stats"><div class="stat"><div class="stat-label">已配对项目</div><div class="stat-value" id="project-count">—</div><div class="stat-note" id="project-note">读取项目注册表</div></div><div class="stat"><div class="stat-label">最近同步写入</div><div class="stat-value" id="last-sync">—</div><div class="stat-note" id="sync-note">读取镜像记录</div></div><div class="stat"><div class="stat-label">本次启动成功 / 失败</div><div class="stat-value" id="sync-count">—</div><div class="stat-note" id="job-note">读取任务状态</div></div><div class="stat"><div class="stat-label">后台心跳</div><div class="stat-value" id="heartbeat">—</div><div class="stat-note" id="heartbeat-note">每 5 秒刷新状态</div></div></div>
<div class="overview-grid"><section><div class="section-head"><h3>最近同步</h3><span class="small-label">按发生时间排列</span></div><div class="panel" id="recent-events"></div></section><div class="side-panels"><section><div class="section-head"><h3>同步通道</h3></div><div class="panel flow"><div class="agent"><div class="agent-icon">C</div><div>OpenAI Codex<small>本机会话</small></div></div><div class="flow-line">⇅ 双向镜像</div><div class="agent"><div class="agent-icon">A</div><div>Google Antigravity<small>本机会话</small></div></div><p class="flow-note">同步写入与原生读回校验分别记录。模型续聊需通过实际对话验证。</p></div></section><section class="side-section"><div class="section-head"><h3>进程详情</h3></div><div class="panel detail" id="process-details"></div></section></div></div>
</section>
<section id="view-events" class="view" hidden><div class="section-head"><h3>同步记录</h3><input class="search" id="event-search" type="search" placeholder="搜索会话、项目或错误" aria-label="搜索同步记录"></div><div class="panel" id="all-events"></div></section>
<section id="view-projects" class="view" hidden><div class="section-head"><h3>项目配对情况</h3><input class="search" id="project-search" type="search" placeholder="搜索项目名称或目录" aria-label="搜索项目"></div><div class="panel table-scroll"><table><thead><tr><th>项目</th><th>工作目录</th><th>Codex</th><th>Antigravity</th><th>同步范围</th></tr></thead><tbody id="project-rows"></tbody></table></div></section>
<section id="view-logs" class="view" hidden><div class="section-head"><h3>后台运行日志</h3><span class="small-label">最近 30 行</span></div><div class="panel"><pre id="logs">正在读取日志</pre></div></section>
<div id="warnings" hidden class="warning" role="alert"></div>
<footer><span>amux · 本地状态面板</span><span id="checked-at">等待首次刷新</span></footer>
</main>
<script>
const byId = (id) => document.getElementById(id);
const names = { codex: 'Codex', antigravity: 'Antigravity' };
let snapshot = null;
let refreshing = false;
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '暂无记录';
const time = (value) => value ? new Date(value).toLocaleTimeString('zh-CN', {hour12:false}) : '—';
function age(value) {
  if (!value) return '暂无记录';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return seconds + ' 秒前';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  return Math.floor(seconds / 86400) + ' 天前';
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function renderEvents(container, events) {
  container.replaceChildren();
  if (!events.length) { container.append(node('div', 'empty', '暂无匹配的同步记录')); return; }
  for (const event of events) {
    const row = node('div', 'event');
    const status = { success:'已写入', error:'同步失败', skipped:'内容相同，已跳过', historical:'历史写入记录' }[event.status] || event.status;
    row.append(node('span', 'event-mark ' + event.status, event.status === 'error' ? '!' : event.status === 'historical' ? '↗' : '✓'));
    const main = node('div', 'event-main');
    const title = node('div', 'event-title', event.title || event.workspacePath || '会话 ' + (event.sourceSessionId || '').slice(0, 8));
    title.title = event.title || event.workspacePath || '';
    main.append(title);
    const meta = node('div', 'event-meta');
    meta.append(node('span', '', (names[event.sourceAgent] || '来源待记录') + ' → ' + (names[event.targetAgent] || '目标待记录')));
    meta.append(node('span', '', status));
    if (event.nativeReadbackVerified === true) meta.append(node('span', 'badge', '原生读回已验证'));
    if (event.turnCount !== undefined) meta.append(node('span', '', event.turnCount + ' 条消息'));
    main.append(meta);
    if (event.error) main.append(node('div', 'event-error', event.error));
    row.append(main);
    const timestamp = node('time', 'event-time', age(event.timestamp));
    timestamp.title = date(event.timestamp);
    row.append(timestamp);
    container.append(row);
  }
}
function renderLists() {
  if (!snapshot) return;
  const query = byId('event-search').value.toLocaleLowerCase();
  renderEvents(byId('all-events'), snapshot.events.filter((event) => JSON.stringify(event).toLocaleLowerCase().includes(query)));
  const projectQuery = byId('project-search').value.toLocaleLowerCase();
  const projects = snapshot.projects.filter((project) => (project.name + ' ' + project.roots.join(' ')).toLocaleLowerCase().includes(projectQuery));
  byId('project-rows').replaceChildren();
  for (const project of projects) {
    const row = node('tr');
    row.append(node('td', '', project.name), node('td', 'path', project.roots.join('\n')));
    row.append(node('td', project.codex ? 'badge' : 'badge warn', project.codex ? '已登记' : '待配对'));
    row.append(node('td', project.antigravity ? 'badge' : 'badge warn', project.antigravity ? '已登记' : '待配对'));
    row.append(node('td', project.excluded ? 'small-label' : 'badge', project.excluded ? '已排除' : '已启用'));
    byId('project-rows').append(row);
  }
  if (!projects.length) { const row = node('tr'); const cell = node('td','empty','暂无匹配项目'); cell.colSpan=5; row.append(cell); byId('project-rows').append(row); }
}
function render(data) {
  snapshot = data;
  const health = data.health;
  const states = {
    running: ['后台正在运行', '心跳正常，正在监听本机会话变化。', '✓'],
    stopped: ['后台已停止', '自动同步当前已停止，可通过 amux daemon start 启动。', 'Ⅱ'],
    degraded: ['后台需要关注', data.unresolvedErrors.length ? data.unresolvedErrors.length + ' 个同步通道仍有失败待恢复。' : health.lastError || '进程存在，健康心跳待恢复。', '!']
  };
  const state = states[data.state] || states.degraded;
  byId('hero').className = 'hero ' + data.state;
  byId('signal').textContent = state[2];
  byId('state-title').textContent = state[0];
  byId('state-description').textContent = state[1];
  byId('live-tag').textContent = data.state === 'running' ? '● LIVE' : data.state.toUpperCase();
  const enabled = data.projects.filter((project) => !project.excluded);
  byId('project-count').textContent = enabled.filter((project) => project.codex && project.antigravity).length;
  byId('project-note').textContent = enabled.length + ' 个启用项目 · ' + data.projects.length + ' 个已登记';
  byId('last-sync').textContent = data.lastMirrorAt ? age(data.lastMirrorAt) : '暂无记录';
  byId('sync-note').textContent = data.lastMirrorAt ? date(data.lastMirrorAt) : '等待首次同步写入';
  byId('sync-count').textContent = (health.syncCount ?? 0) + ' / ' + (health.errorCount ?? 0);
  byId('job-note').textContent = (health.activeJobs ?? 0) + ' 个任务执行中';
  byId('heartbeat').textContent = health.heartbeatAt ? age(health.heartbeatAt) : '暂无心跳';
  byId('heartbeat-note').textContent = data.alive ? 'PID ' + data.pid : '后台进程已停止';
  const details = [['进程', data.pid || '已停止'], ['启动时间', health.startedAt ? time(health.startedAt) : '暂无记录'], ['最近扫描', health.lastScanAt ? time(health.lastScanAt) : '暂无记录'], ['项目对齐', data.registryInitialized ? '已初始化' : '待初始化'], ['原生读回', data.events.filter((event) => event.nativeReadbackVerified === true).length + ' 条已验证记录'], ['最近续聊验收', data.verification?.modelContinuation && data.verification?.persistedReply && data.verification?.independentReload ? time(data.verification.verifiedAt) + ' 已通过，回复已落盘并独立重载' : '待完成']];
  byId('process-details').replaceChildren();
  for (const pair of details) { const row = node('div', 'detail-row'); row.append(node('span','',pair[0]),node('span','',pair[1])); byId('process-details').append(row); }
  renderEvents(byId('recent-events'), data.events.slice(0, 7));
  renderLists();
  byId('logs').textContent = data.logs.length ? data.logs.join('\n') : '暂无后台日志';
  byId('warnings').hidden = !data.warnings.length;
  byId('warnings').textContent = data.warnings.join(' · ');
  byId('checked-at').textContent = '数据读取于 ' + date(data.checkedAt);
  byId('refresh-label').classList.remove('connection-error');
  byId('refresh-label').textContent = '● 每 5 秒自动刷新';
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  byId('refresh').disabled = true;
  try {
    const response = await fetch('/api/status', { cache:'no-store', signal:AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error('读取失败');
    render(await response.json());
  } catch {
    byId('refresh-label').classList.add('connection-error');
    byId('refresh-label').textContent = '连接中断，正在重试';
    byId('hero').className = 'hero degraded';
    byId('state-title').textContent = '状态服务连接中断';
    byId('state-description').textContent = '页面保留最近一次数据，等待状态服务恢复。';
    byId('signal').textContent = '!';
    byId('live-tag').textContent = 'OFFLINE';
  } finally { refreshing = false; byId('refresh').disabled = false; }
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('[data-view]')) item.classList.toggle('active', item === button);
    for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== 'view-' + button.dataset.view;
    byId('page-title').textContent = button.textContent.trim().replace(/^[◈⇄▦≡]\s*/, '');
  });
}
byId('refresh').addEventListener('click', refresh);
byId('event-search').addEventListener('input', renderLists);
byId('project-search').addEventListener('input', renderLists);
byId('local-address').textContent = location.host;
refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;
