# DoLBridge 外部驱动（tools）

「开始」按钮本身不会玩 —— 它只是给**外部驱动**发信号。这个目录里就是驱动，
需要 **Node.js 18+**（`node -v` 能出版本即可）。

---

## 一、三步跑起来

### 1) 用调试模式启动游戏

普通双击启动的浏览器**不带调试端口**，驱动连不上（这也是「点开始提示驱动已断开」最常见的原因）。

- 把本目录的 **`启动调试浏览器.bat`** 放到游戏目录（和 `Degrees of Lewdity.html` 同级），双击；
  或者把 `Degrees of Lewdity.html` 直接拖到该 bat 上。
- 手动启动等价于（**先完全退出 Chrome**，否则不会生效）：

  ```
  chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\dol-debug" "…\Degrees of Lewdity.html"
  ```

### 2) 装 mod、填 API

- ModLoader →「添加 mod」→ 选 `DoLBridge.mod.zip` → 刷新页面（F5）
- 页面左下角出现 `🤖 AI ▸ …` 即成功；点开标题栏 →「API 配置」→ 填 Base URL / 模型 / API Key → 保存
  （任何 OpenAI 兼容的 `/chat/completions` 服务都可以；协议要求的自定义请求头可以在「额外请求头」里逐行填）

### 3) 启动驱动

```
node check.js            # 先自检，看环境有没有问题
node agent.js            # 自检通过后启动驱动（会自动读面板里的 API 配置）
```

驱动启动后，悬浮窗标题栏的 ⚪ 会变成 **🟢**，这时再点面板里的 **「▶ 开始」**。

---

## 一·五、哪些接口必须用驱动（CORS）

内置 Agent 直接在游戏页面里调用你的接口。**浏览器能不能直连，取决于接口服务方**：

| 接口 | 页面直连 | 说明 |
| --- | --- | --- |
| DeepSeek 官方 `api.deepseek.com` | ✅ 可以 | 填进面板就能用，不需要本工具 |
| OpenCode Go / zen `opencode.ai` | ❌ 不行 | **必须用驱动**，原因见下 |

OpenCode Go 用不了浏览器直连，有两个硬性原因：

1. **CORS**：浏览器发请求前要先发 `OPTIONS` 预检，zen 返回 404 且不带任何 `Access-Control-Allow-*` 头 ——
   即使请求本身返回 200，浏览器也会拦掉响应。（实测：预检 404；带 Origin 的 POST 返回 200 但无 allow-origin）
2. **User-Agent**：zen 文档要求客户端「用自己的 UA 标识自己，而不是通用 SDK / HTTP 库名」，
   而浏览器**禁止 JS 设置 User-Agent**，这条永远满足不了。

驱动已经按文档要求做了处理，**用 zen 时不用你手动配置**：

- 自动带 `User-Agent: DoLBridge-Agent/3.0 (+node; coding-agent)`
- 自动补 `x-opencode-session: dolbridge-xxxxxxxx`（首次生成后持久化在 `agent-out/.zen-session`，保证同一对话稳定）

zen 的配置示例（面板「API 配置」里填）：

| 字段 | 值 |
| --- | --- |
| Base URL | `https://opencode.ai/zen/go/v1` |
| 模型 | `deepseek-v4.1-flash`（或其它 `/chat/completions` 类模型，见下） |
| API Key | 你在 OpenCode Console 复制的 key |

> 注意：zen 上有些模型走 `/messages`（Claude / MiniMax / Qwen3.x）或 `/responses`（Grok / GPT / Muse Spark），
> 本驱动只走 OpenAI 兼容的 `/chat/completions`。可用的例如 `deepseek-v4.1-flash`、`glm-5.3-flash`、`kimi-k2.6`、`longcat-2.0`。
> 想零成本试驱动，可以用 zen 的免费模型 `longcat-2.5-preview-free` / `step-5-preview-free`。

## 二、出问题怎么定位

**第一步永远是自检**：

```
node check.js
```

它会依次报出下面每一项，并直接告诉你缺什么：

| 检查项 | 通过 | 不通过时的原因与处理 |
| --- | --- | --- |
| 1 调试端口 | ✅ 端口可用 | ❌ 浏览器没用调试模式启动 → 用第 1 步的方法（要**完全退出** Chrome 再启动） |
| 2 游戏页面 | ✅ 找到页面 | ❌ 游戏页没打开，或端口指向了别的浏览器实例 |
| 3 Mod 是否加载 | ✅ 版本号 | ❌ `window.DoLBridge` 不存在 → mod 没装好/没刷新页面 |
| 4 API 配置 | ✅ 有 URL+Key | ❌ 没填 → 面板「API 配置」里填好并保存 |
| 5 驱动心跳 | ✅ 在线 | ❌ 驱动没跑 → `node agent.js`（**这就是「点开始提示驱动已断开」的原因**） |
| 6 游戏状态 | ✅ 画面/时间/钱 | ⚠ 只看信息 |

**常见现象对照**：

- **点「开始」没反应 / 提示"驱动已断开？点「开始」重连"** → 驱动没在跑，或驱动与浏览器断开了。
  先 `node check.js`，再 `node agent.js`；标题栏变 🟢 后点「开始」。
- **标题栏一直 ⚪** → 同上；另外确认 `node agent.js --port 9222` 的端口和浏览器启动端口一致。
- **开始后不动 / 一直"正在问模型…"** → 推理型模型单步要 5-20 秒，属正常；若长期无输出，看驱动终端里的报错。
- **驱动报 401/400/模型不可用** → 面板里的 Base URL / 模型名 / Key 不对，或该服务要求额外的请求头。
- **刷新页面后要重新点「开始」** → 正常行为：刷新会让游戏回到标题画面，运行开关也会复位。

---

## 三、驱动都做了什么

```
node agent.js [--port 9222] [--interval 900] [--out ./agent-out]
              [--compress-at 200000] [--keep-turns 4]
              [--max-steps 500] [--stop-dow 星期一] [--stop-hours 6-12]
```

- 每 5 秒向页面发一次心跳（标题栏 🟢）
- 「开始」被按下后：观察画面 → 读生命体征/面板 → 问模型 → 应用战斗部位选择 → 点动作 → 把「选择+理由」写回思考区
- 维护**完整对话历史**，超过压缩阈值时自动让模型把历史压成结构化记忆（结果落在 `agent-out/agent-memory.md`）
- 每步写入 `agent-out/agent-log.jsonl`（含 prompt tokens、模型的原始 JSON，排查问题用）
- 出错页 / 控制台严重错误 / 长时间无进展 / 到达步数上限 / 到达指定星期几时段 → 自动停止并在面板说明

面板「Agent」区可以改：上下文上限、压缩阈值、单次运行步数上限（命令行显式传参时以命令行为准）。

---

## 四、隐私

驱动在**你本机**运行，只通过 `127.0.0.1` 的调试端口和游戏页通信；除了你自己配置的 AI 接口之外，
不会把任何数据发到别处。API Key 只存在浏览器 localStorage 与你的配置里，本工具目录不含任何密钥。
