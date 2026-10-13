# DoLBridge

给 **Degrees of Lewdity**（ModLoader 版）加一层「可被程序驱动」的接口 + 一个**页面内 AI Agent**，让你可以：
用外部脚本/Agent 玩这个游戏，或者**只装一个 mod zip**，让 AI 直接在游戏里自己玩。

> 不是自动化脚本合集，而是一个**把游戏界面结构化成 JSON** 的桥接层：AI 读 JSON 决策 → 桥接层派发**真实 DOM 点击** → 游戏怎么运行还怎么运行。不修改游戏变量、不写死任何第三方接口。

## 目录

| 路径 | 说明 |
| --- | --- |
| `mod/` | Mod 源码（`DoLBridge.js` / `boot.json` / 说明）—— 想看代码或自己改的看这里 |
| `tools/` | **可选**的外部驱动（Node.js）：接口被 CORS 拦住时用它跑，无跨域限制 |
| `dist/DoLBridge.mod.zip` | **推荐**：直接装进 ModLoader 就能用（含页面内 AI Agent）|
| `dist/DoLBridge-tools.zip` | 外部驱动 + 自检脚本 + 启动调试浏览器的 bat |

## 快速开始（推荐：只装 mod）

1. 下载 `dist/DoLBridge.mod.zip`
2. 放进游戏的 `mods/` 目录（或用 ModLoader 的「安装 mod」选这个 zip）
3. 刷新游戏 → 右下角出现一个小浮窗
4. 浮窗里填 **API 配置**（Base URL / 模型 / API Key）→ 保存 → 点「开始」

> 页面内 Agent 直接用浏览器的 `fetch` 调你填的接口 —— 所以**该接口必须允许浏览器直连（CORS）**。
> 如果被 CORS 拦住，换用下面的外部驱动。

## 外部驱动（接口不允许浏览器直连时）

```bash
node tools/agent.js --port 9222 --interval 900 --out ./agent-out
```

- `--port` 调试端口（游戏需以 `--remote-debugging-port=9222` 启动，见 `tools/启动调试浏览器.bat`）
- `--interval` 每步间隔毫秒 · `--max-steps` 单次运行步数上限 · `--compress-at` 记忆压缩阈值
- 驱动在线时**页面内 Agent 会自动让位**（两者不会同时抢操作）

先跑一次自检：

```bash
node tools/check.js --port 9222
```

会依次检查：端口 → 页面 → mod → JS 接口 → 驱动依赖 → 游戏状态。

## 面板里有什么

| 分页 | 内容 |
| --- | --- |
| **总览** | 当前决策 · 开始/停止 · 会话 · 计划 · 日记 · 系统提示词 |
| **对话·思考** | 和 AI 对话（输入框在对话区下方）· 思考过程（两块都能拖拽改高度）|
| **配置** | API 配置（逐项有说明）· Agent 参数（上下文 / 压缩阈值 / 步数上限）|

- **计划 / 日记**：改完要**点「保存」**才生效（有改动时按钮变黄提示）
- **日记**：每个会话独立；AI 自己往里写（格式：第一行游戏内日期 + 正文），你也能编辑；删除会话会一起删掉
- **会话**：一个会话 = 一套记忆（计划/日记/对话/思考），并且对应游戏的一个存档格（默认会话 ↔ 存档格 1，会话 N ↔ 存档格 N）——AI 存档只写当前那个格子，不会碰你别的存档

## AI 侧接口（给写脚本的人）

`window.DoLBridge` 常用方法：

```js
DoLBridge.observe({maxChars: 2000})   // 画面：passage 标题/正文、可点动作、表单控件、战斗部位、状态
DoLBridge.step(i)                     // 点第 i 个动作并等待画面稳定
DoLBridge.setForm(i, value)           // 填输入框 / 选下拉 / 勾选框
DoLBridge.setCombat({leftaction: 1})  // 战斗：按部位选动作
DoLBridge.sidebar()                   // 侧边栏：时间/地点/钱/体征/穿着/提示
DoLBridge.vitals()                    // 体征（百分比 + 文字）
DoLBridge.wardrobe() / look() / worn() // 衣柜界面 / 穿着 / 分部位穿戴
DoLBridge.save(slot) / load(slot) / canSave()
DoLBridge.thoughts() / chat() / plan() / notes()   // 面板数据（日记 = notes）
DoLBridge.agentConfig({...})          // 改运行参数
DoLBridge.embedded.start() / stop()   // 页面内 Agent
```

完整列表见 `mod/README.md`。

## 隐私

- **mod 与驱动都不含任何 API Key**，也不写死任何第三方接口地址；Key 只存在你本机浏览器里（或你传给驱动的配置中）
- 只有在你配置了接口并点「开始」之后，游戏状态才会被发到**你自己填的那个地址**
- 仓库自带的构建审计脚本会检查发布包内不含密钥/隐私路径

## 免责

仅供学习与个人娱乐使用。请遵守游戏原作者的使用条款；使用第三方模型接口产生的费用与风险由使用者自行承担。

## License

MIT
