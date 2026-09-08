# dsh 简洁 TUI 设计

状态：提案

开发方式：TDD；每个功能严格按一个失败测试、最小实现、再进入下一个测试的顺序开发。

## 目标

实现一个独立发布的 dsh bundle，通过以下方式安装和运行：

```sh
dsh plugin --profile tui add @ekil9/dsh-tui
dsh --profile tui
```

它直接叠加在 `@deepseek-ai/dsh-base` 上，同进程创建并驱动一个顶层 Agent；不要求先启动 `dsh web`，也不修改 DeepSeek Harness 主仓库。

用户体验接近普通命令行：回答和已经完成的工具活动进入真实终端滚动记录，最下方只保留当前活动内容、状态和输入。主界面不进入 alternate screen。

成功标准：

- 输入文本并回车后能看到流式回答。
- 工具执行期间显示进行中状态，结束后留下简短的成功或失败记录。
- `Esc` 或 `Ctrl+C` 能中断当前工作，而不会破坏终端状态。
- 审批、单选、多选和自由文本问题能在同一输入位置完成。
- `/...` 由 dsh 的命令服务解析，未知命令不会进入模型上下文。
- 正常退出、异常启动失败、`SIGINT`、`SIGTERM` 和窗口缩放后，shell 都能继续正常使用。

## 第一版范围

包含：

1. 新建一个会话。
2. 单行输入、基本编辑、进程内输入历史和安全粘贴。
3. 流式纯文本回答；不显示 reasoning 内容。
4. 基于工具自带 presentation 数据显示开始、结束和错误状态。
5. 中断、审批、用户问题和 dsh slash commands。
6. 会话持久化沿用 `dsh-base` 的现有后端。

不包含：

- 会话选择、恢复或分叉。
- 模型、技能、文件或子 Agent 浏览器。
- 侧栏、完整 Markdown、语法高亮、动画和声音。
- 文件补全、附件、图片和多行编辑器。
- PTY 工具的全屏接管。
- 供其他插件注入终端控件的扩展接口。

普通能力插件仍通过 dsh 的 Agent、工具、命令和事件接口工作；它们不会自动生成 TUI 控件。

## 用户交互

启动时只打印一条简短信息，然后显示输入：

```text
dsh · deepseek-v4-flash · /workspace/project

› _
```

运行时，输入仍可编辑：

```text
› inspect the failing test

I’ll inspect the relevant files first.
… Read package.json
… $ pnpm test

› _                                      running · Esc to stop
```

工具结束后，进行中行被最终状态替换；只有最终状态进入滚动记录：

```text
✓ Read package.json
✗ $ pnpm test · exit 1
```

### 按键规则

| 状态 | Enter | Esc | Ctrl+C | Ctrl+D |
|---|---|---|---|---|
| Agent 空闲 | `followup()` | 清空非空输入，否则无操作 | 清空非空输入；空输入时以 130 退出 | 空输入时以 0 退出 |
| Agent 运行 | `steer()` | 中断当前 Agent 工作 | 中断当前 Agent 工作 | 无操作 |
| 命令执行 | 不接受新提交 | 中断命令等待 | 中断命令等待 | 无操作 |
| 审批或问题 | 提交当前选择或文本 | 中断当前 Agent 工作 | 中断当前 Agent 工作 | 无操作 |

单行编辑至少支持左右方向键、Home、End、Backspace、Delete、`Ctrl+A`、`Ctrl+E`、`Ctrl+U`、`Ctrl+K`、`Ctrl+W` 和上下方向键浏览本次进程内的已提交输入。

粘贴作为一个整体接收；换行折叠为空格，不因粘贴内容中的回车而自动提交。光标按用户感知字符（grapheme）移动，并使用终端显示宽度计算位置，必须能正常输入中文和 emoji。

### Slash commands

以 `/` 开头的输入总是先调用：

```ts
ctx.commands.execute(agent, line, signal)
```

已知命令的返回文本直接显示，不提交给模型。语法无效或未知命令显示一条错误信息，也不退化为普通 prompt。命令执行期间由独立的 `AbortController` 处理取消。

### 审批

