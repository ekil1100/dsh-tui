# eye_declare 0.7.1：现成终端框架 PTY 实验

日期：2026-09-14。

## 结论

**主路径明显优于本次 Ink 方案，值得保留为接入候选；但还没有通过全部终端要求。**

最终运行 **14 项测试，13 通过、1 失败**。失败项是反复将 4 行活动区所在终端缩到 3 行后，旧活动行残留在 scrollback；已定稿回答和应用启动前的历史没有丢失。

本实验使用发布版框架，没有修改 `eye_declare`、引擎或 Crossterm 源码，也没有自行实现终端 renderer、resize 算法或 grapheme 编辑器。没有接入 dsh / napi-rs，没有修改 `DESIGN.md`，没有缩小正式要求的支持范围。

## 实现与环境

- macOS 26.6.2 / arm64；Rust 1.98.1；Node 24.14.0。
- `eye_declare = 0.7.1`、`eye_declare_engine = 0.7.1`、Crossterm 0.29.0；依赖由 `Cargo.lock` 固定。
- 使用框架自带 `driver_tokio::run()`、默认 inline 模式、`ctx.push()`、`TextAreaState` / `text_area`、焦点和 keymap。
- 通过 `App::on_resize` 调整内容高度：`min(4, max(1, rows - 1))`。真正的终端缩放处理和光标定位仍由框架驱动。
- 输入使用内置的 `max_height(1)` 视口；仍启用默认软折行，长输入按折行片段切换可见区。没有实现另一个平滑横向滚动编辑器。
- 应用层仅添加测试控制、Enter 提交、粘贴换行折叠，以及将 SIGINT / SIGTERM 转为 `ctx.exit()` 的宿主策略。
- 复用 `../ink-pty/harness.mjs` 的真实 PTY、同一个 bash、60 条 `OLD_00` 至 `OLD_59` 历史标记、headless xterm、退出后的 `stty -g` 比较与实际读入/回显。
- socket 模拟外部模型更新，ACK 仅同步测试命令，之后等待 PTY 输出稳定；用户可见结果只从终端解析，不读取 Rust 或框架内部状态。

### 测试判定环境的修正

为了避免错误地把测试工具问题算到框架头上，共享驱动做了两项校准：

1. **按解析后的终端内容计数，不要求原始 ANSI 包含完整字面量。** 例如 `DONE00` 可以通过修改既有 `LIVE0:0` 的少数格子得到；这正是合法的差分渲染。每个检查点仍要求旧历史及定稿标记恰好存在一次，并继续检测禁止的清历史、切换备用屏幕序列。
2. **启用稳定的 Unicode 11 宽度规则。** headless xterm 默认 Unicode 6 会将 `😀` 当成 1 格，与框架的 2 格计算不同。本轮也试过官方实验性 grapheme 插件，但在当前组合中校准仍不正确，已移除。最终使用 `@xterm/headless 6.0.0` + `@xterm/addon-unicode11 0.9.0`，明确设置 `unicode.activeVersion = '11'`；独立校准确认 `中文😀ab` 占 8 格，`😀` 占 2 格。

Unicode 11 不负责复合 ZWJ emoji 的现代字体成形。因此复合 emoji 测试只验证删除后的 **ASCII 提交结果**，不宣称其编辑过程的复合字形排版已验收。中文和普通 emoji 的可见内容、宽度与光标另有 PTY 断言。

共享驱动还记录了 `host-resize-*` 检查点：先让终端模拟器调整尺寸，再记录画面，最后才通知子进程尺寸变化。这样可以区分终端自身的 reflow 与应用后续重绘。

## 最终结果

| 场景 | 结果 |
|---|---|
| 带硬件光标，24 → 12 行，再刷新活动区 | 通过；`DONE00` 和旧历史保留 |
| 5 行终端、4 行活动区，连续 10 次更新和两次定稿 | 通过；标记唯一，没有旧活动行累积 |
| 宽度 80 → 60 → 40 → 20 → 8 → 80 → 30 → 10 → 80，含长定稿 | 通过；历史保留，只有当前三条活动行 |
| 24 → 3 行，活动区缩为 2 行 | **历史保留通过**；没有清 scrollback，但残影由独立测试检查 |
| **三次 24 → 3 → 24 行循环** | **失败：应有 3 条当前活动行，实际有 6 条，额外留下 3 条旧活动行** |
| 中文、普通 emoji、光标左移后到来异步输出 | 通过；草稿和光标位置正确 |
| 括号粘贴 CRLF，之后显式 Enter | 通过；换行折叠为空格，不自动提交，仅产生一次提交 |
| `👩‍💻éZ` 左移后两次退格再提交 | 通过；提交结果为 `INPUT:Z`，按两个完整 grapheme 删除；不覆盖复合 emoji 排版验收 |
| 12 列终端中的长输入，显示末尾、左移、完整提交 | 通过；输入可见区保持一行，内容不丢 |
| 启动后禁止 cursor-position report，再缩窄并刷新 | 本例通过；确实拦截了一条回复。用例耗时约 2.6 秒，含超时等待，不代表这一条件下交互无卡顿 |
| Ctrl+C / Ctrl+D | 通过；退出码 130 / 0，原 shell 可用 |
| 宿主处理 SIGINT / SIGTERM 后走正常退出 | 通过；退出码 130 / 143，原 shell 可用 |
| `tail()` render panic | 通过；退出码 101，历史保留，TTY、光标和粘贴模式恢复 |

