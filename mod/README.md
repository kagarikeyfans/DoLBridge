# DoLBridge —— 《Degrees of Lewdity》AI 驱动桥接模组

给 Degrees of Lewdity（配合 DoL-ModLoader / SC2 Mod Loader）挂一个"可以被外部程序驱动"的接口，
并在游戏页面上放一个**悬浮控制台**：让 AI（或脚本）读画面、做决策，把计划和思考过程实时显示出来。

> **装一个 zip 就能用**：模组自带 Agent 循环（页面内运行），填好 API 配置、点「开始」即可。
> 唯一的附加要求是：**你用的模型接口允许浏览器直连**（CORS）。
> 实测 DeepSeek 官方 API 可以；被 CORS 拦住的接口（例如某些聚合网关）请改用随附的 `tools/` 外部驱动。
>
> 模组本身不含 AI 模型、**不上传任何数据**；除了你自己配置的接口，它不向任何第三方发请求。

---

## 安装

1. 打开游戏的 ModLoader 界面 →「添加 mod」→ 选择 `DoLBridge.mod.zip`（不用解压）
2. 刷新页面；页面左下角会出现悬浮标题栏：`🤖 AI ▸ 07:01 · Domus Street`
3. 点开标题栏 →「API 配置」→ 填 Base URL / 模型 / API Key → 保存（需要额外请求头的服务，用「额外请求头」逐行填）
4. 点 **「▶ 开始」** —— 内置 Agent 就会开始自己玩，计划和思考过程实时显示在面板上

要求：Degrees of Lewdity 0.5.x + DoL-ModLoader（SC2 Mod Loader）2.x。
本模组在 0.5.12.13 + ModLoader 2.101.1 上开发与测试。

---

## 外部驱动（可选：接口被 CORS 拦住时用）

> 内置 Agent 直接调用你的 API；如果该服务**不允许浏览器直连**（页面里会提示"连不上模型接口（可能是 CORS）"），
> 就用 `tools/` 里的外部驱动：它在本机进程里调用接口，不受 CORS 限制，并通过调试端口驱动游戏。
>
> 两种方式**互斥且自动切换**：外部驱动一发心跳，内置 Agent 就让位；驱动断开后内置 Agent 自动接管。
> 面板状态会写明当前是「（内置 Agent · 第 N 步）」还是「（外部驱动）」。