审批临时替换普通输入，并默认拒绝：

```text
? Allow bash once?
  Reason: command needs access outside the workspace
  y allow once · n reject
› _
```

`y` 返回 `allowed-once`；`n` 或空 Enter 返回 `rejected`。取消 Agent 后返回 `cancelled`，绝不把取消解释为允许。

第一版只回答当前顶层 Agent 的审批。其他 Agent 的请求在事件链（waterfall）中调用 `next()`，最终按 dsh 既有策略拒绝（fail closed）。

### 用户问题

相关问题按请求顺序逐个显示；当前顶层 Agent 的审批和问题共用一个 FIFO 队列，避免并行工具同时抢输入焦点。每个队列项保留自己的请求、内部 id 和 `AbortSignal`；已取消项立即移除，不会把答案交给另一项。

- 单选：输入一个编号；其他非空文本作为自定义回答。
- 多选：输入逗号分隔的编号。
- 无选项：输入自由文本。
- 空 Enter：保留该问题为跳过，即 `selected: []`。
- `plan-review`：显示 `detail` 原文及普通编号选项，不增加另一套回答协议。

新审批或问题出现时保留用户正在编辑的普通输入，交互结束后恢复。

## 包与组合

npm 上的无 scope 名称 `dsh-tui` 已被一个要求运行 `dsh web` 的第三方 HTTP 客户端占用。本项目使用用户拥有的 npm organization scope `@ekil9`，包名定为 `@ekil9/dsh-tui`，避免名称和安装方式混淆。

包只提供 Cordis 插件和 bundle，不增加自己的可执行文件。`package.json` 声明：

```json
{
  "name": "@ekil9/dsh-tui",
  "type": "module",
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`cordis.patch.yml` 完成五件事：

1. 设置该界面的 coding persona。
2. 关闭模块热重载，避免运行中替换持有 raw terminal 的代码；用户 patch 文件仍由 launcher 监视。
3. 与其他 dsh 应用一致地读取 `DSH_TOOLS_MODE`，并挂载 Code Mode worker。
4. 挂载 `dsh-tool-ask-user`，让模型能通过现有 user-questions 服务提问。
5. 插入 `tui-startup` 和 `tui-runner`。

示意配置：

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: hmr
  disabled: true

- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE

- insert:
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'

    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'

    - id: tui-startup
      name: '@ekil9/dsh-tui/startup'

    - id: tui-runner
      name: '@ekil9/dsh-tui'
      inject: [tuiStartup]
```

`tui-startup` 使用 `@deepseek-ai/dsh-cmdline`：第一版只接受 `--help`，其他参数直接报错。成功解析后发布空的 `tuiStartup` 服务；帮助或参数错误不会激活 runner。以后若加入 `--resume`，仍扩展这里，不增加第二个启动器。

所有 dsh 接口包使用与当前 dsh 版本完全一致的 peer dependency，不提供旧版本适配或运行时兼容分支。patch 直接点名的 Code Mode worker 和 `dsh-tool-ask-user` 由本包声明为直接依赖；Ink、React、文本宽度和控制字符清理库也是本包自己的直接依赖。

## 内部设计

包对外只有 Cordis 的 `apply(ctx)` 和 Loader 使用的 `./startup` 子路径，不发布 `ctx.tui` 服务，也不导出内部状态类型。

```text
dsh services
  agents · sessions · tools · commands · approval · userQuestions
       │
       ▼
TuiApplication              创建 Agent，管理完整生命周期
       │
       ├── TuiController     把事件和用户动作归并成一个界面快照
       ├── InteractionQueue  串行处理审批和问题
       └── InkTerminal       只负责输入与终端渲染
```

内部仅保留一个可替换的终端接口，生产实现使用 Ink，测试实现使用内存流或 PTY。dsh 调用、事件顺序和审批规则不暴露给 React 组件。

### 为什么不把逻辑直接写进 React

比较过三种结构：

