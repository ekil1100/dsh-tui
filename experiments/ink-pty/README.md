# Ink 主屏与滚动历史：PTY 验证

## 结论

**Ink 7.1.1 按当前设计使用稳定的 `<Static>`、最多 4 行活动区和 `useCursor`，没有通过历史保留要求。** 限制动态区高度并不足够。

这是隔离的诊断实验，不是正式终端实现。本轮不修改 `DESIGN.md`，不修改 Ink，不引入其他 renderer，也不实现 dsh 接入。

2026-09-14 的完整运行：**13 个测试，10 个通过，3 个失败**。三个失败场景随后各单独重复两次，全部再次失败。通过项包含一个故意溢出的负对照和一个关闭光标定位的诊断对照，不能将其理解为十项产品功能验收通过。

## 后续统一环境复核

`eye_declare` 实验复用了本目录的 PTY 驱动，增加可配置测试程序、独立产物目录和 resize 前的终端检查点，并启用 `@xterm/addon-unicode11 0.9.0` 的 Unicode 11 宽度规则。历史唯一性以解析后的屏幕和 scrollback 为准，不再要求原始 ANSI 连续包含完整字面量，因为差分 renderer 可以复用已有格子。

在这一校准环境下，本目录测试已重新运行：仍为 **13 项，10 通过、3 失败**，没有改变 Ink 选型结论。详见 [`../eye-declare-pty/README.md`](../eye-declare-pty/README.md)。

## 环境与方法

- macOS 26.6.2，arm64；Node 24.14.0。
- Ink 7.1.1、React 19.2.0、node-pty 1.1.0、`@xterm/headless` 6.0.0、string-width 8.2.0；版本由 `package-lock.json` 固定。
- node-pty 启动 `/bin/bash` 和真实 Node 进程。bash 先输出 `OLD_00` 到 `OLD_59`，作为应用启动前的历史。
- 一个稳定的 `<Static>` 实例输出定稿记录；活动区高度为 `min(4, max(1, rows - 1))`，纵向裁切，每行截断，不允许换行撑高活动区。负对照除外，它故意输出 6 行。
- 使用 `useWindowSize` 响应 resize；使用 `useCursor` 将真实光标放在输入行。主屏、`exitOnCtrlC: false`、默认非增量渲染、30 FPS。
- 模拟模型更新通过本地 Unix socket 驱动，只替代外部事件来源；按键、粘贴和窗口尺寸通过 PTY 输入。测试不读取 React 状态或 Ink 私有字段。
- 保存原始 ANSI，并由 headless xterm 解释屏幕和 scrollback。检查 60 条旧历史及定稿标记恰好存在一次、没有被 renderer 重印，检测清除 scrollback 和进入备用屏幕的控制序列。
- 在同一个 bash 内比较应用前后的 `stty -g`，再实际执行 `read` / `printf`，检查终端回显、光标和 bracketed paste 恢复。
- `waitUntilRenderFlush()` 后等待 PTY 输出稳定，再读取终端内容。本轮不是高频 resize 压力测试。

## 结果

| 场景 | 结果 | 观察 |
|---|---|---|
| 负对照：5 行终端、6 行动态内容 | 检测器通过，方案行为失败 | 两次 `CSI 3J`；启动前历史消失 |
| 5 行终端、4 行动态区，连续 10 次刷新并追加定稿记录 | 通过 | 旧历史、定稿记录保留且不重印；无 `CSI 3J` |
| 24 行高，宽度依次为 80 → 60 → 40 → 20 → 8 → 80 → 30 → 10 → 80 | 通过 | 包含长定稿内容；历史标记未丢失或重印，无 `CSI 3J`；保存的检查点未发现活动区副本累积 |
| **高度 24 → 12，4 行活动区，启用 `useCursor`，随后刷新** | **失败** | **紧邻活动区的 `DONE00` 被覆盖；没有 `CSI 3J`，更早的历史仍在** |
| 同一高度缩放，唯一差别是关闭 `useCursor` | 对照通过 | `DONE00` 保留；不能作为正式修复，因为输入光标是现有要求 |
| **高度 24 → 3，活动区随之降为 2 行** | **失败** | **仍发出两次 `CSI 3J`，应用启动前历史消失** |
| 中文/emoji 草稿、左移光标、异步追加定稿、括号粘贴 | 通过 | 草稿及光标位置保留；CRLF 折成空格；粘贴不提交，之后按 Enter 才产生一条提交 |
| 正常关闭、键盘 Ctrl+C / Ctrl+D、进程 SIGINT / SIGTERM | 通过 | 同一个 shell 的 `stty -g` 一致；光标可见，粘贴模式关闭且启闭配对，shell 可继续读入并回显 |
| React 组件 render 抛错后的终端恢复 | 通过 | fixture 执行幂等关闭及 `finally` 恢复，退出码 1，shell 可继续使用 |
| **React 组件 render 抛错时的历史保留** | **失败** | **Ink 默认错误展示不受原活动区高度限制，发出两次 `CSI 3J`，旧历史消失** |

