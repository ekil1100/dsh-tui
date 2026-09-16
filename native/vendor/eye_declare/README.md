# eye_declare 本地补丁

上游：<https://github.com/atuinsh/eye-declare>，crate `eye_declare 0.7.1`，提交 `e14258bc0965e61e76fa94e39455699bd676eeb5`。源码、示例、测试和 manifest 复制自 crates.io 发布内容，保留 MIT 许可声明；该发布包没有单独的 LICENSE 文件。

组件代码改动只在 `src/markdown.rs`，仍由上游 Markdown 元素完成解析、布局与渲染。manifest 将引擎依赖指向相邻的 `../eye_declare_engine`，确保独立组件测试和实际插件使用同一份换行/终端修正，而不是测试未修正的 registry 引擎。

Markdown 修正：

- 引用内容保留 `│` 标识，支持嵌套引用、引用中的标题、行内样式和代码块。不改写 Markdown 源文本。
- 编号列表保留起始编号、后续编号及嵌套项目符号的缩进，而不是统一变成无序列表。
- 列表标记使用传入的基础样式，不再强制灰色，避免绕过调用方的 `NO_COLOR` 设置。

回归包含模块内的两个 `tui_regressions` 测试，以及根目录 `test/pty.mjs` 的 Markdown 结构、彩色/无色、缩放与历史唯一性测试。复杂表格及代码语法高亮不属于当前产品验收范围。

```sh
cargo test --manifest-path native/vendor/eye_declare/Cargo.toml \
  --no-default-features --features markdown --lib --locked --target-dir native/target
```

升级时先检查上游是否覆盖这些行为及现有回归，再移除整份副本，不保留双轨实现。
