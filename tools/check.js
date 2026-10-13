#!/usr/bin/env node
/**
 * check.js —— DoLBridge 环境自检 / 问题定位工具
 *
 *   node check.js [--port 9222]
 *
 * 依次检查：调试端口 → 游戏页面 → Mod 是否加载 → API 配置 → 驱动心跳 → 游戏状态，
 * 每步给出结论和"下一步该做什么"。
 */
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const PORT = Number(opt('port', 9222));
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id !== undefined) { const p = c.pending.get(m.id); if (p) { c.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } } };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}

let fatal = null;
const step = (n, title) => console.log('\n【' + n + '】' + title);
const ok = (t) => console.log('  ✅ ' + t);
const bad = (t, fix) => { console.log('  ❌ ' + t); if (fix) console.log('     → 怎么办：' + fix); fatal = fatal || t; };
const warn = (t, note) => { console.log('  ⚠ ' + t); if (note) console.log('     → ' + note); };

(async () => {
  console.log('DoLBridge 自检（端口 ' + PORT + '）');
  console.log('='.repeat(52));

  /* 1) 调试端口 */
  step(1, 'Chrome 调试端口');
  let version = null;
  try {
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json());
    ok('端口可用：' + version.Browser);
  } catch (e) {
    bad('连不上 http://127.0.0.1:' + PORT,
      '游戏浏览器必须用调试模式启动（普通双击启动没有这个端口）。\n' +
      '        Windows 示例（先完全退出 Chrome）：\n' +
      '        chrome.exe --remote-debugging-port=' + PORT + ' --user-data-dir="%TEMP%\\dol-debug" "…\\Degrees of Lewdity.html"\n' +
      '        或直接用随附的「启动调试浏览器.bat」');
    return finish();
  }

  /* 2) 游戏页面 */
  step(2, '游戏页面');
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = list.filter(t => t.type === 'page').find(t => /Degrees%20of%20Lewdity|DoL-ModLoader/i.test(decodeURIComponent(t.url)));
  if (!page) {
    bad('没找到游戏页面（当前打开的页面：' + list.filter(t => t.type === 'page').map(t => decodeURIComponent(t.url).slice(0, 60)).join(' | ') + '）',
      '确认游戏页已经打开，并且是用带调试端口的浏览器打开的');
    return finish();
  }
  ok('已找到：' + decodeURIComponent(page.url).split('/').pop().slice(0, 50));

  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const ev = async (e) => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 20000 });
    if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 200));
    return r.result.value;
  };

  /* 3) Mod 是否加载 */
  step(3, 'Mod（DoLBridge）');
  let ver = null;
  for (let i = 0; i < 15; i++) { ver = await ev('window.DoLBridge ? window.DoLBridge.version : null').catch(() => null); if (ver) break; await sleep(1000); }
  if (!ver) {
    bad('页面里没有 window.DoLBridge（Mod 没装或没加载）',
      '在 ModLoader 界面「添加 mod」选择 DoLBridge.mod.zip，然后刷新页面（F5）');
    return finish();
  }
  ok('已加载，版本 v' + ver);

  /* 4) API 配置 */
  step(4, 'API 配置');
  const prof = await ev('JSON.stringify(window.DoLBridge.profiles())').then(JSON.parse);
  const act = prof.list[prof.active] || {};
  if (!act.baseURL) bad('当前配置没有填 Base URL', '打开悬浮窗 →「API 配置」→ 填 Base URL / 模型 / API Key → 保存');
  else if (!act.hasKey) warn('Base URL 已填（' + act.baseURL + '），但没有 API Key', '如果需要鉴权，请在「API 配置」里填 Key');
  else ok('当前配置：' + act.name + ' · ' + act.baseURL + ' · ' + act.model + ' · 已填 Key');
  if (prof.list.length > 1) console.log('     （共 ' + prof.list.length + ' 套配置，可在下拉框切换）');

  /* 5) 驱动心跳 */
  step(5, '外部驱动');
  const ctl = JSON.parse(await ev('JSON.stringify(window.DoLBridge.control())'));
  if (ctl.driver && ctl.driver.online) ok('驱动在线：' + (ctl.driver.name || '(未命名)'));
  else bad('没有驱动连接（这就是「点开始没反应 / 提示驱动已断开」的原因）',
    '「开始」只是给驱动发信号，必须另外运行驱动脚本：\n' +
    '        node agent.js --port ' + PORT + '\n' +
    '        （首次用请先看 tools/README.md；驱动需要 Node.js 18+）');

  /* 6) 游戏状态 */
  step(6, '游戏状态');
  const st = JSON.parse(await ev(`JSON.stringify({ p: window.SugarCube.State.passage, s: window.DoLBridge.sidebar(), run: window.DoLBridge.isRunning(), ctx: window.DoLBridge.ctxInfo() })`));
  ok('画面：' + st.p + ' ｜ 时间：' + st.s.weekday + ' ' + st.s.time + ' ｜ 钱：' + st.s.money);
  console.log('     运行开关：' + (st.run ? '开（等待驱动执行）' : '关') + ' ｜ 上下文用量：' + (st.ctx.used || 0) + '/' + (st.ctx.max || 0));

  finish();
})().catch(e => { console.error('\n自检中断：' + (e && e.message || e)); process.exit(1); });

function finish() {
  console.log('\n' + '='.repeat(52));
  if (fatal) { console.log('结论：❌ 有问题需要处理 —— ' + fatal); process.exit(1); }
  console.log('结论：✅ 环境正常，可以让驱动开始工作（点悬浮窗的「开始」）');
  process.exit(0);
}
