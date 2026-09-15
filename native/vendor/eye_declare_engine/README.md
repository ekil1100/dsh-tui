# eye_declare_engine 本地补丁

上游：<https://github.com/atuinsh/eye-declare>，crate `eye_declare_engine 0.7.1`，发布对应提交 `e14258bc0965e61e76fa94e39455699bd676eeb5`。源码、测试和 `Cargo.toml` 复制自 crates.io 发布内容；上游通过 manifest 声明 MIT 许可，但该发布源码没有单独的 LICENSE 文件。保留其原有声明及源文件。

本地修正如下（前 3 项位于 `src/engine.rs`）：

1. `reset_region_anchored()`：缩窄后 CPR 光标落在新的最右列时，不能推断光标行已重排，不将推测的光标行分片计入向上擦除距离。xterm.js 默认会重排其他行，但截断光标行；原实现会把已定稿回答的尾行当作活动区擦掉。
2. `repaint_after_reset()`：窗口变矮时，终端可能截掉光标下面的状态栏。重绘所需行数超过剩余空间时，只滚动补足缺少的行，将历史推入滚动记录；不再清空整个可见屏幕。

3. `reset_region_anchored()`：仅宽度缩小、没有高度缩小时，用光标下方各行重排后仍需占据的空间约束 CPR 行号。xterm.js 可能在下方行扩展并滚动后仍返回旧的屏幕行号，导致旧输入和候选留在活动区上方。高度同时缩小时可能已经截掉下方行，不能应用该约束，以免擦除历史。对应回归为 `cursor_report_drift_from_rows_below_input_does_not_leave_old_candidates`、`combined_height_and_width_shrink_does_not_infer_discarded_footer_rows`，以及根目录的候选顺序/缩放 PTY 测试。

4. `src/escape.rs::write_committed_row()`：长回答通过批量输出进入滚动历史时，先重置样式并擦除当前待写行，再输出该行内容。原实现省略行尾空白，却没有清除该行原有活动区内容，导致段落空行保留预览、短行拼接旧状态栏；一旦滚出屏幕就无法再修复。擦除仅作用于正在替换的活动行，不清空屏幕或历史。`tests/commit_scrollback.rs::large_commit_replaces_live_rows_including_blanks_and_short_lines` 用 8 行终端提交含空行/短行的 12 行回答复现；根目录 `test/pty.mjs` 的长回答测试覆盖真实 Markdown、流式预览和中文/emoji 草稿。两者都在修复前失败、修复后通过。

沿用上游对非光标行会重排的假设；不重排内容的终端不在当前验收范围。无法判定的情况选择少擦，允许残影，不选择多擦历史。未隐藏硬件光标、未进入备用屏幕、未重打已定稿内容。此补丁不宣称解决所有终端的 reflow 差异，也没有改变极矮窗口残影这一已知限制。

回归用例：仓库根目录 `test/pty.mjs` 中 `submitted prompts and answers survive resizing without duplicate history`。在原始引擎中可复现：输入框含 `draft😀`，24→12 行，然后 80→30→8→80 列，`Reply: history-window` 被截为 `Reply: history-w`。补丁后原用例通过。加入光标下方状态栏后，同一用例还暴露了第 2 个问题：仅 24→12 行就会丢失提示词和回答。新增 `tests/resize_reflow.rs::footer_below_cursor_height_shrink_preserves_history` 在修复前失败、修复后通过，原 PTY 断言保持不变。

未来升级引擎时应先确认上游修复覆盖这些用例，再移除整份本地副本；不叠加运行时兼容分支。
