# dsh-tui MVP

基于 `eye_declare` 的 dsh 内联终端界面。TypeScript 在同进程驱动一个 dsh Agent，Rust 通过 N-API 在专用线程运行终端，不需要 `dsh web`、HTTP 服务或独立启动器。

这是可试用的 MVP，不是跨平台正式版本。`DESIGN.md` 保留早期 Ink 提案；当前实现以本 README 为准。

## 本地启动

需要 Node `^22.19.0 || >=24`、Rust ≥1.88、pnpm 和本机编译工具。当前验证环境为 macOS arm64、Node 24.14、Rust 1.98.1、pnpm 11.22。

```sh
npm ci
npm run build
npm exec -- dsh plugin --profile tui add "$PWD"
npm exec -- dsh --profile tui
```

`npm exec -- dsh` 使用本项目锁定的 **dsh 0.1.5-rc.2**。接口包也锁定同一版本，不适配旧 dsh；如果使用全局 `dsh`，需自行确认版本一致。

模型与凭证沿用 dsh 自己的设置。`dsh-base` 原始默认模型为 `deepseek-flash`，但 `~/.dsh/settings.yaml` 中保存的 `agent-default-model` 优先；TUI 不会擅自覆盖共享设置。底栏显示实际选择的 provider/model，可用 `/model` 切换。例如已配置 `DEEPSEEK_API_KEY` 或 dsh 的凭证文件，就不需要为 TUI 再配置一份。未配置模型凭证时，界面仍能启动，提交后会显示模型错误。

```sh
npm exec -- dsh --profile tui --help
npm exec -- dsh --profile tui --dump-config
```

`tui` profile 由 `dsh-base` 后接本 bundle 组成。非 TTY 会明确失败，不切换成另一种运行模式。测试使用临时 `DSH_HOME`，不会修改你的实际 profile 或会话。

## 当前能力

- 新建并持久化会话，连续多轮对话；`/new` 关闭旧会话后创建新上下文，不清除或重放终端历史。
- pi 风格消息分层、输入分隔线、动态模型/状态/目录底栏；沿用当前终端的 ANSI 调色板，支持非空 `NO_COLOR`。
- 流式阶段显示纯文本末尾预览，不显示 reasoning；最终回答按基础 Markdown 定稿一次：标题、强调、有序/无序列表、引用、行内代码和代码块。用户输入与工具/日志内容保持字面文本。
- 回答和工具终态进入真实终端历史；底部活动区最多 4 行，命令/模型候选位于输入框下方、状态栏上方，不开启备用屏幕。
- 运行时仍可编辑输入；提交走 `steer()`，空闲提交走 `followup()`。
- 工具运行、完成和失败摘要，使用工具提供的 presentation；缺失或出错时使用通用标题。终端类结果附带 exit code / signal，不展开完整工具输出。
- Slash commands 走 dsh 命令服务，未知命令不会进入模型上下文；输入 `/` 从当前 Agent 的真实注册表列出命令，支持筛选、补全和键盘选择。
- 审批默认拒绝，只有 `y` 允许一次；其他 Agent 的请求委托给下游策略。
- 单选、多选、自由文本问题；审批和问题共用 FIFO，取消和过期答案不会错配。交互前的普通草稿与光标会恢复。
- 左右/Home/End/Backspace/Delete、Ctrl+A/E/U/K/W、进程内上下输入历史；中文和普通 emoji；粘贴换行折叠为空格，不自动提交。
- Node 的 stdout/stderr 写入统一经过安全文本投影，不直接打断输入行。
- 正常退出、Ctrl+C、SIGINT、SIGTERM 后恢复原 shell，并 flush 会话、释放 Agent。

### 命令

| 命令 | 行为 |
|---|---|
| `/help` | 当前 Agent 可用命令与按键说明 |
| `/model` | 显示当前/默认模型，打开可搜索的模型列表 |
| `/model provider/model` | 验证并切换当前会话模型；省略 provider 时沿用当前 provider |
| `/new` | 空闲时 flush 并释放旧 Agent，创建新会话；新会话使用已保存的默认模型 |

`/model` 普通选择或直接参数切换**仅影响当前会话**。模型列表中 **Ctrl+S** 才会保存默认值，影响所有共用 dsh 设置的 profile；界面会明确提示。切换模型与底栏、实际请求共用同一个选择引用。运行中不能切模型或新建会话，请先停止工作。

dsh 已有命令直接从注册表使用，不重新实现。

### 按键

| 场景 | 操作 |
|---|---|
| 空闲 | Enter 提交；Esc / Ctrl+C 清空非空草稿 |
| 空闲且输入为空 | Ctrl+D 退出 0；Ctrl+C 退出 130 |
| Agent 运行 | Enter 追加 steering；Esc / Ctrl+C 停止工作 |
| 命令菜单 | 输入 `/` 筛选；上下选择；Tab 只补全；Enter 执行；Esc 关闭菜单并保留草稿 |
| 模型列表 | 输入搜索；上下选择；Enter 仅本会话；Ctrl+S 保存默认；Esc 取消 |
| 命令执行 | Esc / Ctrl+C 取消；不接收新提交，但可编辑下一条草稿 |
| 审批 | `y` + Enter 允许一次；`n` 或空 Enter 拒绝 |
| 问题 | 单选输入编号或自定义文本；多选输入逗号分隔编号；空 Enter 跳过 |

