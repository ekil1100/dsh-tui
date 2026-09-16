# dsh-tui MVP

基于 `eye_declare` 的 dsh 内联终端界面。TypeScript 在同进程驱动一个 dsh Agent，Rust 通过 N-API 在专用线程运行终端，不需要 `dsh web`、HTTP 服务或独立启动器。

这是可试用的 MVP，不是跨平台正式版本。`DESIGN.md` 保留早期 Ink 提案；当前实现以本 README 为准。

## 本地启动

需要 Bun 1.4、Node `^22.19.0 || >=24`、Rust ≥1.88、pnpm 和本机编译工具。当前验证环境为 macOS arm64、Bun 1.4.0、Node 24.14、Rust 1.98.1、pnpm 11.22。

```sh
bun install --frozen-lockfile
bun run build
bun run dsh plugin --profile tui add "$PWD"
bun dev
```

首次使用需要完成上面的依赖安装和 profile 注册。之后在仓库目录执行 `bun dev`，会先构建当前代码，再启动 `tui` profile；不自动重启运行中的会话。只想启动已有构建时，用 `bun run dsh --profile tui`。

本仓库使用 Bun 管理依赖、构建命令和打包，只维护 `bun.lock`。`bun run dsh` 使用本项目锁定的 **dsh 0.1.5-rc.2**，并遵循其 Node shebang；不要加 `--bun` 强制更换宿主运行时。dsh 的 profile 仍由上游内置的 pnpm 管理，发布包的安装脚本也仍用 Node，不要求插件使用者额外安装 Bun。接口包锁定同一 dsh 版本，不适配旧 dsh；如果使用全局 `dsh`，需自行确认版本一致。

Bun 的安装脚本白名单只包含 `node-pty` 和 `@deepseek-ai/dsh-subprocess-local`，用于准备 PTY 原生依赖及恢复 spawn-helper 执行权限。其他依赖的脚本保持拦截，不要全局放开 `trust --all`。

模型与凭证沿用 dsh 自己的设置。`dsh-base` 原始默认模型为 `deepseek-flash`，但 `~/.dsh/settings.yaml` 中保存的 `agent-default-model` 优先；TUI 不会擅自覆盖共享设置。底栏显示实际选择的 provider/model，可用 `/model` 切换。例如已配置 `DEEPSEEK_API_KEY` 或 dsh 的凭证文件，就不需要为 TUI 再配置一份。未配置模型凭证时，界面仍能启动，提交后会显示模型错误。

```sh
bun run dsh --profile tui --help
bun run dsh --profile tui --dump-config
```

`tui` profile 由 `dsh-base` 后接本 bundle 组成。非 TTY 会明确失败，不切换成另一种运行模式。测试使用临时 `DSH_HOME`，不会修改你的实际 profile 或会话。

## 当前能力

- 新建并持久化会话，连续多轮对话；`/new` 关闭旧会话后创建新上下文，不清除或重放终端历史。
- pi 风格双横线输入区：输入从行首开始，不显示 `>` 提示符；状态嵌在上横线。目录行左侧为目录/分支，右侧为当前 preset 与动态 extension 数；底栏左侧为用量/必要操作提示，右侧为模型/effort，空闲时不显示 `/help`。主色采用低饱和雾蓝，effort 使用 pi 的深色主题配色；保留终端背景和字体，支持非空 `NO_COLOR`。
- 正文随流式事件实时增长并渲染基础 Markdown：标题、强调、有序/无序列表、引用、行内代码和代码块；超出屏幕的内容自然进入真实终端滚动记录，不再裁成 3 行预览。定稿沿用已显示的正文，仅收尾，不重放全文或突然展开。不显示 reasoning；状态按真实事件区分 `Thinking`（思考）、`Responding`（正文输出）与 `Working`（等待/工具执行），完成后回到 `Idle`。用户输入与工具/日志保持字面文本。仅在思考、尚无正文时取消，不生成空的 `[incomplete]`；已有正文则原位保留并标记未完成。
- 正文、工具和异步通知按出现顺序进入同一队列；较早内容未定稿时，后来的日志和 steering 输入也实时显示，但不越过它写入历史，避免跨屏正文被覆盖或重复。工具终态保持调用顺序；失败或被放弃的流会释放后续内容，不让队列永久阻塞。
- 正文上方/下方布局由框架统一处理；底部编辑和状态区最多 5 行，打开菜单时最多 13 行，正文不受这个高度限制。所有候选位于**输入框下横线之外、目录与底栏上方**，正常窗口最多显示 8 项，上下键滚动，标题显示当前序号/总数；不进入备用屏幕。短窗口按高度减少候选，优先保留输入与下横线，省略装饰行；窄窗口从左侧省略模型名，优先保留末尾的 effort。
- 运行时仍可编辑输入；提交走 `steer()`，空闲提交走 `followup()`。
- 工具运行、完成和失败摘要，使用工具提供的 presentation；缺失或出错时使用通用标题。终端类结果附带 exit code / signal，不展开完整工具输出。
- Slash commands 走 dsh 命令服务，未知命令不会进入模型上下文；输入 `/` 从当前 Agent 的真实注册表列出命令，支持筛选、补全和键盘选择。
- 审批默认拒绝，只有 `y` 允许一次；其他 Agent 的请求委托给下游策略。
- 单选、多选、自由文本问题；审批和问题共用 FIFO，取消和过期答案不会错配。交互前的普通草稿与光标会恢复。
- 左右/Home/End/Backspace/Delete、Ctrl+A/E/U/K/W、进程内上下输入历史；中文和普通 emoji；粘贴换行折叠为空格，不自动提交。
- Node 的 stdout/stderr 写入统一经过安全文本投影，不直接打断输入行。
- 正常退出、Ctrl+C、SIGINT、SIGTERM 后恢复原 shell，并 flush 会话、释放 Agent。