1. **单文件 runner**：代码最少，但 dsh 生命周期、异步交互和终端清理会互相缠绕，难以证明异常路径安全。
2. **事件状态控制器 + 终端适配层**：接口仍很小，事件顺序、并行工具和取消可以用纯测试覆盖；推荐。
3. **React 组件直接订阅 dsh**：首屏最快，但业务状态散落在 hooks 中，审批 Promise、Agent disposal 和重渲染时序会成为界面实现细节；不采用。

推荐方案不是通用 UI 框架。`TuiController` 只服务当前产品，Ink 之外也只保留测试替身，不预设第二种正式界面。

## 数据流

### 启动

1. 验证 stdin/stdout 都是 TTY，且 stdin 支持 raw mode；否则在修改终端前失败并请求退出 1。
2. 等待 Loader 完成组合。
3. 读取 `ctx.agentDefaultModel.currentSelection()`，并预先生成随机 `SessionId`。
4. 创建控制器，先注册按该 id 过滤的 `session/event` 监听器，再创建 Agent，避免丢失创建窗口内的事件。
5. 以该 `SessionId`、当前 `cwd` 和 `installModelSelection()` 创建 Agent，然后从 `agent.status` 初始化状态并注册 status、approval 监听器和全局 user-question provider。
6. 挂载 Ink，最后才允许提交输入。

创建 Agent 的方式与 `dsh-headless` 相同，不直接依赖具体 agent-loop 实现。

### 会话事件

只接收预先生成的 `SessionId` 对应的 `session/event`。所有事件同步进入控制器的单一串行入口，React 通知可以合并，但 reducer 次序不可改变。新会话从 seq 0 开始要求事件连续；若出现缺口、重复或倒序，按同进程契约损坏处理，不猜测顺序。控制器维护两组展示块：

- **已定稿**：内容永不再变，可以交给 Ink `<Static>`，进入真实滚动记录。
- **活动中**：流式回答的末尾、未完成工具摘要和当前状态，可原地更新，但整个活动区必须保持有界。

当活动块定稿时，控制器只把从队首开始连续定稿的部分移入 `<Static>`。这样并行工具即使乱序结束，也不会改变人看到的调用顺序。若 turn 以取消或错误结束，属于该 turn 的未完成块全部转为明确的取消或失败终态，不能永久阻塞后续定稿内容。

### 流式回答

- `assistant/chunk` 的 `text-delta` 按 `turn/step/index` 累积。
- `reasoning-delta` 不显示。
- `assistant/message` 是最终权威值；它校正流式草稿并将完整回答定稿。
- 流式阶段只在活动区显示最后几行，不能把持续增长的整段草稿留在 Ink 动态树中；定稿后完整文本一次进入 `<Static>` 和终端滚动记录。
- 若 turn 以错误或取消结束而没有最终 message，将已收到的完整草稿定稿并标记为未完成，再追加简短原因。
- 只做纯文本换行，不解析 Markdown。

### 工具

收到 `tool/call` 后以 `callId` 缓存工具名、参数和展示块，再调用当前 Agent 可见的工具定义：

```ts
ctx.tools.get(name, agent)?.presentCall?.(args)
```

收到 `tool/result` 后只按其 `message.source.callId` 找到对应调用，并用该调用的缓存参数调用：

```ts
presentResult(args, { content, isError, meta })
```

显示规则只依据 presentation 中带 `card` 标记的类型，不按工具名分支：

- `generic`：显示短标题。
- `terminal`：用 `$` 标记，并在结束时显示 exit code 或 signal。
- `diff`：显示标题和涉及的路径数。
- 当前不专门渲染的 `read`、`search`、`web` 等结果保留调用标题并走通用完成状态。
- presenter 缺失、参数 JSON 无效或 presenter 抛错时，退化为工具名和成功/失败状态。

第一版不展开完整工具输出。失败时只增加经过清理的一行错误摘要。

## 终端方案

选择 **Ink 7**，但只把它当终端渲染和输入基础设施，不让它持有 dsh 业务状态。