`/new` 进入旧 Agent 关闭/新 Agent 创建的短暂切换阶段后，Esc / Ctrl+C 会安全退出，不尝试恢复已释放的 Agent。

操作系统的信号由 dsh launcher 处理。当前 dsh 版本将正常 SIGTERM 退出码定义为 **0**，SIGINT 为 **130**；插件不另装一套退出策略。

## 终端引擎补丁与限制

渲染、布局、Markdown 与 grapheme 编辑仍使用现成框架，不是自写 renderer，但不是完全未修改的 eye_declare 0.7.1。`native/vendor/` 保留两份源码补丁：

- [引擎补丁](native/vendor/eye_declare_engine/README.md)：修正光标行截断被误算为重排、高度缩小后重绘清空历史，以及输入框下方内容重排导致光标报告漂移、候选残留的问题。空间不足时只滚动补足缺少的行；无法确认重排时宁可少擦留残影，不多擦历史。
- [Markdown 补丁](native/vendor/eye_declare/README.md)：补齐引用、编号列表与列表标记的无色样式。

原始失败用例和两类光标行 reflow 设置均保留。未隐藏硬件光标、未进入备用屏幕、未重打已定稿内容。

已知边界：

- 反复缩到只有 3 行，仍可能把旧活动行挤入滚动记录；保守的 resize 处理也可能留下临时残影。
- 自动测试使用真实 PTY + headless xterm，不能替代所有真实终端和中文输入法候选窗的人工验收。复合 ZWJ emoji 的真实字形仍未验收。
- Linux、Windows、原生进程崩溃等尚未做完整验证；不要把正常退出检查理解为任意强制终止都能恢复。
- 输出协调覆盖 Node streams；绕过它们直接写终端 fd 的第三方插件尚不支持。
- 没有会话选择/恢复、附件、多行编辑器、PTY 工具全屏接管或界面扩展接口；复杂 Markdown 表格与代码语法高亮未验收，流式预览暂不做 Markdown 排版。
- 原生模块目前在安装时从源码构建；还没有各平台预编译 npm 包，也没有发布到 npm。构建通过原子替换发布 `.node`，不原地改写已加载的动态库；重新构建后需要重启 dsh 才会使用新版界面。

## 打包安装

```sh
npm run build
npm pack
npm exec -- dsh plugin --profile tui add "$PWD/ekil9-dsh-tui-0.1.0-mvp.0.tgz"
```

pnpm 可能阻止本地 tarball 的构建脚本。这时只批准本包，不要全局放开所有依赖脚本：

```sh
npm exec -- dsh plugin --profile tui approve-builds
npm exec -- dsh plugin --profile tui rebuild @ekil9/dsh-tui
npm exec -- dsh plugin --profile tui install
```

最后一次 `install` 让 launcher 同步 bundle 列表。pnpm 11 对本地 tarball 使用带 `@file:...` 的精确构建审批键；仅指定包名的 `--allow-build` 不一定足够。本仓库安装测试会在隔离 profile 中只批准被测 tarball。

## 开发与验证

本机已通过：9 项 Controller 测试、30 项终端回归测试（含原生模块加载检查）、1 项打包安装/双会话冷读测试、106 项组件单元测试、64 项引擎测试，以及 TypeScript 与 Rust fmt/clippy 检查。测试 adapter 不调用真实模型 API。

```sh
npm test                    # Controller behavior tests
npm run typecheck
npm run test:pty             # Real launcher, Agent, tools, and terminal
npm run test:install         # tarball installation and cold-read persistence across /new
cargo fmt --manifest-path native/Cargo.toml --check
cargo clippy --manifest-path native/Cargo.toml --locked -- -D warnings

# Vendored component and engine regressions
cargo test --manifest-path native/vendor/eye_declare/Cargo.toml \
  --no-default-features --features markdown --lib --locked --target-dir native/target
cargo test --manifest-path native/vendor/eye_declare_engine/Cargo.toml \
  --features test-util --locked --target-dir native/target
```

模型测试 adapter 只替换 LLM 系统边缘，不需要 API key；launcher、Cordis、Agent loop、工具、命令、审批、用户问题、持久化和原生终端走真实实现。没有据此宣称真实付费模型请求也已验收。

PTY 检查包括历史唯一性、禁用 alternate screen / `CSI 3J`、硬件光标、粘贴、异步日志、resize，以及退出后同一个 bash 的 `stty -g` 和实际读入/回显。产物保存到忽略版本控制的 `artifacts/`。

```text
src/index.ts          Cordis 插件入口
src/startup.ts        参数与帮助
src/application.ts    Agent、事件、命令和完整关闭流程
src/controller.ts     有序会话投影与界面快照
src/commands.ts       /help 与命令说明
src/model-command.ts  模型验证、会话切换和显式保存默认
src/model-picker.ts   可取消且隔离过期答案的模型选择
src/interactions.ts   审批/问题 FIFO
src/terminal.ts       N-API 终端适配
src/output.ts         Node 输出协调
src/display-text.ts   安全显示文本
native/src/lib.rs     eye_declare 应用、内置编辑器及线程消息传递
```

前期选型证据保留在 `experiments/`；实验套件中的已知失败不属于 MVP 默认测试命令。