### 界面与 effort 配色

主色采用低饱和雾蓝 **`#8BA4E8`**，保留蓝色方向，但不直接使用官网高饱和品牌蓝；更适合深色终端里的长时间阅读。用于启动信息、默认输入边框、选中候选和 Markdown 标题/行内代码。目录、用量和模型底栏使用柔和灰色；不强制终端背景色。彩色模式面向支持 24 位 RGB 的终端。

上下横线随**当前会话的已选 effort** 着色，色值对应 [pi 内置 dark 主题](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/dark.json)：

| Effort | 颜色 | 色值 |
|---|---|---|
| `off` / `none` | 深灰 | `#505050` |
| `minimal` | 灰 | `#6E6E6E` |
| `low` | 钢蓝 | `#5F87AF` |
| `medium` | 浅蓝 | `#81A2BE` |
| `high` | 淡紫 | `#B294BB` |
| `xhigh` | 亮紫 | `#D183E8` |
| `max` | 洋红 | `#FF5FFF` |

底栏 `·` 后显示当前 effort：优先显示显式选择，否则读取该模型 adapter 的 `defaultEffort`（例如 DeepSeek 默认 `high`），横线同步着色。只有 adapter 未声明默认值时才显示 `default`，保留提供方默认行为，不伪造 `off` 或其他档位。其他 adapter 自定义 effort 保留原名、使用主色；展示默认值不会改写模型设置。不同模型切换时重新读取能力，不沿用旧模型的 effort。

**Shift+Tab** 按当前模型 adapter 声明的顺序循环切换 effort（DeepSeek 为 `off → low → high → max → off`），不加入模型未声明的档位；也可执行 `/effort`。切换成功只原地更新底栏和边框，不追加 `Effort: …` 成功记录；快捷键不进入命令执行状态，不闪现 `Esc to cancel`。切换只影响当前会话、从下一次模型请求生效，不中断正在生成的请求，也不修改共享默认设置。草稿、光标和普通 Tab 补全保持不变，连续快速切换后仍可立即提交；列表选择、命令执行、审批或问题输入期间不响应此快捷键。没有可选 effort 的模型会明确提示，不修改当前选择。

目录在启动和 `/new` 时读取：home 前缀缩写为 `~`，Git 分支显示为 `(branch)`；非仓库或 detached HEAD 不伪造分支名。底栏的 `↑` 是未缓存输入 token，`↓` 是输出，`R`/`W` 是缓存读取/写入；只累计当前会话最终消息中 adapter 实际上报的 usage，不把流式 usage 重复加总，未上报且空闲时左侧留空。`/new` 清零用量。暂不显示费用、上下文占比或自动压缩状态，不使用示例数字冒充真实数据。

### 命令

| 命令 | 行为 |
|---|---|
| `/help` | 当前 Agent 可用命令与按键说明 |
| `/model` | 显示当前/默认模型，打开可搜索的模型列表 |
| `/model provider/model` | 验证并切换当前会话模型；省略 provider 时沿用当前 provider |
| `/effort` | 按模型支持的档位循环切换 effort，等同 Shift+Tab；从下一次请求生效 |
| `/preset` / `/preset id` | 搜索或直接选择 Agent preset；只允许在首次对话前切换 |
| `/extensions` / `/extensions filter` | 搜索当前会话动态扩展与宿主/Preset 插件；Enter 查看详情，只读 |
| `/new` | 空闲时 flush 并释放旧 Agent，创建新会话；重新读取默认模型与 preset |