| 方案 | 结论 |
|---|---|
| Ink 7 | 采用，但必须限制动态区高度。默认使用主屏；`<Static>` 可把定稿内容写入滚动记录；提供 `useInput`、`usePaste`、`useCursor`、resize、console 协调、unmount 和测试工具。Node 要求与 dsh 一致。 |
| OpenTUI | 暂不采用。它的 `split-footer`、Unicode 编辑器和测试工具与目标高度吻合，但当前 Node 支持严格要求 26.4.0 和 `--experimental-ffi`，React 绑定也没有独立 Node CI；采用它会把 dsh 原本可用的 Node 22/24 环境排除，并要求额外启动参数和原生平台包。 |
| Node readline | 不采用。行编辑成熟，但官方接口不负责异步输出期间清除并恢复半编辑输入；需要自行实现渲染、宽字符和恢复协调。 |
| pi-tui | 不采用。输入能力丰富，但当前主屏实现会在宽高变化等路径执行完整清屏，并需要宿主补足部分终端状态恢复；也容易重新走向已删除的完整前端。 |
| terminal-kit | 不采用。能力很多，但文档未给出本项目需要的 resize、粘贴、TypeScript 和完整恢复约束，不能减少验证成本。 |

第一版只需要文本、纵向布局、定稿记录、一个输入行和少量状态，不需要 scrollbox、表格、树、标签页或通用表单组件。Ink 的基础组件足够，不再叠加另一套 TUI 组件库，也不混用 OpenTUI renderer。

Ink 配置固定为主屏、`exitOnCtrlC: false`，不启用 alternate screen。`useCursor` 配合 `string-width` 与 Node 22 保证提供的 `Intl.Segmenter` 实现 CJK/emoji 光标；缺少该能力时启动失败，不增加字符级降级路径。不使用 `ink-text-input`，因为其当前实现以 UTF-16 code unit 移动和删除，无法满足该要求。PTY 自动验证终端已提交文本的编辑和光标位置；中文输入法候选窗属于真实终端人工验收。

不能把 Ink 当作无限高的动态 transcript。Ink 7.1.1 在动态 frame 超过 viewport 时会调用包含 `CSI 3 J` 的 `clearTerminal`，从而删除 scrollback；本地 5 行 PTY 测试已复现。因此动态区固定为最多 4 行并裁切溢出内容：回答只显示末尾，多个活动工具合并为摘要，审批和问题正文先作为定稿内容输出，输入本身横向滚动而不换行。完整回答和工具终态只通过同一个稳定的 `<Static>` 实例进入 scrollback。

`<Static>` 的内容不会在 resize 后重新换行，这是有意的：已经进入 shell scrollback 的输出应像普通命令输出一样保持原样，只有活动区按新宽度重排。若这种有界动态区在支持范围内的 PTY resize 仍会产生 `CSI 3 J`，Ink 方案判定失败，重新选择终端层；不能通过放宽 scrollback 要求或堆叠组件库掩盖。

## 生命周期与失败处理

`TuiApplication.close()` 必须幂等，并按以下顺序完成：

1. 标记 closing，停止接受新输入，撤销 session/status/approval 监听器和 user-question provider，阻止晚到事件再触发渲染。
2. 关闭交互队列；审批返回 `cancelled`，问题按 abort 结束；随后取消命令和仍在运行的 Agent 工作。
3. unmount Ink，等待输出 flush，恢复 raw mode 和光标，并关闭本插件启用的 bracketed paste；这一恢复放在 `finally` 中，后续 drain 失败也必须执行。
4. 在不再渲染事件的状态下等待 Agent 空闲并 flush Session。
5. dispose Agent handle。

用户主动退出或 renderer 失败时，应用先执行幂等的 `close()`，再调用 launcher 提供的 `ctx.appExit(code)`；绝不直接调用 `process.exit()`。插件 effect 的 finalizer 也调用同一个 `close()`，因此操作系统的 `SIGINT`/`SIGTERM` 可继续由 dsh launcher 负责，而不会再次请求退出。raw mode 中收到的键盘 `Ctrl+C` 由本插件按上表处理。

失败分类：

- 配置、依赖或非 TTY：启动失败，stderr 一条错误，退出 1。
- 模型或工具失败：写入会话区域，恢复普通输入，不退出进程。
- 命令失败：显示命令结果，不发送给模型。
- presenter 失败：记录 warning，使用通用工具状态，不影响事件消费。
- renderer 失败：先恢复终端，再请求退出 1。

