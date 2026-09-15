# Rust 现成终端框架候选

调研日期：2026-09-14。

## 结论

**Rust 生态确实有比直接使用 Ratatui 更完整、也更贴近本项目的现成框架。优先验证 `eye_declare`，其次是解决 Ratatui 依赖问题后的 Tuika。** 不需要先假定要自行实现终端 renderer。

调研当时仅检视官方文档、已发布 crate 源码和上游 issue，没有运行 Rust 框架的 PTY 验收。

**后续实验**：`eye_declare 0.7.1` 已完成 [PTY 验证](eye-declare-pty/README.md)，14 项中 13 通过、1 失败；已定稿历史保留，剩余失败为反复缩到 3 行时旧活动行进入 scrollback。尚未正式采用，也未修改 `DESIGN.md`。其余候选仍未经过本项目 PTY 验收。

要找的是：主屏运行、定稿进入真实终端历史、底部活动区、现成 Unicode 输入、可控退出和 resize；不是仅有“画控件”能力的全屏框架。

## 1. eye_declare：优先验证

- 仓库：[`atuinsh/eye-declare`](https://github.com/atuinsh/eye-declare)。
- crates.io 正式包名为 **`eye_declare`**，当前发布版 **0.7.1**，发布于 2026-08-10；其引擎 `eye_declare_engine` 当前也是 0.7.1。[1]
- 发布源码将模型直接定义为：`ctx.push()` 提交一次性的历史输出；`tail()` 描述每帧更新的活动内容。这不是把完整 transcript 留在动态树里。[2]
- 自带 `TextAreaState` / `text_area`、布局、文本、Markdown、spinner、焦点、按键分发，以及同步和 Tokio 驱动。输入编辑按 grapheme 移动和删除，显示位置按终端宽度计算，支持 paste。[2][3]
- 发布包内已有 `stream`、`openrouter` 和 `resize_probe` 示例；后者就是“先提交两轮对话，再保留输入区，拖动窗口验收历史保留”。[4]
- 使用 Ratatui 的 Buffer 等基础类型，但实际输出由自己的 `eye_declare_engine` 负责；inline resize 走 `resize_anchored`，不是直接调用 Ratatui 的 `Terminal::autoresize()`。因此不能把 Ratatui #2666 自动套到它身上。[5]
- 同步 `Timeline` 接口接受元素、返回 ANSI 字节，可作为嵌入式终端层的候选接口；是否通过 Node addon 接入仍需后续实作验证。[5]

### 已知限制，不能略过

1. **resize 并非无条件可靠。** 0.7.1 引擎源码明确写明：显示硬件光标时，其定位算法假设终端在缩窄后会 reflow；在不 reflow 的 xterm、urxvt、screen 等环境可能多擦除内容。隐藏光标并停在活动区顶端的路径有不同性质，不能用后者的正确性代替输入光标验收。[6]
2. runtime 通过 cursor-position report 获取缩放后的真实位置；如果终端不回复，会走旧坐标推算路径，源码明确称其为 best effort。[6][7]
3. 现成输入组件支持多行、默认软换行；`wrap(false)` 是截断，不等于已经实现本设计要求的单行横向滚动。输入历史、Ctrl+U/K/W、粘贴换行折叠和 Enter/Esc 的业务含义也要逐项核对或在应用层配置。[3]
4. 上游有 reflow、溢出尾部不重复等测试，但使用其自带终端模型；不能替代我们用独立 headless xterm 和真实 PTY 做的验收。[8]

**判断：产品模型最匹配，现成能力足够成为首个 Rust 实验对象；不是已经可以正式采用的结论。** 这是近期发布的框架，不应拿 Ratatui 的整体成熟度替它背书。

## 2. Tuika：现成组件更丰富，但有明确依赖风险

- 仓库：[`everruns/tuika`](https://github.com/everruns/tuika)。
- 当前发布版 **0.11.1**，发布于 2026-08-25，MSRV 1.88。[9]
- 发布版已包含 `ScreenMode::split_footer(rows)`：主屏保留底部区域，上方是真实终端历史。通过 `Runner::scrollback()` 返回的可克隆队列提交定稿视图，而不是在活动区存在时直接 `println!`。[10]
- 自带 `TextInputState` / `TextInput`、选择和多选、焦点、布局、同步/异步 Runner、终端生命周期管理。TextInput 编辑按 grapheme 处理；输入模式和 Enter 策略可由宿主控制。[10][11]
- 发布包已有 `split_footer` 和 `codex --split-footer` 示例，后者演示 coding-agent transcript 与底部输入组合。[10]

### 为什么现在不能直接认定可用

发布版的 split-footer 实际使用 **`Viewport::Inline`**，Runner 调用 **`terminal.autoresize()`**，依赖 `ratatui-core = "0.1"`。[12]

本轮查询到的最新稳定 `ratatui-core` 仍为 **0.1.2**、Ratatui 为 **0.30.2**。修复 inline 横向缩小清除/重复历史的 PR **#2670** 于 2026-09-04 合并，目标 milestone 是 0.30.3，尚未进入上述稳定版。[13]

因此 Tuika 并没有天然绕过该问题。可以考虑基于已合并的上游修复做锁定提交的实验，或等待正式 release；不能只看 split-footer 的 README 就认为已经安全。

另外，Tuika 文档规定 footer 高度在一次终端生命周期内固定。这不直接否定当前最多 4 行的方案，但小于预留高度的终端仍需独立验收。[10]

**判断：现成控件和完整应用框架最值得保留为备选，但先解决已知 Ratatui 依赖路径。**

## 3. 其他候选及排位理由

| 候选 | 已核实的能力或问题 | 当前判断 |
|---|---|---|
| **Ratatui 0.30.2** | 有 inline viewport / `insert_before`；#2670 修复已经合并但尚未进入最新稳定版。[13] | 可复用，不是被永久否决；直接用它仍需组合输入组件和应用循环。优先考察更完整的框架。 |
| **iocraft 0.9.1** | 并非仅支持全屏；它有 inline、`use_output`、TextInput。但已发布后端在旧画布高度达到终端高度时使用 `ClearType::Purge`；TextInput 的退格按 Unicode scalar 而非 grapheme 删除。[14] | 当前发布版不适合作为无需补齐核心行为的首选。不能只因为“用 Rust”就避开 Ink 类似风险。 |
| **FrankenTUI / ftui 0.7.0** | 发布版已有 inline `TerminalWriter`、独占输出协调、Input 等组件，Input 按 grapheme 处理。[15] | 可列后备，但内置策略复杂；源码明确区分 scroll-region 日志累积与 overlay 路径的一行覆写，不能笼统宣称所有路径都提供持久历史。[15] |
| **tape_tui** | 定位 transcript/coding-agent，具备输入、IME 光标和 inline runtime；本轮源码仍能定位到包含 `CSI 3J` 的 `CLEAR_ALL` 路径。[16] | “inline-first”宣称不足以直接采用，需要先检查相关路径是否能触发。 |
| **rigging 0.4.0** | 现成 inline Input / Text、流式显示和结束时完整输出；首次发布于 2026-08，本轮查询版本发布于 2026-09-09。[17] | 很新，可保留；尚未验证输入与输出同时活动及完整 Unicode/resize 契约。 |
| **Superconsole** | 已有状态输出、组件组合和渲染/状态分离。[18] | 更接近输出与进度渲染层，本轮未确认可直接替代完整输入层，不优先。 |
| **r3bl_tui / async readline** | 提供现成行编辑及异步日志；官方文档同时说明 spinner 活动时会暂停 stdout 输出。[19] | 适合另一类 CLI 交互；需要先确认能否直接满足持续流式显示和可编辑输入并存。 |

没有因为下载量低就直接否决新库，也没有把下载量高当成符合终端契约的证明。

## 建议的下一步

1. **用 `eye_declare = "=0.7.1"` 做最小 Rust 终端实验**，锁定依赖，使用框架自带 timeline、输入和正常 resize 驱动。
2. 对照已有 Ink 实验的观察标准：历史只出现一次、24 → 12 行不会覆盖定稿、缩窄与极矮窗口不清历史、异步输出时输入和硬件光标正确、退出后 shell 可用。
3. 特别覆盖有/无 cursor-position report、硬件光标开启，以及不同 reflow 行为。先明确支持范围，不能偷偷以隐藏光标作为通过手段。
4. 通过后再接 Node/dsh。实验用可执行程序不意味着正式产品增加独立启动器；正式集成可另外验证 napi-rs。
5. 若首选失败，再验证带上游修复的 Tuika。不要因为发现一个框架失败就推导整个 Rust 生态都不行，也不要提前开始自写 renderer。

## 一手来源

[1] crates.io API：[eye_declare](https://crates.io/api/v1/crates/eye_declare)、[eye_declare_engine](https://crates.io/api/v1/crates/eye_declare_engine)。

以下 eye_declare 链接固定到发布包 `.cargo_vcs_info.json` 标明的提交 `e14258bc0965e61e76fa94e39455699bd676eeb5`，不是浮动 main：

[2] [eye_declare 发布源码：lib.rs](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare/src/lib.rs)、[官方网站](https://eye-declare.rs/)。

[3] [TextAreaState / text_area 源码](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare/src/text_area.rs)。

[4] [resize_probe 示例](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare/examples/resize_probe.rs)。

[5] [Timeline 源码](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare/src/timeline.rs)。

[6] [Engine::reset_region / reset_region_anchored 与限制说明](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare_engine/src/engine.rs#L335-L432)。

[7] [runtime 的 resize_with_report](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare/src/runtime.rs#L556-L583)。

[8] [引擎的 resize_reflow 测试](https://github.com/atuinsh/eye-declare/blob/e14258bc0965e61e76fa94e39455699bd676eeb5/crates/eye_declare_engine/tests/resize_reflow.rs)。

[9] [Tuika crates.io API](https://crates.io/api/v1/crates/tuika)。其发布包对应提交为 `de964bac98f17561a0660f8c026b160a48045663`。

[10] [Tuika 0.11.1 README：screen modes、scrollback 与示例](https://github.com/everruns/tuika/blob/de964bac98f17561a0660f8c026b160a48045663/README.md#screen-modes-lifecycle-and-runner)。

[11] [Tuika TextInput 发布源码](https://github.com/everruns/tuika/blob/de964bac98f17561a0660f8c026b160a48045663/src/components/textinput.rs)。

[12] Tuika 发布源码：[screen.rs](https://github.com/everruns/tuika/blob/de964bac98f17561a0660f8c026b160a48045663/src/screen.rs)、[Runner](https://github.com/everruns/tuika/blob/de964bac98f17561a0660f8c026b160a48045663/src/runner/mod.rs)、[Cargo.toml](https://github.com/everruns/tuika/blob/de964bac98f17561a0660f8c026b160a48045663/Cargo.toml)。

[13] Ratatui：[PR #2670](https://github.com/ratatui/ratatui/pull/2670)、[PR API 合并时间与提交](https://api.github.com/repos/ratatui/ratatui/pulls/2670)、[最新 release API](https://api.github.com/repos/ratatui/ratatui/releases/latest)、[ratatui-core crates.io API](https://crates.io/api/v1/crates/ratatui-core)。

[14] iocraft 0.9.1：[Crossterm 后端](https://docs.rs/iocraft/0.9.1/src/iocraft/backend/crossterm.rs.html#514-539)、[TextInput](https://docs.rs/iocraft/0.9.1/src/iocraft/components/text_input.rs.html#519-543)、[README](https://github.com/ccbrown/iocraft)。本轮下载并检查的是 crates.io 0.9.1 归档。

[15] FrankenTUI 0.7.0：[TerminalWriter 源码契约](https://docs.rs/ftui-runtime/0.7.0/src/ftui_runtime/terminal_writer.rs.html)、[Input 源码](https://docs.rs/ftui-widgets/0.7.0/src/ftui_widgets/input.rs.html)、[ftui crates.io API](https://crates.io/api/v1/crates/ftui)。

[16] tape_tui：[官方仓库](https://github.com/Gurpartap/tape_tui)、[renderer 的 CLEAR_ALL](https://github.com/Gurpartap/tape_tui/blob/main/src/render/renderer.rs)。这是本轮检视时的 main，不是已锁定发布版。

[17] Rigging：[官方仓库](https://github.com/fuderis/rigging-rs)、[crates.io API](https://crates.io/api/v1/crates/rigging)。

[18] [Superconsole 官方仓库](https://github.com/facebookincubator/superconsole)。

[19] [r3bl_tui 官方文档：Full TUI、Partial TUI、async readline](https://docs.rs/r3bl_tui/0.7.8/r3bl_tui/index.html)。