`/model` 普通选择或直接参数切换**仅影响当前会话**。模型列表中 **Ctrl+S** 才会保存默认值，影响所有共用 dsh 设置的 profile；界面会明确提示。切换模型与底栏、实际请求共用同一个选择引用。运行中不能切模型或新建会话，请先停止工作。

dsh 已有命令直接从当前 Agent 的注册表使用，不重新实现；切换 preset 或动态扩展注册命令后，补全目录同步更新。

### Preset 与 Extension

- Preset 走上游 `agentPresets` 的发现、挂载和选择接口，实际改变工具、提示词与命令作用域。提供 `standard`、`minimal`、`ptc`、`cordis`，也会发现 `$DSH_HOME/.agent-presets/<id>/` 下的本地预设。未配置 `DSH_HOME` 时使用 `~/.dsh`。
- 默认是 `standard`；已有 `agent-presets.default` 设置优先。`/preset` **不修改全局默认**，Ctrl+S 只适用于模型列表。首次对话后必须先 `/new`，不能给已有工具记录就地换一套配置。创建时的 preset 写入会话头，后续合法选择写入会话事件；不迁移或改写旧日志。
- 工具等 Agent 层插件移入 preset，宿主保留注册表、模型路由、持久化和权限服务，避免新旧工具重复挂载。PTC 使用真实 `run_code` 工具集；Cordis 提供动态宿主扩展工具，**可以执行模型生成的宿主 JavaScript，信任级别等同 shell 访问**。
- `/extensions` 读取动态扩展服务及 Loader/Preset 的真实清单，显示所属作用域、模块或插件 ID、包版本和状态；只展示元数据，不展示源码或配置正文，不提供安装、启动、停止、删除动作。`disabled`、`not loaded`、`active`、`defined`、`running`、`failed` 等状态不会混为“已加载”。目录行的 `extensions` 是**当前会话动态扩展定义数**，包含未运行的定义，不是全部插件数或运行数。
- 动态 Host 扩展可通过 dsh 服务注册工具、命令；新增命令自动出现在补全中。浏览器 Client 扩展无法在终端渲染，当前会话的激活请求会明确拒绝，不挂起等待不存在的浏览器，也不自动授权。

### 按键

| 场景 | 操作 |
|---|---|
| 普通输入（空闲或 Agent 运行） | Shift+Tab 循环切换本会话 effort |
| 空闲 | Enter 提交；Esc / Ctrl+C 清空非空草稿 |
| 空闲且输入为空 | Ctrl+D 退出 0；Ctrl+C 退出 130 |
| Agent 运行 | Enter 追加 steering；Esc / Ctrl+C 停止工作 |
| 命令菜单 | 输入 `/` 筛选；上下选择；Tab 只补全；Enter 执行；Esc 关闭菜单并保留草稿 |
| 模型列表 | 输入搜索；上下选择；Enter 仅本会话；Ctrl+S 保存默认；Esc 取消 |
| Preset 列表 | 输入搜索；上下选择；Enter 仅本会话；Esc 取消 |
| Extension 列表 | 输入搜索；上下选择；Enter 查看快照详情；Esc 关闭 |
| 命令执行 | Esc / Ctrl+C 取消；不接收新提交，但可编辑下一条草稿 |
| 审批 | `y` + Enter 允许一次；`n` 或空 Enter 拒绝 |
| 问题 | 单选输入编号或自定义文本；多选输入逗号分隔编号；空 Enter 跳过 |

`/new` 进入旧 Agent 关闭/新 Agent 创建的短暂切换阶段后，Esc / Ctrl+C 会安全退出，不尝试恢复已释放的 Agent。

操作系统的信号由 dsh launcher 处理。当前 dsh 版本将正常 SIGTERM 退出码定义为 **0**，SIGINT 为 **130**；插件不另装一套退出策略。

## 终端引擎补丁与限制

渲染、布局、Markdown 与 grapheme 编辑仍使用现成框架，不是自写 renderer，但不是完全未修改的 eye_declare 0.7.1。`native/vendor/` 保留两份源码补丁：

- [引擎补丁](native/vendor/eye_declare_engine/README.md)：修正光标行截断被误算为重排、高度缩小后重绘清空历史，以及输入框下方内容重排导致光标报告漂移、候选残留的问题。长回答写入滚动历史前逐行清除旧活动区内容，避免空行/短行夹带预览和状态栏；修正公共换行路径的中文/emoji 右边界溢出，避免连续流式输出覆盖输入边框。空间不足时只滚动补足缺少的行；无法确认重排时宁可少擦留残影，不多擦历史。
- [Markdown 补丁](native/vendor/eye_declare/README.md)：补齐引用、编号列表与列表标记的无色样式。