## 安全与可读性

- 模型文本、工具标题、错误和命令结果在渲染前移除 ANSI/OSC 序列；除换行和制表符外的 C0/C1 控制字符不直接写入终端。
- 用户粘贴中的控制字符不会进入输入模型；换行折叠为空格。
- 不渲染 reasoning 内容。
- 审批默认拒绝，取消永不变成允许。
- 未识别的 session event 和 presentation variant 安全忽略或通用降级，不修改 dsh 数据。
- 颜色仅增强含义；`NO_COLOR` 下状态仍可由文字和符号区分。

## 文件结构

```text
cordis.patch.yml
package.json
tsconfig.json
src/
  index.ts                 Cordis 插件和异步 effect 生命周期
  startup.ts               --help 与参数拒绝
  application.ts           Agent 创建、监听注册、关闭顺序
  controller.ts            唯一界面状态和输入动作
  transcript.ts            session event 与工具 presentation 投影
  interactions.ts          审批/问题 FIFO 与 AbortSignal
  terminal/
    ink-terminal.tsx       Ink mount/unmount 和组件树
    line-input.tsx         grapheme 单行编辑、历史和粘贴
    display-text.ts        控制字符清理与安全摘要
test/
  transcript.test.ts       会话事件到界面快照
  plugin.test.ts           Cordis apply 与应用生命周期
  terminal/
    ink-terminal.test.tsx  组件可见行为
    pty.test.ts            真实终端协议与恢复
    fixtures/              PTY 测试应用
```

只有当一个文件确实拥有独立状态或失败规则时才拆分；不建立通用事件总线、主题系统、插件 SDK 或 renderer registry。

## 测试策略

### 固定测试切入点

测试只从以下三个稳定接口进入；这里的“切入点（seam）”是测试输入和观察行为的位置，不是新增的公共插件 API。

1. **会话投影**：向 `TuiController` 提交有序的 `session/event` 或用户动作，读取界面快照和待执行动作。它覆盖流式聚合、工具配对、定稿顺序和输入模式，不启动 React。
2. **Cordis 插件**：通过包公开的 `apply(ctx)` 组装真实 Cordis context，在模型/终端等系统边缘使用测试 adapter，观察用户可见结果和完整关闭行为，不断言私有方法调用。
3. **真实终端**：启动 packed 应用所在的 PTY，发送按键、粘贴、resize 和信号，只观察终端画面、控制序列、scrollback 与退出后的 shell 状态。

不为 React hook、私有字段、文件拆分或内部调用次数写测试。只在模型响应、时间、随机数和终端流等系统边缘使用替身；本包自己的模块通过真实接口组合。

### TDD 循环

- 一次只增加一个描述用户行为的失败测试，并先确认它确实失败且原因正确。
- 只写使当前测试通过的最小生产代码，不提前实现后续清单。
- 不先批量编写所有测试；每个切片都贯穿输入、状态和可观察输出。
- 当前切片转绿后运行相关检查；重构留到 review 阶段，不混入 Red → Green 循环。
- 预期值使用设计中的固定例子，不通过重复生产算法计算期望值。

第一个 Red 测试固定为：Agent 依次发出两个文本 chunk 和最终 message，界面只定稿一次完整回答，随后恢复普通输入。

### 纯逻辑测试

通过 `TuiController` 的输入和快照验证：

- 多个 text block、最终 message 校正、错误和取消。
- 并行工具乱序完成后的稳定顺序。
- presenter 缺失、抛错和未知 card。
- slash command 命中、未知、失败和取消。
- 审批默认拒绝、FIFO、AbortSignal 和多问题答案编码。
- 控制字符、中文、emoji、组合字符和单行粘贴。

测试与生产代码经过相同控制器接口，不读取 React 内部状态。

### Ink 组件测试

使用 Ink 测试工具验证定稿区、活动区、输入模式、窄终端和无颜色输出。不把每个 ANSI 字节当业务快照。

### PTY 验收

使用 `node-pty` 启动真实测试应用，并用 headless terminal 解释输出：

