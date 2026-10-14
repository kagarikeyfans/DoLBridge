## DoLBridge v3.10.6

启动器（`启动调试浏览器.bat`）最终定稿。修两个真实问题：

### 1. 编码（v3.10.5 已修）
旧脚本的中文是坏编码 —— cmd 逐字节读取、受代码页影响，中文行会被读坏甚至当成命令执行。
现在 bat 为 **GBK 编码** + `chcp 936`（中文 Windows 的原生代码页）。

### 2. 路径被空格切开（本次修复）
上一版用 PowerShell 的 `Start-Process -ArgumentList` 启动，而它**不会自动给参数加引号**，
游戏路径里的空格（`Degrees of Lewdity.html`）会被拆成三个参数，Chrome 于是打开 **3 个标签页**。

现在改回 bat 的标准写法（路径显式加引号）：

    start "" "%BROWSER%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" "%GAME%"

### 新增
- **自诊断日志**：`%TEMP%\dolbridge-launch.log`，记录识别到的游戏路径、浏览器、端口，出问题可直接看
- 端口占用检测、Chrome/Edge 自动查找、游戏 html 自动查找（通配 `*Lewdity*.html`）、配置目录按端口隔离

### 实测
在真实游戏目录运行：识别游戏与 Chrome 正确，**9269 端口拉起 Chrome，只有 1 个标签页，URL 正是游戏 html**。
