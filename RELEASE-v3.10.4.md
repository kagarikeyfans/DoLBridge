## DoLBridge v3.10.4

修复一个**会弹出报错框**的问题，以及由此暴露的输入控件处理缺陷。

### 修复：setForm 触发游戏报错框

现象：
```
Error: Cannot read properties of undefined (reading 'startsWith')
  at HTMLDocument.<anonymous> ...
  at Object.setForm ...
```

原因：桥接层填写输入框时会派发合成事件；其中 range / number 控件上发的是**普通 Event('keyup')**，
而 DoL 的「数字快捷键」(numberify) 模块在 document 上监听 keyup 并直接读 `ev.code.startsWith(...)`
—— 普通事件没有 code，于是抛错并被 SugarCube 显示成报错框。

修复：
- 键盘类事件改用 KeyboardEvent（带 key / code 字段），不再发「裸事件」
- 去掉 range / number 上多余的合成 keyup（游戏侧本来就监听 input change）
- 新增错误兜底：派发合成事件期间压住游戏侧 handler 抛出的异常，不让它冒到 SugarCube 弹框；
  被压住的错误会记进 setForm() 返回值（swallowedErrors），便于排查
- 顺手修掉一个真 bug：setForm 内部的失败分支（下拉里没有该选项 / 同组没有匹配单选框）
  原本会被当成成功返回

### 验证

| 派发的事件 | 结果 |
| --- | --- |
| 裸 Event('keyup')（修复前写法）| 复现 startsWith 报错 |
| KeyboardEvent（带 code）| 0 报错 |
| input + change | 0 报错 |

并核对游戏源码：商城搜索框监听 input change（$('#textbox--shopnamefiltertextbox').on('input change', ...)），
桥接层派发的事件类型正确，搜索功能本身可用。

### 安装

下载 DoLBridge.mod.zip → 放进 mods/（或 ModLoader 安装）→ 刷新游戏。
接口被 CORS 拦住时用 DoLBridge-tools.zip 里的外部驱动。
