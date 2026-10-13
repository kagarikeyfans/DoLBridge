/**
 * agent.js —— Agent 模式驱动（带完整上下文 + 自动压缩）
 *
 *   node agent.js --port 9222 [--interval 1200] [--max-steps 500]
 *                 [--compress-at 24000] [--keep-turns 4] [--out agent-out]
 *
 * 与旧 loop.js 的区别：
 *   - 维护**完整对话历史**（每步的观察 + 自己的决定都留在 messages 里），模型能看到自己做过什么、结果如何
 *   - 上下文接近上限（默认 prompt_tokens > 24000）时，自动让模型把历史**压缩成结构化记忆**，
 *     再用「记忆 + 最近几轮原文」继续跑；压缩结果同时写到 agent-memory.md 便于人工查看
 *   - 计划仍只由用户维护；问答仍会读游戏真实面板数据
 *
 * 面板协议（DoLBridge）：heartbeat / control / think / say / deciding / step / setCombat / panel / save
 */
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const PORT = Number(opt('port', 9222));
const INTERVAL = Number(opt('interval', 1200));
const MAX_STEPS = Number(opt('max-steps', 500));   // 默认 500；面板「Agent → 步数上限」可覆盖
const COMPRESS_AT = Number(opt('compress-at', 200000));      // 默认（面板里可覆盖）
const CTX_WINDOW = Number(opt('context-window', 1000000));   // 模型上下文上限，用于百分比显示
const KEEP_TURNS = Number(opt('keep-turns', 4));
const OUT = String(opt('out', path.join(__dirname, 'agent-out')));
const OUT_DIR = OUT;
  /* 稳定会话 ID（一次生成、持久化）：zen 要求每个对话带稳定的 x-opencode-session */
  const SESS_FILE = path.join(OUT_DIR, '.zen-session');
  const zenSession = (() => {
    try { const s = fs.readFileSync(SESS_FILE, 'utf8').trim(); if (s) return s; } catch (e) { }
    const s = 'dolbridge-' + Math.random().toString(36).slice(2, 10);
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(SESS_FILE, s); } catch (e) { }
    return s;
  })();

  /** 统一请求头：明确标识自己（自定义 UA，而不是 undici 这类通用库名）+ 会话头 + 用户自定义头 */
  const buildHeaders = (cfg) => {
    const h = {
      'Content-Type': 'application/json',
      'User-Agent': 'DoLBridge-Agent/3.0 (+node; coding-agent)',
      'x-opencode-session': zenSession
    };
    Object.keys(cfg.extraHeaders || {}).forEach(k => { h[k] = cfg.extraHeaders[k]; });
    if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
    return h;
  };


const DRIVER_NAME = String(opt('name', 'dsh-agent'));
const MAX_CTX_OBS = Number(opt('obs-chars', 1500));
const STOP_DOW = String(opt('stop-dow', ''));                 // 例：星期一
const STOP_HOURS = String(opt('stop-hours', ''));             // 例：6-12
const stopRange = (function () {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(STOP_HOURS);
  return m ? { a: Number(m[1]), b: Number(m[2]) } : null;
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = c.pending.get(m.id);
        if (p) { c.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = (m.params || {}).exceptionDetails || {};
        c.errors.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 200));
      }
    };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}

const BENIGN = /Failed to load resource|Failed to fetch|net::ERR_|drawImage|randomInt|ResizeObserver|favicon|CanvasRenderingContext|ImageLoaderHook|CssReplacer/i;
const SERIOUS = /Uncaught|TypeError|ReferenceError|is not a function|is not defined|Cannot read|Cannot set/i;
// 只过滤「整条就是菜单项」的动作（否则中文界面里「关闭衣柜」「选项」这类正常动作会被误伤）
const BLOCK_EXACT = /^(存档|保存|读取|载入|设置|选项|删除|导出|导入|画廊|成就|关闭|退出|作弊|调试|重开|错误视图|Saves|Save|Settings|Delete|Export|Import|Gallery|Options|Feats?)$/i;
const BLOCK = { test: (t) => BLOCK_EXACT.test(String(t == null ? '' : t).replace(/^[\(（]\s*\d+\s*[\)）]\s*/, '').trim()) };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const logStream = fs.createWriteStream(path.join(OUT, 'agent-log.jsonl'), { flags: 'a' });
  const say = (o) => { logStream.write(JSON.stringify(Object.assign({ t: new Date().toISOString() }, o)) + '\n'); console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + JSON.stringify(o).slice(0, 220)); };

  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = list.filter(t => t.type === 'page').find(t => /Degrees%20of%20Lewdity|DoL-ModLoader/i.test(decodeURIComponent(t.url)));
  if (!page) { console.error('找不到游戏页'); process.exit(1); }
  let cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  /** 重新连接游戏页（页面刷新、浏览器重开都能恢复） */
  async function reconnect(reason) {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) { }
    for (let i = 0; i < 60; i++) {
      try {
        const l = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
        const pg = l.filter(t => t.type === 'page').find(t => /Degrees%20of%20Lewdity|DoL-ModLoader/i.test(decodeURIComponent(t.url)));
        if (pg) {
          cdp = await CDP.connect(pg.webSocketDebuggerUrl);
          await cdp.send('Runtime.enable');
          say({ event: 'reconnect', reason: reason || null, try: i + 1 });
          return true;
        }
      } catch (e) { /* 继续重试 */ }
      await sleep(2000);
    }
    return false;
  }

  /** CDP 调用加超时（页面刷新会让旧上下文的 promise 永远不 resolve） */
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('CDP 超时 ' + ms + 'ms: ' + label)), ms))
  ]);
  let lastExpr = '';
  const rawEv = async e => {
    lastExpr = String(e);
    const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: 60000 }), 45000, 'evaluate');
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
      throw new Error('页面报错: ' + String(desc).slice(0, 600) + ' ｜ 表达式: ' + lastExpr.slice(0, 200));
    }
    return r.result.value;
  };
  /** 等 DoLBridge 出现（页面刷新后 mod 需要几秒才加载） */
  async function waitBridge(maxMs) {
    const t0 = Date.now();
    for (;;) {
      try { if (await rawEv('typeof window.DoLBridge !== "undefined"')) return true; } catch (e) { /* 可能还没连上 */ }
      if (Date.now() - t0 > (maxMs || 90000)) return false;
      await sleep(2000);
    }
  }
  const bridgeMissing = (msg) => /Cannot read propert.*(control|observe|vitals|api|combat|heartbeat|think|say|isRunning|setRunning)/.test(String(msg))
    || /window\.DoLBridge/.test(String(msg)) && /undefined/.test(String(msg));

  /** 出错自动重连 / 等 mod 就绪，并重试一次 */
  const ev = async e => {
    try { return await rawEv(e); }
    catch (err) {
      const msg = String(err && err.message || err);
      if (bridgeMissing(msg)) {
        say({ event: 'wait-bridge', expr: String(e).slice(0, 60) });
        await waitBridge(90000);
        return await rawEv(e);
      }
      if (/CDP 超时|WebSocket|not open|closed|Target|Session/i.test(msg)) {
        const ok = await reconnect(msg.slice(0, 80));
        if (ok) { await waitBridge(60000); return await rawEv(e); }
      }
      throw err;
    }
  };

  /* 心跳独立定时器：不再依赖"每步一次"，模型调用慢时也不会被当成掉线 */
  let hbTimer = setInterval(() => { ev(`window.DoLBridge.heartbeat({name:${JSON.stringify(DRIVER_NAME)}})`).catch(() => null); }, 5000);
  if (hbTimer.unref) hbTimer.unref();

  await waitBridge(180000);
  for (let i = 0; i < 60; i++) { if (await rawEv('window.DoLBridge ? window.DoLBridge.version : null').catch(() => null)) break; await sleep(1000); }
  const bridgeVer = await ev('window.DoLBridge.version');
  console.log('请求头：User-Agent=DoLBridge-Agent/3.0 (自定义标识) ｜ x-opencode-session=' + zenSession + '（自动补，符合 zen 文档要求）');