最终矩阵中没有检测到 `CSI 3J` 或进入 alternate screen。正常退出、signal 和 panic 的成功都由同一个 bash 中的 `stty -g` 和实际 `read` / `printf` 验证，而不是由退出码推测。

### 唯一剩余失败：极矮窗口残影

三次循环后，终端包含：

```text
DONE00
LIVE1:0
LIVE3:0
LIVE5:0
LIVE7:0
LIVE7:1
LIVE7:2
>
```

其中 `LIVE1:0`、`LIVE3:0`、`LIVE5:0` 是旧活动内容，当前画面本应只剩 `LIVE7:*` 三行。

本例不是框架又完整打印了一遍历史。第一轮的 **`host-resize-80x3`** 检查点已经显示：

- `baseY = 62`。
- `LIVE1:0` 位于逻辑行 61，已经处于 scrollback。
- 此时还没有调用 PTY 的 resize，也就是应用还没有收到这次 `SIGWINCH`。

因此本场景的旧行是在终端先缩小窗口时被挤入历史，框架后续没有将它清除。不要将它误报为与 Ink 清除 scrollback 相同的故障，也不能据此承诺换另一个 renderer 就一定消失。

它仍违反“活动内容不持续污染历史”的严格期望，本实验没有把测试改成通过，也没有擅自规定最小终端高度。是否接受极矮窗口下的过渡残影，需要单独决定。

### 需要宿主处理的事情

- **OS 信号不是仅靠 RAII 就能覆盖。** 未注册 SIGTERM 策略时，进程会直接终止，`stty -g` 不恢复。本实验随后添加了 Tokio 信号到 `Msg::Quit` / `ctx.exit` 的转发，再验证通过。这与 Ink 实验显式安装进程信号处理器的比较条件一致；不是修改框架来制造通过。
- **单行输入策略不是框架默认值。** 发布组件支持多行；本实验在应用侧折叠粘贴换行，并绑定 Enter 提交。`wrap(false)` 会截断长输入而不保持末尾可见，因此使用框架自带的一行高软折行视口。
- **Node 接入仍未验证。** 终端写入独占、dsh 日志协调、信号转发、Node 事件循环不被阻塞以及原生包发布，都属于下一阶段。

## 复现

需要 Unix 环境、Node 和 Rust。先安装复用的 PTY 驱动依赖：

```sh
npm --prefix experiments/ink-pty ci

# node-pty 1.1.0's macOS prebuilt helper needs execute permission.
if [ "$(uname -s)" = Darwin ]; then
  chmod u+x "experiments/ink-pty/node_modules/node-pty/prebuilds/darwin-$(node -p process.arch)/spawn-helper"
fi

npm --prefix experiments/eye-declare-pty test
```

**当前应显示 13 通过、1 失败，退出码为 1。** 这是选择框架的验收结果，不是需要把断言改绿的单元测试错误。

只复现极矮窗口残影：

```sh
cd experiments/eye-declare-pty
cargo build --locked
node --test --test-name-pattern='accumulate stale' test.mjs
```

检查 Rust 代码：

```sh
cargo fmt --manifest-path experiments/eye-declare-pty/Cargo.toml --check
cargo clippy --manifest-path experiments/eye-declare-pty/Cargo.toml --locked -- -D warnings
```

两项检查均已通过；已有 Ink 实验在统一校准环境下重新运行，仍为 13 项、10 通过、3 失败。

## 文件与未覆盖范围

- `src/main.rs`：使用现成框架的诊断应用，不是正式 dsh 插件。
- `test.mjs`：只观察真实终端的行为验收。
- `Cargo.toml` / `Cargo.lock`：锁定 Rust 依赖。
- `artifacts/*.ansi` / `*.json`：原始输出、操作记录、屏幕和完整逻辑行；不加入版本控制。
- `artifacts/test-results.txt`：最终完整测试输出。

未覆盖真实中文输入法候选窗、复合 emoji 的真实字形、不同真实终端的 reflow 差异、快速 resize 压力、Node addon、dsh 生命周期、审批及命令协议、完整快捷键和输入历史。现有结果不能扩大为这些项目也已通过。