所有场景均未检测到进入 alternate screen 的序列。

### 最关键的反例：不清 scrollback，也会覆盖已定稿输出

最小操作顺序：

1. 80 × 24 的 PTY，主屏渲染 4 行，`useCursor` 位于输入行。
2. `<Static>` 输出 `DONE00`。
3. PTY 高度变为 12，宽度保持 80。
4. 更新活动文本，保持活动区为 4 行。

刷新前后，解析后的相关内容是：

```text
Before redraw:          After redraw:
OLD_59                  OLD_59
DONE00                  LIVE12:0
LIVE1:0                 LIVE12:1
LIVE1:1                 LIVE12:2
LIVE1:2                 >
>
```

`DONE00` 在屏幕和 scrollback 中的数量由 1 变为 0。只扫描 `CSI 3J` 会漏掉这个问题。

原始刷新序列包含“光标下移一行，再向上擦除五行”。缩矮窗口后，光标已经落在新视口最后一行；向下移动被终端边界截住，随后多擦到一行已定稿输出。关闭 `useCursor` 的单变量对照没有发生这个现象。

## 与已安装源码的对应关系

定位的是安装得到的 Ink 7.1.1 源码，没有对其打补丁：

- `node_modules/ink/build/ink.js`：`resized()` 在宽度缩小时重置动态输出，没有对应的高度缩小光标位置校正。
- `node_modules/ink/build/log-update.js` 与 `cursor-helpers.js`：刷新前按缓存的行数，将 `useCursor` 光标移回输出底部，再擦除旧帧；该计算依赖原来的尾部空行仍存在。
- `ink.js` 的 `shouldClearTerminalForFrame()` 同时比较**上一帧高度**和**新视口高度**。因此新活动区已经缩到 2 行，仍不能阻止旧 4 行帧相对于新 3 行视口触发全清。
- Ink 的默认错误展示是另一条可能超出有界活动区的路径。`close()` 恢复 TTY 不能撤销已经发生的历史删除。

这些解释与原始控制序列和 PTY 结果一致，但不能据此断言所有 Ink 版本、配置或定制错误处理都不可行。

## 复现

从仓库根目录执行：

```sh
cd experiments/ink-pty
npm ci

# node-pty 1.1.0 ships the macOS prebuilt spawn helper without execute permission.
if [ "$(uname -s)" = Darwin ]; then
  chmod u+x "node_modules/node-pty/prebuilds/darwin-$(node -p process.arch)/spawn-helper"
fi

npm test
```

**当前 `npm test` 应退出 1，显示三个历史保留测试失败。** 没有将这些失败改成预期成功或跳过；负对照则明确断言检测器能发现历史删除。

只复现不溢出也覆盖定稿的场景：

```sh
node --test --test-name-pattern='24-to-12' test.mjs
```

只运行关闭光标的对照：

```sh
node --test --test-name-pattern='without useCursor' test.mjs
```

结果写入本目录的 `artifacts/`，已加入 `.gitignore`：

- `*.ansi`：原始 PTY 输出。
- `*.json`：输入操作、各检查点的屏幕、完整逻辑行、光标、终端模式及字节数。
- `height-resize.*`：24 → 12 行覆盖定稿的反例。
- `height-no-cursor.*`：关闭 `useCursor` 的对照。
- `short-resize.*`：缩到 3 行时清除历史。
- `render-error-history.*`：默认错误展示清除历史。

测试入口是 `test.mjs`，真实终端驱动在 `harness.mjs`，最小 Ink 应用在 `fixture.mjs`。该驱动依赖 Unix shell 和 Unix socket；本轮没有验证 Windows。

## 范围与后续判断

已足以否定“限制为 4 行就能保证当前 Ink 方案安全”的假设；**不能据此直接采用当前方案进入正式实现**。

本轮没有验证：dsh 集成、审批/问题和命令协议、完整输入编辑器、真实中文输入法候选窗、所有终端模拟器、快速缩放竞争、写出流底层故障或渲染性能上限。终端恢复通过的是 fixture 的 Ink + 宿主关闭策略，不代表仅靠 Ink 就能处理所有宿主异常。

也没有比较 Rust、log-update 或自写 renderer。这些失败证明的是当前组合的终端行为不符合要求，不是 Node 性能不足，更不是 Rust 必然更好。下一步应另行选择要验证的渲染方式，继续复用 PTY 这一验收入口，而不是放宽历史保留要求。