驱动是随附的 **tools/** 工具包（需要 Node.js 18+），用法见其中的 README：

```
启动调试浏览器.bat      # 用调试端口启动游戏（普通双击启动的浏览器连不上驱动）
node check.js           # 环境自检：端口 / 页面 / mod / API 配置 / 驱动心跳，逐项给结论
node agent.js           # 启动驱动；标题栏 ⚪ → 🟢 后即可点「开始」
```

常见问题速查：**「点开始没反应」= 驱动没在跑**；**「标题栏一直 ⚪」= 浏览器没用调试端口启动**。
两个都用 `node check.js` 一测就知道。

## 悬浮控制台

标题栏（**可拖动、可拉伸**）：`🤖 AI ▾ 07:46 · 卧室 · ✔ #12 刷牙 · ▶ · ctx 2.6k/1M 🟢`

| 元素 | 含义 |
| --- | --- |
| ▸ / ▾ | 折叠 / 展开（单击标题栏切换；拖动改位置；右下角把手改大小） |
| 时间 · 地点 | 游戏内时间与当前 passage |
| ⏳ / ✔ #N | 当前决策点：正在决策 / 最近一次决策 |
| ▶ | 正在自动运行 |
| ctx a/b | 上下文用量（由外部驱动回传） |
| 🟢 / ⚪ | 外部驱动是否在线（心跳） |

展开后从上到下：

- **▶ 开始 / ■ 停止**：让外部驱动开始/停止自主决策；另有 `清空思考`、`位置`（复位窗口位置与大小）
- **会话**：每个存档一套独立记忆（计划/思考/对话/系统提示词），互不串味
  - `切换` 只切记忆；`新建会话` 绑定下拉选中的存档槽（名字取存档名；该槽已有记忆时只切换、不清空）；`删会话` 只删记忆不删存档（默认会话不可删，另有自动备份可用 `restoreSessions()` 恢复）
  - **换存档请手动切换会话**：游戏的 `window.idb` 是 frozen 对象，无法挂钩读档事件做自动切换
- **计划**（可编辑）：**只由你维护**，AI 不会自动改写；外部驱动会把它当目标
- **系统提示词**（可折叠）：内置"任务说明 + 行为约定 + 城镇地图 + 游戏小贴士"，可编辑、可一键恢复默认
- **API 配置**（可折叠）：多套配置可切换，每套含 Base URL / 模型 / API Key / 温度 / **额外请求头**（每行 `名: 值`）
- **Agent（上下文 · 压缩阈值）**：上下文上限（默认 1,000,000）与自动压缩阈值（默认 200,000），并显示实时用量
- **对话**：给 AI 下指令（回车发送），AI 回复也在这里。问"看看我的属性/特质/社交/统计"时，
  外部驱动会读取游戏内**真实面板数据**再回答（不会拿侧边栏糊弄）
- **思考过程**（默认折叠、限高滚动）：每步的「选择 + 理由 + 页面跳转」

---

## 给外部驱动的 API

在游戏页面的 JS 环境里调用（也可以通过浏览器的远程调试端口从外部脚本调用）。

```js
// 观察与操作
DoLBridge.observe({maxChars})      // {passage:{title,tags,text}, actions:[{i,text,nav}], forms, combat, digest, meta}
DoLBridge.act(i) / step(i)         // 点击第 i 个动作（真实 DOM 点击）/ 点击并等待画面稳定
DoLBridge.clickText('离开')        // 按文字点击
DoLBridge.setForm(i, value)        // 设置表单控件
DoLBridge.setCombat({mouthaction:2, feetaction:1})   // 战斗界面：按部位选择动作
DoLBridge.wait({quietMs, timeoutMs})
DoLBridge.undo() / redo() / history() / goto(title)
DoLBridge.reroll()                 // 推进一次 PRNG（调试随机事件用）

// 数据
DoLBridge.vitals()                 // 生命体征（见下）
DoLBridge.sidebar() / character() / social()
DoLBridge.panel('characteristics'|'traits'|'social'|'journal'|'statistics'|'feats', {limit, chars})
DoLBridge.varsAt(['stress','player.gender'])
DoLBridge.save(slot,{name}) / load(slot) / saves() / slots() / saveBackend()

// 控制台
DoLBridge.control()                // {running, plan, api, system, session, chat, thoughts, current, driver}
DoLBridge.setRunning(true|false) / isRunning() / heartbeat({name}) / deciding('正在…')
DoLBridge.setPlan(t) / plan()      // 计划（由用户维护）
DoLBridge.think({step,action,reason,note}) / thoughts(n) / clearThoughts()
DoLBridge.chat(t) / say(t) / messages(n) / clearMessages()
DoLBridge.systemPrompt() / setSystemPrompt(t) / resetSystemPrompt() / defaultSystemPrompt()

// 多套 API 配置 / Agent 配置 / 上下文用量
DoLBridge.profiles() / setProfile(i) / newProfile(name) / removeProfile(i) / setApi({...})
DoLBridge.agentConfig() / setAgentConfig({contextWindow, compressAt})
DoLBridge.ctxUsage({used, max}) / ctxInfo()

// 会话
DoLBridge.sessions() / session() / switchSession(slot) / newSession(slot) / removeSession(slot)
DoLBridge.sessionsBackup() / restoreSessions()

// 事件与元信息
DoLBridge.onChange(cb) / offChange(cb) / log(n) / status() / version
```

### 外部驱动的典型循环

1. `heartbeat({name})` 每 1-2 秒一次（标题栏的 🟢 就是这个）
2. 读 `control()`：`running` 为真时才开始决策
3. 每步：`observe()` + `vitals()`（+ 需要时 `panel(...)`）→ 交给模型 → `setCombat()`（若有战斗）→ `step(i)`
4. 把结果写回面板：`think({step,action,reason,note})`、`deciding('正在问模型…')`、`say(...)`、`ctxUsage({used,max})`
5. 出错页/控制台异常/没有进展时 `setRunning(false)` 并在 `think`/`say` 里说明原因

---

## 生命体征（决策的核心数据）

`DoLBridge.vitals()` 返回 `{items, alerts, guide, ladderText, text, textDetail}`，每项形如：

```js
{ key:'stress', label:'压力', value:67, max:10000, percent:0.7, pctText:'0.7%',
  tier:'几乎为零', severity:0, caption:'你很平静', next:{at:2000,text:'勉强保持镇定',gap:1933},
  brief:'压力：0.7%，你很平静', detail:'压力 67/10000 = 0.7%（几乎为零）— 你很平静 ｜ 下一阶段 ≥2000…' }
```

- `brief` 是**对外主格式**：`项目：百分比，文字描述`（例：`疼痛：0%，你感觉良好`）
- 百分比 = 占上限比例；疼痛以 100（无法行动线）为 100%，可以超过 100%
- `caption` 直接渲染游戏自己的侧边栏文案，与游戏显示完全一致
- 上限：性奋 10000、疲劳 2000、压力 10000、创伤 5000、自控 1000（越高越好）、诱惑 8000×好感修正

---

## 存档说明

游戏有两套存档后端，模组会自动适配：

- **idb**（新版）：`save(slot,{name})` 走 `window.idb.saveState`；槽位 0-199（游戏存档界面 20 页 × 10）
- **legacy**（旧版）：SugarCube 的 9 个槽位

`load(slot)` 会先刷新存档列表再读取；**存档不存在时返回 `{ok:false, error}`**，不会静默成功。

---

## 隐私

- 模组**不联网、不上传任何数据**，源码中不包含任何 API Key 或第三方服务配置
- 你在「API 配置」里填的 Base URL / Key / 自定义请求头，以及会话记忆、计划、思考记录，
  **只保存在本机浏览器的 `localStorage`**（键前缀 `DoLBridge_`）；清理浏览器数据或卸载即消失
- 会话记忆有本地滚动备份（`DoLBridge_sessions_bak`），可用 `restoreSessions()` 恢复

---

## 免责

本模组是《Degrees of Lewdity》的第三方同人工具，**不包含游戏本体**，与原作者 Vrelnir 无关。
游戏内容面向成年人，请自行确认符合当地法律与年龄限制。
