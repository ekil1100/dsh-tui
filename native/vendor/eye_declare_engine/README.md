# eye_declare_engine 本地补丁

上游：<https://github.com/atuinsh/eye-declare>，crate `eye_declare_engine 0.7.1`，发布对应提交 `e14258bc0965e61e76fa94e39455699bd676eeb5`。源码、测试和 `Cargo.toml` 复制自 crates.io 发布内容；上游通过 manifest 声明 MIT 许可，但该发布源码没有单独的 LICENSE 文件。保留其原有声明及源文件。

本地修正如下（前 3 项位于 `src/engine.rs`）：

1. `reset_region_anchored()`：缩窄后 CPR 光标落在新的最右列时，不能推断光标行已重排，不将推测的光标行分片计入向上擦除距离。xterm.js 默认会重排其他行，但截断光标行；原实现会把已定稿回答的尾行当作活动区擦掉。
2. `repaint_after_reset()`：窗口变矮时，终端可能截掉光标下面的状态栏。重绘所需行数超过剩余空间时，只滚动补足缺少的行，将历史推入滚动记录；不再清空整个可见屏幕。

3. `reset_region_anchored()`：仅宽度缩小、没有高度缩小时，用光标下方各行重排后仍需占据的空间约束 CPR 行号。xterm.js 可能在下方行扩展并滚动后仍返回旧的屏幕行号，导致旧输入和候选留在活动区上方。高度同时缩小时可能已经截掉下方行，不能应用该约束，以免擦除历史。对应回归为 `cursor_report_drift_from_rows_below_input_does_not_leave_old_candidates`、`combined_height_and_width_shrink_does_not_infer_discarded_footer_rows`，以及根目录的候选顺序/缩放 PTY 测试。

4. `src/escape.rs::write_committed_row()`：长回答通过批量输出进入滚动历史时，先重置样式并擦除当前待写行，再输出该行内容。原实现省略行尾空白，却没有清除该行原有活动区内容，导致段落空行保留预览、短行拼接旧状态栏；一旦滚出屏幕就无法再修复。擦除仅作用于正在替换的活动行，不清空屏幕或历史。`tests/commit_scrollback.rs::large_commit_replaces_live_rows_including_blanks_and_short_lines` 用 8 行终端提交含空行/短行的 12 行回答复现；根目录 `test/pty.mjs` 的长回答测试覆盖真实 Markdown、流式预览和中文/emoji 草稿。两者都在修复前失败、修复后通过。

5. `src/wrap.rs` / `src/word_wrapper.rs`：修复 Ratatui `WordWrapper` 在当前行尚剩一列时仍加入双列 grapheme 的越界换行。最小案例为 5 列下的 `a 中文`；实际 125 列流式预览会把 `文` 写到最后一列，触发终端额外自动换行，留下旧预览并覆盖输入区上横线。Ghostty + Herdr 与 xterm 都可复现，不依赖窗口缩放。测量和绘制共用修正后的换行结果，仍由 Ratatui `Line` 渲染样式与对齐；不截掉字符、不预留空列、不按终端品牌分支。移除旧的窄窗口截断路径及未使用的 `wrapping_paragraph()` 入口。

   `word_wrapper.rs` 仅提取自 [ratatui-widgets 0.3.2 的 `src/reflow.rs`](https://docs.rs/crate/ratatui-widgets/0.3.2/source/src/reflow.rs) 中的 WordWrapper 部分，未引入整份 widget crate 副本。核心修正是把待加入 grapheme 的宽度纳入溢出判断；其余改动限于私有可见性、标准库导入和移除未使用的行宽字段。原 MIT 许可保留于 `LICENSE-ratatui`。上游修复后应移除此局部副本，而非长期维护两条换行路径。

   回归覆盖最小失败案例、2–132 列中英文/emoji/组合字符无越界且不丢字、带样式和对齐的滚动区域，以及根目录 `test/pty.mjs` 的 125 列连续流式中间帧和定稿唯一性。另在同一 Ghostty + Herdr 0.9.0 会话的隔离测试窗格验证了完整流式过程；未改动 Herdr 或 Ghostty 配置。

6. `src/engine.rs::reflow_rows_after_cursor()`：输入区不再保留 3 行预览后，现有 PTY 缩放回归暴露出另一种 CPR 漂移：缩窄时，旧光标行号可能落到下方目录行，xterm 会截断该行而非重排。把它仍按完整多行计入下方高度，会向上多擦已定稿回答。现从预计下方行的位置排除这个可疑行的额外换行，不把推测的行数当作擦除依据；保持原来的保守策略。根目录 `submitted prompts and answers survive resizing without duplicate history (cursor reflow=false)` 在 5 行输入区、80→30 列时修复前失败，修复后通过；原候选、组合缩放和双 reflow 回归保留。

沿用上游对非光标行会重排的假设；不重排内容的终端不在当前验收范围。无法判定的情况选择少擦，允许残影，不选择多擦历史。未隐藏硬件光标、未进入备用屏幕、未重打已定稿内容。此补丁不宣称解决所有终端的 reflow 差异，也没有改变极矮窗口残影这一已知限制。

回归用例：仓库根目录 `test/pty.mjs` 中 `submitted prompts and answers survive resizing without duplicate history`。在原始引擎中可复现：输入框含 `draft😀`，24→12 行，然后 80→30→8→80 列，`Reply: history-window` 被截为 `Reply: history-w`。补丁后原用例通过。加入光标下方状态栏后，同一用例还暴露了第 2 个问题：仅 24→12 行就会丢失提示词和回答。新增 `tests/resize_reflow.rs::footer_below_cursor_height_shrink_preserves_history` 在修复前失败、修复后通过，原 PTY 断言保持不变。

未来升级引擎时应先确认上游修复覆盖这些用例，再移除整份本地副本；不叠加运行时兼容分支。