console.log('DoLBridge ' + bridgeVer + ' · Agent ' + DRIVER_NAME + ' 已连接（上下文上限 ' + CTX_WINDOW + ' / 压缩阈值 CLI 默认 ' + COMPRESS_AT + '，面板可覆盖）');

  const writeThink = (o) => ev(`window.DoLBridge.think(${JSON.stringify(o)})`);
  const writeSay = (t) => ev(`window.DoLBridge.say(${JSON.stringify(t)})`);
  const dec = (t) => ev(`window.DoLBridge.deciding(${JSON.stringify(t == null ? '…' : t)})`).catch(() => null);
  const writeFile = (name, text) => fs.writeFileSync(path.join(OUT, name), text, 'utf8');

  /* ---------------- 观察 ---------------- */
  const gather = async () => JSON.parse(await ev(`(function(){
    var B = window.DoLBridge, o = B.observe({maxChars:${MAX_CTX_OBS}}), v = B.vitals();
    var t = null; try { t = window.SugarCube.State.variables.time; } catch (e) { t = null; }
    return JSON.stringify({ passage:o.passage.title, text:o.passage.text, actions:o.actions, combat:o.combat || [],
      days:(t && t.days != null) ? t.days : null,
      vitals:v.items.map(function(i){return i.brief}), vitalsDetail:v.items.map(function(i){return i.detail}), vitalsText:v.text,
      look:(B.look ? B.look() : ''), notice:(B.notice ? B.notice() : {}), plan:B.plan(),
      notes:(B.notes ? B.notes() : ''),
      worn:(B.worn ? B.worn() : null), wardrobe:(B.wardrobe ? B.wardrobe() : null),
      sidebar:B.sidebar(), canSave:B.canSave() });
  })()`));

  const combatText = (ctx) => (!ctx.combat || !ctx.combat.length) ? '' :
    '【战斗：为每个部位选一个动作】\n' + ctx.combat.map(g => '  ' + g.label + '(' + g.name + '，当前' + (g.selected == null ? '-' : g.selected) + ')：'
      + g.options.map(o => '[' + o.i + ']' + o.text + (o.checked ? '(已选)' : '')).join(' ')).join('\n');

  /** 计划里的"何时停止/汇报"是否已到期（确定性判定，不依赖模型配合） */
  const planStopDue = (planText, sb) => {
    const p = String(planText || '');
    if (!p || !/(停止|停下|结束|汇报|报告|总结)/.test(p)) return null;
    const wd = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const dm = /(?:星期|周)([一二三四五六日天])/.exec(p);
    const hour = Number(String(sb.time || '00:00').slice(0, 2));
    let h = null, hlabel = '';
    const tm = /(\d{1,2})\s*(?:[:：]\s*(\d{2})|[点时])/.exec(p);
    if (tm) { const th = Number(tm[1]); h = [th, th]; hlabel = tm[0]; }
    else if (/早上|早晨|清晨|上午/.test(p)) { h = [5, 11]; hlabel = '上午'; }
    else if (/中午|正午/.test(p)) { h = [11, 13]; hlabel = '中午'; }
    else if (/下午/.test(p)) { h = [13, 17]; hlabel = '下午'; }
    else if (/傍晚|晚上|夜里|夜晚|入夜/.test(p)) { h = [17, 23]; hlabel = '晚上'; }
    else if (/凌晨|半夜|深夜/.test(p)) { h = [0, 4]; hlabel = '凌晨'; }
    if (!h) return null;
    if (dm) { const want = '星期' + (dm[1] === '天' ? '日' : dm[1]); if (String(sb.weekday || '').replace(/周/, '星期') !== want) return null; }
    if (hour < h[0]) return null;   // 到点之后（含之后的小时）都算到期，避免错过窗口
    return '【计划停止条件已满足】现在是 ' + sb.weekday + ' ' + sb.time + '（' + (hlabel || '计划指定时间') + '），用户计划要求：' + p + '。请立刻停止行动并输出汇报。';
  };

  /** 把模型的 combat 选择归一化成 {mouthaction: 2} 形式（容忍中文部位名/别名/字符串数字） */
  /** 把 {mouthaction:2} 这类部位选择翻译成「嘴=口交」 */
  const partText = (sel, groups) => Object.keys(sel || {}).map(k => {
    const g = (groups || []).find(x => x.name === k);
    const label = g ? g.label : k;
    const opt = g && g.options ? g.options.find(o => Number(o.i) === Number(sel[k])) : null;
    return label + '=' + (opt ? String(opt.text).replace(/\s*\|.*$/, '').trim() : sel[k]);
  }).join('，');

  const normCombat = (sel, ctx) => {
    const groups = (ctx.combat || []);
    const out = {}, dropped = [];
    Object.keys(sel || {}).forEach(k => {
      const kk = String(k).trim();
      const g = groups.find(x => x.name === kk)
        || groups.find(x => x.label === kk)
        || groups.find(x => kk.indexOf(x.label) >= 0 || x.label.indexOf(kk) >= 0)
        || groups.find(x => x.name.indexOf(kk.toLowerCase()) >= 0);
      const v = Number(sel[k]);
      if (g && !isNaN(v)) out[g.name] = v; else dropped.push(kk + '=' + sel[k]);
    });
    return { sel: out, dropped: dropped };
  };

  const obsText = (ctx, step, lastResult, userMsgs, routine) => {
    const acts = (ctx.actions || []).filter(a => !a.disabled && !BLOCK.test(a.text));
    const lines = [];
    if (routine) lines.push(routine);
    lines.push('【第 ' + step + ' 步】时间 ' + ctx.sidebar.time + ' 星期' + (ctx.sidebar.weekday || '') + ' · 地点 ' + ctx.sidebar.location + ' · 钱 ' + (ctx.sidebar.moneyText || ctx.sidebar.money));
    if (lastResult) lines.push('【上一步结果】' + lastResult);
    if (userMsgs && userMsgs.length) lines.push('【用户新指令（重要，优先执行）】' + userMsgs.join(' / '));
    if (ctx.plan) lines.push('【用户计划（必须遵守；计划里的时间/条件一旦达到就要停下并汇报）】' + ctx.plan);
    if (ctx.notes && String(ctx.notes).trim()) lines.push('【我的日记（你自己以前写下的，可继续用 diary_add 追加一条）】\n' + String(ctx.notes).slice(0, 1500));
    else lines.push('【我的日记】（还是空的；有值得记下的经验/教训就用 diary_add 追加一条）');
    if (ctx.look) lines.push('【当前穿着与携带】' + ctx.look);
    if (ctx.notice && (ctx.notice.notice || ctx.notice.tips)) lines.push('【侧边栏提示】' + [ctx.notice.notice, ctx.notice.tips ? '小贴士：' + ctx.notice.tips : ''].filter(Boolean).join(' ｜ '));

    if (ctx.worn) lines.push('【当前穿戴（分部位）】' + Object.keys(ctx.worn).map(k => k + '：' + (ctx.worn[k] || '无')).join('，'));
    if (ctx.wardrobe) lines.push('【衣柜界面】部位标签可点：' + (ctx.wardrobe.tabs || []).map(t => t.label).join('/')
      + '（当前部位：' + (ctx.wardrobe.slot || '?') + '；模式：' + (ctx.wardrobe.mode || '?') + '）。换衣服：点部位标签 → 选模式(Wear/Discard) → 点物品名。');
    const forms = (ctx.forms || []);
    if (forms.length) lines.push('【可填写控件（用 JSON 的 form 字段设置）】\n' + forms.map(f => '  [' + f.i + '] ' + f.kind + (f.label ? '「' + f.label + '」' : '') + ' 当前=' + String(f.value).slice(0, 24)
      + (f.options ? ' 可选项=' + f.options.map(o => String(o.text).slice(0, 12)).slice(0, 12).join('/') : '')
      + (f.min !== undefined ? ' 范围=' + f.min + '~' + f.max : '')).join('\n'));
    lines.push('【自身状态（格式：项目：百分比，文字描述）】\n' + (ctx.vitals || []).map(v => '  ' + v).join('\n'));
    lines.push('【画面】' + ctx.passage + '\n' + String(ctx.text || '').replace(/\s+/g, ' '));
    const cmb = combatText(ctx);
    if (cmb) lines.push(cmb);
    lines.push('【可选动作】\n' + acts.map(a => '[' + a.i + '] ' + a.text + (a.nav ? '  → ' + a.nav : '')).join('\n'));
    lines.push('如果【用户计划】要求的停止/汇报条件已经达到（例如"周一晚上汇报"），**不要选动作**，改为只输出：'
      + '{"report": "汇报正文（≤400字：做了什么、花了多少钱、拿到什么、身体与精神状态、下一步打算）"}');
    lines.push('要填写输入框/下拉框时，加 "form": {"<控件编号>": "<值>"}（例：商店搜索框 {"form":{"0":"pyjama"}}）。');
    lines.push('有值得长期记住的心得（例如某条路危险、某个做法有效/无效）时，加 "diary_add": "日记正文"，会追加进【我的日记】。');
    lines.push('日记格式：**第一行只写游戏内日期**（形如 2022-09-06 星期六），第二行起写正文（1~3 句：发生了什么、学到什么、下次注意什么）；不要写标题。');
    lines.push('如果画面上只有「继续」这类推进选项（被束缚、意识不清、无法反抗时会出现），直接选它推进即可——这是正常的，不是卡死；此时场景名可能不变，但只要文字/时间在动就是在推进。');
    lines.push('只输出 JSON：{"action_index": <编号>' + (cmb ? ', "combat": {"<部位名>": <选项编号>}' : '')
      + ', "reason": "≤60字中文理由（引用自身状态百分比或计划）"'
      + (routine ? ', "daily_goal": "今天的目标（≤40字）"' : '')
      + ', "reply": "可选"}');
    return lines.join('\n');
  };

  /* ---------------- 模型 ---------------- */
  const estTokens = (msgs) => Math.ceil(msgs.reduce((n, m) => n + String(m.content || '').length, 0) / 2.2);
  let lastUsage = null;

  const chatOnce = async (cfg, messages, opts = {}) => {
    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    const body = { model: cfg.model || 'deepseek-chat', messages, temperature: (opts.temperature == null ? (cfg.temperature == null ? 0.7 : cfg.temperature) : opts.temperature), stream: false };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const headers = buildHeaders(cfg);
    const res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    lastUsage = data.usage || null;
    const ch = (data.choices && data.choices[0]) || {};
    const msg = ch.message || {};
    const content = String(msg.content || ch.text || '').trim();
    const reasoning = String(msg.reasoning_content || '').trim();       // 推理模型（如 deepseek-v4.1-flash）
    if (reasoning && opts.keepReasoning) return content + (content ? '\n' : '') + '[reasoning]' + reasoning.slice(0, 500);
    return content || reasoning || '';
  };
  /** 从模型输出里取第一个"配对完整"的 JSON 对象（避免贪婪匹配把后面的文字/第二个对象一起吞掉） */
  const jsonOf = (txt) => {
    const s = String(txt || '');
    const start = s.indexOf('{');
    if (start < 0) throw new Error('没有 JSON: ' + s.slice(0, 120));
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
    }
    throw new Error('JSON 不完整: ' + s.slice(0, 120));
  };

  /* ---------------- 上下文（含压缩） ---------------- */
  let memory = null;               // 压缩后的记忆文本
  let compressCount = 0;
  const buildMessages = (system, msgs) => {
    const out = [{ role: 'system', content: system }];
    if (memory) out.push({ role: 'user', content: '【上下文压缩记忆（第 ' + compressCount + ' 次压缩）】\n' + memory });
    return out.concat(msgs);
  };
  const tokensNow = (system, msgs) => (lastUsage && lastUsage.prompt_tokens != null)
    ? lastUsage.prompt_tokens + estTokens([msgs[msgs.length - 1]])
    : estTokens(buildMessages(system, msgs));

  async function compress(cfg, system, msgs, stepNo) {
    const ask = [
      '【任务】把我们之前的对话压缩成一份"记忆"，供你之后继续玩游戏时使用。',
      '要求：结构化、信息密度高、不超过 700 字。必须包含：',
      '1) 当前目标与用户计划；2) 角色状态（时间/地点/钱/疲劳压力创伤自控等关键体征、已知技能与学业）；',
      '3) 已完成的剧情节点与人际关系（NPC 名字、好感、承诺）；4) 失败或无效的尝试及原因（例如"某活动需要特定服装/钱/时间"）；',
      '5) 待办与风险（贝利债务、上课、天黑、需要购买的东西）。',
      '另外必须原样保留：6) 用户计划的原文；7) 计划的停止/汇报条件（例如「周一晚上21点停止并总结」）；8) 尚未完成的事项。',
      '直接输出记忆正文，不要输出 JSON，也不要复述原对话。',
      '',
      '【待压缩的对话】',
      msgs.map(m => (m.role === 'user' ? '【观察】' : '【你的决定】') + String(m.content).slice(0, 1200)).join('\n\n')
    ].join('\n');
    const txt = await chatOnce(cfg, [{ role: 'system', content: '你是上下文压缩器，只做摘要，不玩游戏。' }, { role: 'user', content: ask }], { temperature: 0.2, maxTokens: 1200 });
    memory = String(txt || '').trim();
    compressCount++;
    const keep = msgs.slice(-(KEEP_TURNS * 2));
    writeFile('agent-memory.md', '# 第 ' + compressCount + ' 次压缩（第 ' + stepNo + ' 步）\n\n' + memory + '\n');
      saveState();
    // 压缩后重新注入用户计划与停止/汇报规则（压缩最容易把这些丢掉）
    try {
      const planNow = await ev('window.DoLBridge.plan()').catch(() => '');
      const sbNow = JSON.parse(await ev('JSON.stringify(window.DoLBridge.sidebar())').catch(() => '{}'));
      const dueNow = planStopDue(planNow, sbNow || {});
      memory = (memory || '') + '\n\n【压缩后重新注入·必须遵守】\n用户计划原文：' + String(planNow || '（空）')
        + '\n停止/汇报规则：' + (dueNow ? ('已到停止条件——' + dueNow) : '按计划里的时间或条件停止，并输出 report 字段做阶段性总结');
      msgs.push({ role: 'user', content: '【压缩后重新注入】用户计划原文：' + String(planNow || '（空）') + '；到点或计划达成时必须停止，并只输出 report 字段做总结。' });
      writeFile('agent-memory.md', '# 第 ' + compressCount + ' 次压缩（含计划重注入）\n\n' + memory + '\n');
    } catch (e) { /* ignore */ }
    say({ event: 'compress', n: compressCount, step: stepNo, memChars: memory.length, keptTurns: KEEP_TURNS });
    await writeThink({ note: '🗜 上下文已压缩（第 ' + compressCount + ' 次）：历史 ' + msgs.length + ' 条 → 记忆 ' + memory.length + ' 字 + 最近 ' + keep.length + ' 条原文' });
    await writeSay('（上下文压缩完成：已把前面的经历总结成记忆，继续推进）');
    return keep;
  }

  /* ---------------- 面板数据（问答用） ---------------- */
  const PANEL_MAP = { '属性': 'characteristics', '特质': 'traits', '社交': 'social', '日志': 'journal', '统计': 'statistics', '成就': 'feats', '技能': 'characteristics', '外貌': 'characteristics', '声望': 'social' };
  const fetchPanels = async (names) => {
    const out = {};
    for (const n of names) {
      const raw = await ev(`(function(){ var r = window.DoLBridge.panel(${JSON.stringify(n)}, {limit: 80, chars: 3000, full: true});
        if (!r || r.ok === false) return JSON.stringify({error:(r&&r.error)||'unavailable'});
        return JSON.stringify({items:(r.items||r.rows||[]).slice(0,80), text:String(r.text||'').replace(/\\s+/g,' ').slice(0,3000), fullText:String(r.fullText||'').replace(/\\s+/g,' ').slice(0,6000)}); })()`).catch(() => null);
      if (raw) out[n] = JSON.parse(raw);
    }
    return out;
  };
  const panelText = (p) => Object.keys(p).map(n => {
    const r = p[n] || {};
    if (r.error) return '  ' + n + '：读取失败(' + r.error + ')';
    const list = r.items || r.rows || [];
    let out = list.map(i => {
      if (i == null) return '';
      if (typeof i === 'string' || typeof i === 'number') return String(i);       // ← 字符串项直接输出
      const lab = (i.label != null && i.label !== '') ? (String(i.label) + '：') : '';
      const val = (i.value != null) ? i.value : (i.text != null ? i.text : '');
      return lab + String(val);
    }).filter(Boolean).join('；');
    const raw = String(r.fullText || r.text || '').replace(/\s+/g, ' ').trim();
    if (raw && raw.length > out.length) out = out ? (out + ' ｜ 原文：' + raw) : raw;   // 面板里常有"不在列表项里"的段落，有差就补原文
    return '  ' + n + '：' + out.slice(0, 2200);
  }).join('\n');

  /* ---------------- 主循环 ---------------- */
  let msgs = [];                        // 对话历史（user=观察, assistant=决定）
  const STATE_FILE = path.join(OUT, 'agent-state.json');
  /** 把对话历史/压缩记忆落盘，驱动重启也能接着用 */
  const HIST_KEEP = 240;   // 保留的历史条数（约 120 步）
  const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ msgs: msgs.slice(-HIST_KEEP), memory: memory || null, steps, planReportedKey: planReportedKey || null, at: Date.now() })); } catch (e) { } };
  let steps = 0, fails = 0, lastChatHandled = 0, noNovel = 0, lastStepInfo = null;
  let saveSlotNow = 1, curSessionNow = 0;   // 当前会话对应的存档格（默认会话=1，会话N=N）
  let lastDayKey = null, firstRoutine = true, currentGoal = null;
  let planReportedKey = null;   // 已经汇报过的「计划原文|星期」，同一份计划同一天只汇报一次
  const seenPassages = new Set();
  const stopRun = async (why, note) => {
    await ev('window.DoLBridge.setRunning(false)').catch(() => null);
    await writeThink({ action: '⏹ 已停止', reason: why, note: note || null }).catch(() => null);
    await writeSay('已停止：' + why).catch(() => null);
    say({ event: 'stop', why, note: note || null });
  };

  // 没有状态文件时，尝试从 agent-memory.md 恢复压缩记忆（驱动重启不丢上下文）
  if (!msgs.length) {
    try {
      const memTxt = fs.readFileSync(path.join(OUT, 'agent-memory.md'), 'utf8');
      const parts = memTxt.split(/^# 第 \d+ 次压缩.*$/m).filter(t => t.trim());
      if (parts.length) { memory = parts[parts.length - 1].trim().slice(0, 4000); console.log('已从 agent-memory.md 恢复压缩记忆：' + memory.length + ' 字'); }
    } catch (e) { }
  }
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (st.planReportedKey) planReportedKey = st.planReportedKey;
    if (Array.isArray(st.msgs) && st.msgs.length) {
      msgs = st.msgs; memory = st.memory || null;
      console.log('已恢复上次的对话历史：' + msgs.length + ' 条' + (memory ? '（含压缩记忆）' : ''));
      try {
        const nowSb = JSON.parse(await ev('JSON.stringify(window.DoLBridge.sidebar())').catch(() => '{}'));
        msgs.push({ role: 'user', content: '【会话已恢复】以上是上一次运行留下的历史（可能已过了一段时间）。当前游戏时间是 '
          + (nowSb.weekday || '?') + ' ' + (nowSb.time || '?') + '，地点 ' + (nowSb.passage || '?') + '，钱 ' + (nowSb.moneyText || nowSb.money) + '。请以**最新观察**为准，旧历史只作参考。' });
      } catch (e) { }
    }
  } catch (e) { /* 首次运行没有状态文件 */ }

  try {
    const c0 = JSON.parse(await ev('JSON.stringify(window.DoLBridge.control())'));
    const ch = c0.chat || [];
    if (ch.length) {
      const last = ch[ch.length - 1];
      lastChatHandled = (last.role === 'user') ? (Number(last.at || 0) - 1) : Number(last.at || 0);
      console.log('对话起点：已有 ' + ch.length + ' 条，最后一条=' + last.role + (last.role === 'user' ? '（待回答）' : '（已处理）'));
    }
  } catch (e) { /* ignore */ }

  for (;;) {
    try {
      await ev(`window.DoLBridge.heartbeat({name:${JSON.stringify(DRIVER_NAME)}})`).catch(() => null);
      fails = 0;
      const ctl = JSON.parse(await ev('JSON.stringify(window.DoLBridge.control())'));
      // 注意：**不要**在这里推进 lastChatHandled —— 只有真正回答成功后才推进，否则用户指令会被永久丢弃
      const userMsgs = (ctl.chat || []).filter(m => m.role === 'user' && Number(m.at || 0) > lastChatHandled);

      const cfg = await ev('window.DoLBridge.api()');
      let pageCfg = { contextWindow: CTX_WINDOW, compressAt: COMPRESS_AT };
      try { pageCfg = Object.assign(pageCfg, JSON.parse(await ev('JSON.stringify(window.DoLBridge.agentConfig ? window.DoLBridge.agentConfig() : {})'))); } catch (e) { /* ignore */ }
      const CTX_MAX = Number(pageCfg.contextWindow) || CTX_WINDOW;
      const COMPRESS_LIMIT = Number(pageCfg.compressAt) || COMPRESS_AT;
      // 优先级：命令行显式 --max-steps > 面板「步数上限」 > 默认 500
      const STEP_LIMIT = (argv.indexOf('--max-steps') >= 0) ? MAX_STEPS : (Number(pageCfg.maxSteps) || MAX_STEPS);
      const system = ctl.system || '';
      const hasApi = !!(ctl.api && ctl.api.baseURL);

      // ---- 用户提问：独立走一轮 Q&A（带真实面板数据），也写进历史 ----
      if (userMsgs.length && hasApi) {
        const q = String(userMsgs[userMsgs.length - 1].text || '');
        try {
          await dec('正在读取面板数据并回答…');
          const want = Array.from(new Set(Object.keys(PANEL_MAP).filter(k => q.indexOf(k) >= 0).map(k => PANEL_MAP[k])));
          const panels = await fetchPanels(want.length ? want : ['characteristics', 'traits', 'social', 'statistics']);
          const ctx0 = await gather();
          const qa = [
            '玩家在游戏运行时向你提问，请依据下面的**真实游戏数据**回答（不要编造，数据里没有就直说）。',
            '【用户问题】' + q,
            '【当前画面】' + ctx0.passage + ' · ' + ctx0.sidebar.weekday + ' ' + ctx0.sidebar.time + ' · ' + ctx0.sidebar.location + ' · 钱 ' + (ctx0.sidebar.moneyText || ctx0.sidebar.money),
            '【当前穿着与携带】' + (ctx0.look || '（读不到）'),
            '【侧边栏提示】' + ((ctx0.notice && (ctx0.notice.notice || ctx0.notice.tips)) ? [ctx0.notice.notice, ctx0.notice.tips ? '小贴士：' + ctx0.notice.tips : ''].filter(Boolean).join(' ｜ ') : '（无）'),
            '【用户计划】' + (ctx0.plan || '（空）'),
            '【生命体征】\n' + (ctx0.vitals || []).map(v => '  ' + v).join('\n'),
            '【游戏内面板数据】\n' + panelText(panels),
            '只输出 JSON：{"answer":"≤120字中文回答"}'
          ].join('\n');
          const a = jsonOf(await chatOnce(cfg, buildMessages(system, [{ role: 'user', content: qa }]), { temperature: 0.3 })).answer;
          // 问答也要回传上下文用量（否则面板/标题栏看不到 ctx）
          const qaUsed = (lastUsage && lastUsage.prompt_tokens) || estTokens([{ content: qa }]);
          await ev('window.DoLBridge.ctxUsage(' + JSON.stringify({ used: qaUsed, max: CTX_MAX }) + ')').catch(() => null);
          if (a) { await writeSay('💬 ' + String(a)); msgs.push({ role: 'user', content: '【用户提问】' + q }, { role: 'assistant', content: '{"answer":' + JSON.stringify(String(a)) + '}' }); }
          lastChatHandled = Math.max.apply(null, userMsgs.map(m => Number(m.at || 0)).concat([lastChatHandled]));   // 回答成功才标记
          say({ event: 'answer', q: q.slice(0, 60), a: String(a || '').slice(0, 160) });
          await dec('');
        } catch (e) {
          await writeSay('回答出错：' + String(e && e.message || e).slice(0, 100));
          say({ event: 'answer-error', error: String(e && e.message || e).slice(0, 200) });
        }
        await sleep(INTERVAL);
        continue;
      }

      if (!ctl.running) { await sleep(1000); continue; }
      if (steps >= STEP_LIMIT) {
        await stopRun('已达到本次运行的步数上限 ' + STEP_LIMIT + '（可继续：再次点「开始」会从当前进度接着跑）');
        steps = 0;                       // 计数归零，但**保留对话历史**（记忆不该因为步数上限被清空）
        await sleep(1000);
        continue;
      }

      let ctx = await gather();
      const bad = (cdp.errors || []).filter(e => SERIOUS.test(e) && !BENIGN.test(e));
      if (bad.length) { await stopRun('控制台出现严重错误', bad.slice(-2).join(' | ')); cdp.errors = []; await sleep(1000); continue; }
      if (ctx.errorPage && ctx.errorPage.bad) { await stopRun('游戏出现报错页（' + ctx.passage + '）', 'title=' + ctx.errorPage.title + ' ui=' + ctx.errorPage.ui + ' banner=' + ctx.errorPage.banner); await sleep(1000); continue; }
      let acts = (ctx.actions || []).filter(a => !a.disabled && !BLOCK.test(a.text));
      if (!acts.length) { await dec(''); await writeThink({ note: '当前画面没有可用动作，等待…' }); await sleep(2000); continue; }

      // ---- 画面只有 1 个可选动作（多半是「继续」）→ 自动推进，把文本合并成一条再交给模型 ----
      let autoN = 0, autoMerge = '';
      while (acts.length === 1 && autoN < 40 && ctl.running && !planStopDue(ctx.plan, ctx.sidebar)) {
        const a1 = acts[0];
        let rr = null;
        try { rr = await ev('window.DoLBridge.step(' + a1.i + ', {timeoutMs:20000})'); } catch (e) { rr = null; }
        autoN++;
        const t = (rr && rr.text) ? String(rr.text).replace(/\s+/g, ' ').trim() : '';
        if (t) autoMerge += (autoMerge ? ' ' : '') + t.slice(0, 300);
        ctx = await gather();
        acts = (ctx.actions || []).filter(x => !x.disabled && !BLOCK.test(x.text));
        if (autoMerge.length > 3000) break;
        // 用户刚发指令 → 立刻停下来交给模型
        const chk = JSON.parse(await ev('JSON.stringify(((window.DoLBridge.control()||{}).chat)||[])').catch(() => '[]'));
        const lastChk = chk[chk.length - 1];
        if (lastChk && lastChk.role === 'user' && Number(lastChk.at || 0) > lastChatHandled) break;
      }
      if (autoN) {
        await dec('');
        autoMerge = '【自动推进 ' + autoN + ' 步：画面只有 1 个可选动作（被束缚/意识不清等情况下只能「继续」），已自动点过，不是卡死】' + autoMerge;
        say({ event: 'auto-advance', n: autoN, chars: autoMerge.length });
      }

      if (!hasApi) { await dec(''); await sleep(1500); continue; }

      // 上一轮结果（写进观察，模型自己看得见）
      let lastResult = null;
      if (autoN) lastResult = autoMerge;
      if (lastStepInfo) {
        const one = '你选了「' + String(lastStepInfo.chose).slice(0, 30) + '」，结果：' + lastStepInfo.from + ' → ' + lastStepInfo.to
          + '（用时 ' + lastStepInfo.delta + '；' + (lastStepInfo.novel ? '到达新地点' : (lastStepInfo.timeMoved ? '场景名没变但时间在推进（事件在走）' : '画面与时间都没变化')) + '）';
        lastResult = autoN ? (autoMerge + ' ' + one) : one;
      }
      // —— 开局 / 每天零点：自动存档 + 查看属性·社交·日志 + 定当天目标 ——
      // 日键只按"星期几"（午夜才变），否则每过一小时就会误判成新的一天
      const dayKey = String(ctx.sidebar.weekday || '') + (ctx.days != null ? ('#' + ctx.days) : '');
      let routine = null;
      const isNewDay = (dayKey !== lastDayKey);
      if (isNewDay) {
        lastDayKey = dayKey;
        let sv = null;
        // 存档只写「当前会话对应的格子」：默认会话→格子1，会话N→格子N；绝不碰其它格子（避免覆盖有用存档）
        const curSession = Number((ctl && ctl.session && ctl.session.slot != null) ? ctl.session.slot : 0) || 0;
        const saveSlot = (curSession === 0) ? 1 : curSession;
        const saveName = firstRoutine ? ('AI自动档·会话' + curSession) : ('AI·会话' + curSession + '·' + String(ctx.sidebar.weekday || '') + ctx.sidebar.time.slice(0, 2) + '时');
        saveSlotNow = saveSlot; curSessionNow = curSession;
        try { sv = await ev('window.DoLBridge.save(' + saveSlot + ', {name:' + JSON.stringify(saveName) + '})'); } catch (e) { sv = { ok: false, error: String(e && e.message || e) }; }
        sv = Object.assign({ slot: saveSlot }, sv || {});
        const panels = await fetchPanels(['characteristics', 'social', 'journal']);
        routine = '【' + (steps === 0 || firstRoutine ? '开局' : '新的一天') + '流程】现在是 ' + ctx.sidebar.weekday + ' ' + ctx.sidebar.time
          + '。已自动存档（' + (sv && sv.ok ? '成功' : '失败：' + (sv && sv.error)) + '）。\n'
          + '以下是游戏内的真实面板数据，请先据此决定今天大致要做什么，并在 JSON 里给出 "daily_goal"：\n'
          + panelText(panels);
        firstRoutine = false;
        say({ event: 'routine', day: dayKey, slot: sv && sv.slot, saved: !!(sv && sv.ok), panels: Object.keys(panels) });
      }

      steps++;
      const userLine = userMsgs.length ? [String(userMsgs[userMsgs.length - 1].text).slice(0, 200)] : null;
      msgs.push({ role: 'user', content: obsText(ctx, steps, lastResult, userLine, routine) });

      await dec('正在问模型（' + (ctl.api.model || 'model') + '，历史 ' + msgs.length + ' 条 / 约 ' + tokensNow(system, msgs) + ' tokens）…');
      let raw = null, txt = '';
      try {
        txt = await chatOnce(cfg, buildMessages(system, msgs));
        raw = jsonOf(txt);
      } catch (e) {
        msgs.pop();
        await writeThink({ note: '模型调用失败：' + String(e && e.message || e).slice(0, 120) });
        say({ event: 'llm-error', error: String(e && e.message || e).slice(0, 200) });
        await dec('');
        await sleep(2000);
        continue;
      }
      msgs.push({ role: 'assistant', content: txt });

      // ---- 笔记：模型追加心得 ----
      const diaryAdd = raw.diary_add || raw.note_add;   // 兼容旧字段名
      if (diaryAdd) {
        try {
          const nr = JSON.parse(await ev('JSON.stringify(window.DoLBridge.appendNote(' + JSON.stringify(String(diaryAdd)) + '))').catch(() => '{}'));
          if (nr && nr.ok) { await writeThink({ step: steps, action: '📔 写了一条日记', reason: String(diaryAdd).slice(0, 70) }); }
        } catch (e) { }
      }

      // ---- 表单：搜索框/下拉框/勾选框（模型给 form 字段时先填控件再执行动作）----
      if (raw.form && typeof raw.form === "object") {
        const fnotes = [];
        for (const fi of Object.keys(raw.form)) {
          const fr = JSON.parse(await ev("JSON.stringify(window.DoLBridge.setForm(" + Number(fi) + ", " + JSON.stringify(raw.form[fi]) + "))").catch(() => "{}"));
          fnotes.push("[" + fi + "]=" + JSON.stringify(raw.form[fi]) + (fr && fr.ok ? " 成功" : " 失败" + ((fr && fr.error) || "")));
        }
        if (fnotes.length) { await writeThink({ step: steps, action: "⌨ 填写控件", reason: fnotes.join("，") }); await sleep(700); }
      }
      // ---- 模型按【用户计划】要求汇报：出报告文件 + 面板展示 + 停止 ----
      if (raw.report) {
        const body = String(raw.report).slice(0, 1500);
        const now = await gather();
        const md = ['# AI 阶段汇报（按用户计划）', '',
          '- 时间：' + now.sidebar.weekday + ' ' + now.sidebar.time + '（' + now.sidebar.date + '）',
          '- 地点：' + now.sidebar.location + '（' + now.passage + '）',
          '- 钱：' + (now.sidebar.moneyText || now.sidebar.money),
          '- 状态：' + (now.vitals || []).join('；'),
          '- 穿着：' + (now.look || '—'), '',
          '## 汇报正文', body, ''].join('\n');
        const file = path.join(OUT, 'report-' + Date.now() + '.md');
        try { fs.writeFileSync(file, md, 'utf8'); } catch (e) { }
        await writeSay('📋 阶段汇报\n' + body);
        await writeThink({ action: '📋 已按计划汇报', reason: body.slice(0, 80), note: path.basename(file) });
        say({ event: 'report', file: path.basename(file), text: body });
        await stopRun('已按【用户计划】完成阶段汇报（报告：' + path.basename(file) + '）');
        steps = 0;
        await sleep(2000);
        continue;
      }
      const due = planStopDue(ctx.plan, ctx.sidebar);
      const dueKey = String(ctx.plan || '') + '|' + String(ctx.sidebar.weekday || '');
      if (due && dueKey === planReportedKey) { /* 这份计划今天已经汇报过：不再重复触发，继续正常行动 */ }
      else if (due) {
        planReportedKey = dueKey;
        await dec('计划要求此刻汇报，正在整理…');
        const r1 = await chatOnce(cfg, buildMessages(system, [{ role: 'user', content: due + '\n【自身状态】\n' + (ctx.vitals || []).map(v => '  ' + v).join('\n')
          + '\n【穿着】' + (ctx.look || '—') + '\n【地点】' + ctx.sidebar.location + '（' + ctx.passage + '）· 钱 ' + (ctx.sidebar.moneyText || ctx.sidebar.money)
          + '\n只输出 JSON：{"report":"≤400字汇报：做了什么、花了多少钱、拿到什么、身体与精神状态、下一步打算"}' }]), { temperature: 0.4 });
        let body = '';
        try { body = String(jsonOf(r1).report || ''); } catch (e) { body = String(r1).slice(0, 800); }
        const md = ['# AI 阶段汇报（按用户计划）', '', '- 时间：' + ctx.sidebar.weekday + ' ' + ctx.sidebar.time,
          '- 地点：' + ctx.sidebar.location + '（' + ctx.passage + '）', '- 钱：' + (ctx.sidebar.moneyText || ctx.sidebar.money),
          '- 状态：' + (ctx.vitals || []).join('；'), '- 穿着：' + (ctx.look || '—'), '', '## 汇报正文', body, ''].join('\n');
        const file = path.join(OUT, 'report-' + Date.now() + '.md');
        try { fs.writeFileSync(file, md, 'utf8'); } catch (e) { }
        await writeSay('📋 阶段汇报\n' + body);
        await writeThink({ action: '📋 已按计划汇报', reason: body.slice(0, 80), note: path.basename(file) });
        say({ event: 'report', file: path.basename(file), text: body, reason: '计划停止条件到期' });
        await stopRun('已按【用户计划】完成阶段汇报（报告：' + path.basename(file) + '）');
        saveState();
        await dec('');
        steps = 0;
        await sleep(2000);
        continue;
      }
      if (steps % 15 === 0) {
        const planNow2 = await ev('window.DoLBridge.plan()').catch(() => '');
        if (planNow2) msgs.push({ role: 'user', content: '【提醒·必须遵守】用户计划原文：' + planNow2 + '；到点或计划达成时必须停止并只输出 report 字段。' });
      }
      const hit = acts.find(a => a.i === raw.action_index) || acts.find(a => String(a.text).indexOf(String(raw.action_text || '')) >= 0) || null;
      if (!hit) {
        msgs.push({ role: 'user', content: '【系统】编号 ' + JSON.stringify(raw.action_index) + ' 不在候选里，必须从【可选动作】里选一个编号。' });
        await writeThink({ note: '模型给的编号不在候选里，已要求重选' });
        steps--;
        await dec('');
        await sleep(800);
        continue;
      }

      const before = ctx.passage;
      let combatApplied = null, combatNote = '';
      if (raw.combat && ctx.combat && ctx.combat.length) {
        const norm = normCombat(raw.combat, ctx);
        if (Object.keys(norm.sel).length) {
          combatApplied = await ev(`window.DoLBridge.setCombat(${JSON.stringify(norm.sel)})`).catch(() => null);
          const okList = Object.keys(norm.sel).map(k => k + '=' + norm.sel[k]);
          const badList = (combatApplied && combatApplied.failed) ? combatApplied.failed : [];
          // 读回校验：确认真的选上了（combat() 返回 ['leftaction=0', ...]）
          const readback = JSON.parse(await ev('JSON.stringify((window.DoLBridge.combat()||[]).map(function(g){return g.name+"="+g.selected}))').catch(() => '[]'));
          const readbackObj = {};
          (readback || []).forEach(function (s) { const m = /^([a-z]+action)=(\d+)$/.exec(String(s)); if (m) readbackObj[m[1]] = Number(m[2]); });
          combatNote = '；部位选择 ' + partText(norm.sel, ctx.combat) + '（本回合实际生效：' + partText(readbackObj, ctx.combat) + '）'
            + (badList.length ? ' ⚠未生效:' + badList.join(',') : '')
            + (norm.dropped.length ? ' ⚠无法识别的键:' + norm.dropped.join(',') : '');
        } else if (norm.dropped.length) {
          combatNote = ' ⚠战斗选择全部无法识别：' + norm.dropped.join(',');
        }
      } else if ((ctx.combat || []).length && !raw.combat) {
        combatNote = ' ⚠本回合有战斗部位选项，但模型没有给出 combat 字段（默认全休息）';
      }
      const beforeText = String(ctx.text || '');
      const r0 = await ev(`window.DoLBridge.step(${hit.i}, {timeoutMs:20000})`);
      const after = await gather();
      const novel = !seenPassages.has(after.passage);
      const textChanged = String(after.text || '') !== beforeText;   // 文字每回合都在变 → 事件在推进，不算卡住
      seenPassages.add(after.passage);
      const back = after.passage === before;
      const delta = ctx.sidebar.time + ' → ' + after.sidebar.time;
      const timeMoved = String(after.sidebar.time || '') !== String(ctx.sidebar.time || '');
      lastStepInfo = { n: steps, from: before, to: after.passage, chose: hit.text, delta: delta, back: (after.passage === before && !r0.changed && !timeMoved), novel: novel, timeMoved: timeMoved };
      noNovel = (novel || textChanged) ? 0 : noNovel + 1;

      await writeThink({ step: steps, action: String(hit.text).slice(0, 60), reason: String(raw.reason || '') + combatNote, note: before + ' → ' + after.passage + '　(历史 ' + msgs.length + ' 条 / ' + (lastUsage ? lastUsage.prompt_tokens + ' prompt tokens' : estTokens(buildMessages(system, msgs)) + ' est tokens)') });
      if (raw.daily_goal) {
        currentGoal = String(raw.daily_goal).slice(0, 80);
        await writeThink({ step: steps, action: '\uD83D\uDCC5 今日目标', reason: currentGoal, note: '（由 AI 依属性/社交/日志确定，不是用户计划）' });
        say({ event: 'daily-goal', day: lastDayKey, goal: currentGoal });
      }
      if (raw.reply) await writeSay(String(raw.reply));
      await dec('');
      saveState();
      say({ event: 'step', n: steps, from: before, to: after.passage, chose: hit.text, reason: raw.reason, clock: after.sidebar.time, histMsgs: msgs.length, promptTokens: lastUsage && lastUsage.prompt_tokens, combat: raw.combat || null, combatNote: combatNote || null, rawJson: String(txt).replace(/\s+/g, ' ').slice(0, 300) });

      // 上下文用量回传面板（标题栏/Agent 面板显示）
      const usedNow = (lastUsage && lastUsage.prompt_tokens) || estTokens(buildMessages(system, msgs));
      await ev('window.DoLBridge.ctxUsage(' + JSON.stringify({ used: usedNow, max: CTX_MAX }) + ')').catch(() => null);

      // 上下文压缩
      const used = usedNow;
      if (used >= COMPRESS_LIMIT && msgs.length > KEEP_TURNS * 2 + 2) {
        msgs = await compress(cfg, system, msgs, steps);
        lastUsage = null;
        await ev('window.DoLBridge.ctxUsage(' + JSON.stringify({ used: estTokens(buildMessages(system, msgs)), max: CTX_MAX }) + ')').catch(() => null);
      }

      if (noNovel >= 40) { await stopRun('连续 40 步画面与文字都完全没有变化（疑似真卡住）', before + ' / ' + after.passage); noNovel = 0; }

      // —— 停止条件：到达指定星期几的某个时段（例如"星期一 6-12 点"）——
      if (STOP_DOW && stopRange) {
        const hh = Number(String(after.sidebar.time || '00:00').split(':')[0]);
        const dow = String(after.sidebar.weekday || '');
        if (dow.indexOf(STOP_DOW) >= 0 && hh >= stopRange.a && hh < stopRange.b) {
          await writeThink({ step: steps, action: '🏁 到达停止条件', reason: dow + ' ' + after.sidebar.time + '（要求：' + STOP_DOW + ' ' + STOP_HOURS + ' 点）' });
          try {
            const rep1 = await chatOnce(cfg, buildMessages(system, msgs.concat([{ role: 'user', content: [
              '【停止指令】已到 ' + dow + ' ' + after.sidebar.time + '，本次运行到此结束。',
              '请写一份简短报告（中文，6 行以内），包含：这段时间做了什么（按时间顺序要点）、当前钱与自身状态、当天目标、以及接下来建议做什么。直接输出正文，不要 JSON。'
            ].join('\n') }])), { temperature: 0.4 });
            const report = String(rep1 || '').trim();
            if (report) {
              await writeSay('【本次运行报告】\n' + report);
              writeFile('report-' + Date.now() + '.md', '# 运行报告 ' + dow + ' ' + after.sidebar.time + '\n\n' + report + '\n');
              say({ event: 'report', report: report.slice(0, 600) });
            }
          } catch (e) { say({ event: 'report-error', error: String(e && e.message || e).slice(0, 200) }); }
          await stopRun('已到 ' + dow + ' ' + after.sidebar.time + '（设定的停止时间）', currentGoal ? ('当天目标：' + currentGoal) : null);
          await sleep(2000);
          continue;
        }
      }
      if (after.canSave && steps % 20 === 0) {
        const _cs = Number((ctl && ctl.session && ctl.session.slot != null) ? ctl.session.slot : 0) || 0;
        const _slot = (_cs === 0) ? 1 : _cs;
        saveSlotNow = _slot; curSessionNow = _cs;
        const sv = await ev('window.DoLBridge.save(' + _slot + ', {name:"AI自动档·会话" + _cs})');
        say({ event: 'autosave', slot: _slot, result: sv });
      }
      await sleep(INTERVAL);
    } catch (e) {
      fails++;
      const msg = String(e && e.message || e).slice(0, 400);
      say({ event: 'agent-error', n: fails, error: msg });
      if (fails === 2 || fails % 10 === 0) {
        // 只做提示；**不要**替用户按停止（页面刷新等短暂异常过后会自动恢复）
        await ev('window.DoLBridge.say(' + JSON.stringify('（驱动连接异常，正在自动重连…第 ' + fails + ' 次）') + ')').catch(() => null);
      }
      if (fails === 20) {
        await ev('window.DoLBridge.setRunning(false)').catch(() => null);
        await ev('window.DoLBridge.say(' + JSON.stringify('（连续 20 次连接异常，已自动停止；恢复后点「开始」即可继续）') + ')').catch(() => null);
      }
      if (fails >= 150) { console.error('连续 ' + fails + ' 次失败（约 5 分钟），退出驱动：' + msg); process.exit(2); }
      await sleep(Math.min(3000 + fails * 500, 15000));
    }
  }
process.on('SIGINT', () => { console.log('收到中断，退出'); process.exit(0); });
process.on('exit', (code) => {
  // 尽力而为：退出时把运行状态复位（同步发一帧 WebSocket，不等待）
  try { if (cdp && cdp.ws && cdp.ws.readyState === 1) cdp.ws.send(JSON.stringify({ id: 999999, method: 'Runtime.evaluate', params: { expression: 'window.DoLBridge && window.DoLBridge.setRunning(false)', returnByValue: true } })); } catch (e) { }
  console.error('驱动退出，code=' + code);
});
})().catch(e => { console.error('agent 失败: ' + (e && e.stack || e)); process.exit(1); });