原始失败用例和两类光标行 reflow 设置均保留。未隐藏硬件光标、未进入备用屏幕、未重打已定稿内容。

已知边界：

- 反复缩到只有 3 行，仍可能把旧活动行挤入滚动记录；保守的 resize 处理也可能留下临时残影。
- 自动测试使用真实 PTY + headless xterm，不能替代所有真实终端和中文输入法候选窗的人工验收。复合 ZWJ emoji 的真实字形仍未验收。
- Linux、Windows、原生进程崩溃等尚未做完整验证；不要把正常退出检查理解为任意强制终止都能恢复。
- 输出协调覆盖 Node streams；绕过它们直接写终端 fd 的第三方插件尚不支持。
- 没有会话选择/恢复、附件、多行编辑器、PTY 工具全屏接管或自定义 TUI 组件扩展接口；复杂 Markdown 表格与代码语法高亮未验收。已经滚出屏幕的正文不可回写；后续 Markdown 若反向修改先前内容（例如文末才给出的引用定义），不保证修正已滚出的样式。
- 原生模块目前在安装时从源码构建；还没有各平台预编译 npm 包，也没有发布到 npm。构建通过原子替换发布 `.node`，不原地改写已加载的动态库；重新构建后需要重启 dsh 才会使用新版界面。

## 打包安装

```sh
bun run build
bun pm pack --filename dsh-tui.tgz
bun run dsh plugin --profile tui add "$PWD/dsh-tui.tgz"
```

pnpm 可能阻止本地 tarball 的构建脚本。这时只批准本包，不要全局放开所有依赖脚本：

```sh
bun run dsh plugin --profile tui approve-builds
bun run dsh plugin --profile tui rebuild @ekil9/dsh-tui
bun run dsh plugin --profile tui install
```

最后一次 `install` 让 launcher 同步 bundle 列表。pnpm 11 对本地 tarball 使用带 `@file:...` 的精确构建审批键；仅指定包名的 `--allow-build` 不一定足够。本仓库安装测试会在隔离 profile 中只批准被测 tarball。

## 开发与验证

本机已通过：12 项 Controller 测试、55 项终端回归测试（含 7 个 effort、2 个 preset 子用例，共 64 项）、1 项打包安装/双会话与 preset 记录冷读测试、106 项组件单元测试、68 项引擎测试，以及 TypeScript 与 Rust fmt/clippy 检查。测试 adapter 不调用真实模型 API。

```sh
bun run test                # Controller behavior tests (Vitest)
bun run typecheck
bun run test:pty             # Real launcher, Agent, tools, and terminal
bun run test:install         # Bun tarball installation and cold-read persistence across /new
cargo fmt --manifest-path native/Cargo.toml --check
cargo clippy --manifest-path native/Cargo.toml --locked -- -D warnings

# Vendored component and engine regressions
cargo test --manifest-path native/vendor/eye_declare/Cargo.toml \
  --no-default-features --features markdown --lib --locked --target-dir native/target
cargo test --manifest-path native/vendor/eye_declare_engine/Cargo.toml \
  --features test-util --locked --target-dir native/target
```

测试入口使用 `bun run test`，不使用会切换到 Bun 内置测试框架的 `bun test`。PTY 和安装测试保留 Node test runner，与 dsh 的正式宿主运行时一致。

模型测试 adapter 只替换 LLM 系统边缘，不需要 API key；launcher、Cordis、Agent loop、工具、命令、审批、用户问题、持久化和原生终端走真实实现。没有据此宣称真实付费模型请求也已验收。

PTY 检查包括历史唯一性、禁用 alternate screen / `CSI 3J`、硬件光标、粘贴、异步日志、resize，以及退出后同一个 bash 的 `stty -g` 和实际读入/回显。产物保存到忽略版本控制的 `artifacts/`。

```text
src/index.ts          Cordis 插件入口
src/startup.ts        参数与帮助
src/application.ts    Agent、事件、命令和完整关闭流程
src/controller.ts     有序会话投影与界面快照
src/commands.ts       /help 与命令说明
src/model-command.ts  模型验证、会话切换、effort 循环和显式保存默认
src/preset-command.ts Agent preset 的发现与合法选择
src/extensions-command.ts 只读动态扩展与插件清单
src/picker.ts         模型、Preset、Extension 共用的可取消选择器
src/interactions.ts   审批/问题 FIFO
src/terminal.ts       N-API 终端适配
src/output.ts         Node 输出协调
src/display-text.ts   安全显示文本
native/src/lib.rs     eye_declare 应用、内置编辑器及线程消息传递
```

前期选型证据保留在 `experiments/`；实验套件中的已知失败不属于 MVP 默认测试命令。