1. 输入、流式回答、工具开始/结束。
2. 半输入状态下收到异步输出，草稿和光标不丢失。
3. 中文/emoji、括号粘贴和真实 `SIGWINCH` resize；已定稿区不重排，活动区和光标按新宽度更新。
4. 多行粘贴、以 `/` 开头的粘贴和包含回车的粘贴都只在用户随后按 Enter 时整行解析一次。
5. `Esc`/`Ctrl+C` 中断 Agent、命令、审批和问题。
6. 在同一个 PTY shell 内依次覆盖正常退出、renderer 抛错、`SIGINT`、`SIGTERM`，退出后运行 `stty` 和 `echo` 确认 shell 可用。
7. 原始输出不得包含进入 alternate screen 的 `CSI ? 1049 h` 或删除 scrollback 的 `CSI 3 J`，并验证 bracketed paste 的启用与关闭成对。
8. 启动前已有的 terminal scrollback 和已定稿回答在 resize 后仍存在。

### 安装验收

从 packed tarball 和本地 checkout 分别执行：

```sh
dsh plugin --profile tui add .
dsh --profile tui --dump-config
dsh --profile tui --help
```

验证 profile 层次是 `dsh-base` 后接本 bundle，并且不启动 Host、HTTP server、Web runtime 或 browser client。

## TDD 实施顺序

下面是切片顺序，不是提前批量编写的测试列表。每个切片完成自己的 Red → Green 后才进入下一项：

1. **对话 tracer**：搭建最小包和 Vitest 环境；先写“两段 chunk 最终只出现一次完整回答”的失败测试，再实现最小会话投影。
2. **真实终端 tracer**：把同一对话接到有界 Ink 动态区和输入行；先用 PTY 固定无 alternate screen、无 `CSI 3 J` 和退出恢复，再补实现。
3. **工具活动**：逐个加入 call/result、并行乱序、错误和 presenter 降级行为。
4. **任务控制**：逐个加入空闲 `followup()`、运行中 `steer()`、`Esc`/`Ctrl+C` 取消和关闭顺序。
5. **Slash commands**：逐个加入命中、未知、失败和取消，不让 slash 文本进入模型。
6. **人机交互**：先审批，再单选、多选和自由文本问题，最后加入 FIFO 与 abort。
7. **交付链路**：packed install、profile 组合、`--help` 和 `--dump-config` 冒烟。

每个绿色切片都保持已有行为可运行；不先搭建会话浏览器、扩展框架或后续切片的占位实现。

## 第一版验收清单

- [ ] 本地安装后 `dsh --profile tui` 无需 `dsh web` 即可启动。
- [ ] 一次新会话可以连续完成多轮输入。
- [ ] 空闲输入走 `followup()`，运行中输入走 `steer()`。
- [ ] 流式文本不重复，reasoning 不显示。
- [ ] 工具无名称特判，未知 presenter 可降级。
- [ ] 审批、问题和 slash commands 端到端可用。
- [ ] 非 TTY 明确失败，不静默切换为另一种模式。
- [ ] 主界面从不进入 alternate screen，也不发出 `CSI 3 J` 删除 scrollback。
- [ ] 所有退出和故障路径恢复终端。
- [ ] PTY、类型检查、单元测试和 packed-install smoke 全部通过。

## 依据

- dsh 组合与 UI 接入：`docs/architecture.md`、`docs/cookbook/extension-cookbook.md`
- Agent 创建：`packages/bundle/headless/src/index.ts`
- 命令、审批与问题：`packages/interaction/*/README.md` 及对应源码
- 工具展示：`packages/core/tools/src/presentation.ts`、`docs/subsystems/tools.md`
- 已删除 TUI 的现行决策：`.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md`
- Ink：<https://github.com/vadimdemedes/ink>
- Ink scrollback 限制：<https://github.com/vadimdemedes/ink/issues/935>
- OpenTUI renderer 与运行环境：<https://opentui.com/docs/core-concepts/renderer/>、<https://opentui.com/docs/getting-started/runtime-support/>
- fx 交互参考：<https://github.com/vercel-labs/fx>
