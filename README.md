# dsh-prompt-frame

[中文](#中文) · [English](#english)

---

## 中文

**轻量化的 AI Agent 上下文管理插件。** 通过分层提示词注入，为不同工作区提供独立的身份定位、规则约束和持续记忆能力。

`dsh-prompt-frame` 是 [DeepSeek Harness](https://deepseek.com)（DSH）的 bundle 插件。它在 system prompt 装配阶段接管整段结果，按当前工作区注入对应的约定，而不是让所有工作区共用一套身份和规则。

> **定位**：工作区级的全对话约定（workspace-level standing convention）。
>
> 关键词：`轻量化` · `工作区隔离` · `分层注入` · `跨会话记忆`

### 它解决什么问题

同一个 DSH 桌面端里往往同时开着几个工作区——一个写论文、一个跑实验、一个管图片生成。它们的身份、语言、输出格式、禁止操作全是两套逻辑，但宿主只给一份通用的 system prompt：

- 身份是通用的，每个工作区都要在对话里反复交代"你是干什么的"；
- 规则是共享的，A 工作区的约束会被 B 工作区的对话继承；
- 记忆是易失的，"上次定的方案"活不过一次新会话。

`dsh-prompt-frame` 的做法是：**在 system prompt 装配的最后一个环节，把整段结果换成当前工作区的那一份**。换进去的内容由三部分叠加而成——身份层、规则层、记忆层——所以你只需要维护"这个工作区是什么"，不用每次重新说服模型。

### 三层结构

```
┌─────────────────────────────────────────────┐
│  Layer 1 · 身份         你是本工作区的…      │  ← 谁在说话
├─────────────────────────────────────────────┤
│  Layer 2 · 规则         边界 / 执行 / 输出   │  ← 什么能做、怎么做
├─────────────────────────────────────────────┤
│  Layer 3 · 记忆         跨会话延续的事实     │  ← 上次定过什么
├─────────────────────────────────────────────┤
│  工作区专属追加                             │  ← 本项目自己的约定
└─────────────────────────────────────────────┘
```

注入正文是一份纯 Markdown，写成一整段就行——分层是**写法建议**，不是强制格式。仓库里的 `assets/frame.md` 就是这个结构的一份空白模板，六个小节分别是身份、工作区边界、执行约定、输出约定、记忆、专属规则。

### 工作区隔离

每个工作区各自持有：

| 位置 | 内容 | 隔离粒度 |
|---|---|---|
| `~/.dsh/prompt-inject.md` | 全局默认注入正文 | 整个 DSH |
| `~/.dsh/dsh-prompt-frame/profiles/*.md` | 命名版本（可切换） | 整个 DSH |
| 工作区 `AGENTS.md` | 该项目自己的规则文件 | 单个工作区 |

默认行为会**剥掉宿主的 workspace baseline 段**（也就是 `AGENTS.md` 那段自动基线），把它的位置让给你注入的正文；如果你更想让 `AGENTS.md` 保持原样，把 `dropWorkspaceBaseline` 设成 `false` 即可，两者会叠加。

### 持续记忆

插件本身不存记忆——它只负责**每轮都把记忆带进上下文**。

约定是把跨会话要延续的东西写进文件：工作区的 `AGENTS.md`、`STATE.md`、或 `~/.dsh/prompt-inject.md`。插件每轮重读这些文件（按 mtime + size 缓存，改了自动失效），所以改文件 = 改下一轮的行为，不用重启。

---

### 安装

**前置**：DSH 桌面端 0.2.x、Node.js ≥ 22.19。

#### 方式一 · 安装包

```bash
# 下载 release 里的 zip，解压后双击：
install.cmd
```

`install.cmd` 做三件事：把目录 robocopy 进 `<profile>/node_modules/dsh-prompt-frame`；跑 `_patch_bundles.mjs` 把 `dsh-prompt-frame` 追加进 profile `package.json` 的 `dsh.profile.bundles`；校验文件齐全。

**安装前必须完全退出桌面端**（含托盘），否则 `node_modules` 被占用。

#### 方式二 · 手动

```bash
# 1. 复制到 profile
cp -r dsh-prompt-frame "$USERPROFILE/.dsh/profiles/desktop/node_modules/"

# 2. 注册 bundle —— 编辑 <profile>/package.json，在 dsh.profile.bundles 里加一行
"dsh-prompt-frame"
```

#### 方式三 · npm（如果你把它发布到了 registry）

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-prompt-frame
```

`@deepseek-ai/schemastery` 已声明为 `peerDependencies`（宿主 profile 本就带一份，公共 registry 上也有 3.x），pnpm 会自动解析；若目标 profile 根没有它，先 `pnpm add @deepseek-ai/schemastery`。

装完启动桌面端，随便聊一轮，看 `~/.dsh/dsh-prompt-frame.log`：

```json
{"applied":true,"segments":3,"bytes":1204,"ms":1.7}
```

出现 `"applied":true` 就成了。

---

### 配置

配置走 DSH 的设置页（设置 → 插件 → 提示注入框架），字段由 `lib/index.js` 的 `Config` 自动生成表单。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后不改写，瀑布继续往下走。 |
| `injectFile` | `""` | 空 = `$DSH_HOME/prompt-inject.md`；该文件不存在则用包内 `assets/frame.md`。 |
| `offFlag` | `""` | 空 = `$DSH_HOME/.dsh-prompt-frame.off`。文件存在即跳过注入，**每轮检查，不用重启**。 |
| `dropWorkspaceBaseline` | `true` | 是否剥掉工作区 `AGENTS.md` 基线段。 |
| `dropMnemon` | `true` | 是否剥掉 mnemon 记忆插件的段。 |
| `logFile` | `""` | 空 = `$DSH_HOME/dsh-prompt-frame.log`。 |
| `logMaxLines` | `4000` | 日志上限，超过后只留最后 2000 行。 |
| `extra` | `""` | 追加到注入正文末尾的纯文本。 |
| `stagesDir` | `""` | 空 = `$DSH_HOME/dsh-prompt-frame/stages`。目录里的 `*.mjs` 会被当作阶段自动加载。 |
| `disabledStages` | `[]` | 跳过指定阶段。 |
| `dropSections` | `[]` | 按段名精确删除（在改写之后执行）。 |
| `keepSections` | `[]` | 非空时只保留列出的段，注入段始终保留。 |
| `cacheInjectText` | `true` | 按 mtime+size 缓存注入正文。 |
| `perf` | `true` | 在装配日志里记录耗时 `ms` 与阶段数，便于对比性能。 |
| `maxInjectBytes` | `0` | 注入正文字节上限，0 = 不限；超出时截断并记 `truncated`。 |
| `capabilityProtocol` | `false` | 是否让 vendor 追加 `dshpg-capabilities` 能力协议段。默认关，属未验证路径。 |
| `dropPurgeAfterFold` | `false` | 是否把注入正文折进 persona 并删掉 dsh-purge 段（vendor 默认 `true`）。默认关，保持注入段独立置顶。 |
| `roleText` | `""` | 交给 vendor 拼接的额外角色文本。默认空。 |

#### 版本管理

控制台可以把注入正文保存成命名版本（`profiles/*.md`），在不同版本间切换、对比、回滚。写正文的操作**永远只写用户覆盖文件**（`~/.dsh/prompt-inject.md`），包内 `assets/frame.md` 不会被改写。

#### 免重启开关

```bash
echo off > ~/.dsh/.dsh-prompt-frame.off    # 关闭
rm ~/.dsh/.dsh-prompt-frame.off            # 打开
```

下一轮装配立刻生效，日志里出现 `"applied":false,"reason":"off-flag"`。

---

### 工作原理

DSH 0.2.x 把 prompt 组装做成了 cordis 服务。插件声明 `inject = ['systemPrompt']` 之后：

```
host assemble ──▶ system-prompt/assemble (瀑布)
                        │
                        ▼
              ┌──────────────────┐
              │ dsh-prompt-frame │  取到完整 assembly
              └────────┬─────────┘
                       │  1. 丢掉宿主身份段
                       │  2. 丢掉 mnemon / workspace baseline 段（可配）
                       │  3. 其余段剥掉 chatml 信封与默认人格句
                       │  4. 注入正文置顶（order = -100000）
                       ▼
                 改写后的 assembly ──▶ 模型
```

插件**不注册工具、不改宿主文件、不碰 `app.asar`**，只在这一个瀑布事件上挂了一个 handler。卸载即完全消失。

控制台额外提供一个可热加载的**阶段流水线**（`lib/pipeline.js`，`FRAME_API = 1`）：一个阶段就是 `{ name, order?, transform(assembly, info) }`，返回对象表示继续用这个结果、返回 `null` 表示不改。内建两个阶段——`identity-rewrite`（order 100，就是主改写逻辑）和 `section-filter`（order 150，按段名增删）；用户阶段的默认 order 是 500。阶段抛错只跳过它自己。

**性能**：本机基线 ~590 次装配/秒，单次 1.7 ms 量级（`node _bench.mjs 300` 可复测）。

---

### 文件布局

```
dsh-prompt-frame/
├── lib/
│   ├── index.js         cordis 入口 + Config schema + 工具注册
│   ├── core-logic.js    配置归一化、路径解析、注入正文读取
│   ├── pipeline.js      阶段流水线（可热加载）
│   ├── console.js       控制台后端（HTTP handler）
│   └── state.js         计数与聚合
├── client/
│   └── client.js        设置页卡片（web 端）
├── vendor/
│   ├── identity.js      装配体改写引擎
│   ├── capability-protocol.js
│   └── phase1-keep.js
├── assets/
│   └── frame.md         默认注入正文（空白模板）
├── cordis.patch.yml     bundle 注册
├── install.cmd
└── uninstall.cmd
```

---

### 路线图

v0 是**工作区级的全对话约定**：一个工作区一份正文，全局生效。

后续想做的方向：

- **层级细分** —— 把「身份 / 规则 / 记忆」拆成独立可插拔的层，各自有取舍和优先级，而不是塞在一份 Markdown 里；
- **注入管理** —— 按会话、按工具集、按时间段切换继承关系；冲突检测；
- **记忆后端** —— 从"读文件"扩到结构化存储，带版本与检索；
- **多工作区联动** —— 工作区之间显式声明继承关系（A 的约定默认对 A 的子目录生效，但可以对 B 只读可见）。

欢迎 issue 里提场景，不用提实现。

---

### 许可

插件本体 MIT，见 `LICENSE`。

`vendor/` 下的文件源自 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) v1.1.77（Apache-2.0），文件清单与用途见 `NOTICE`。

---

## English

**A lightweight context-management plugin for AI agents.** Layered prompt injection gives every workspace its own identity, rules, and persistent memory.

`dsh-prompt-frame` is a bundle plugin for DeepSeek Harness (DSH). It takes over the system-prompt assembly step and swaps in the convention that belongs to the *current workspace*, instead of letting every workspace share one generic identity.

Keywords: `lightweight` · `workspace isolation` · `layered injection` · `cross-session memory`

### The problem

One DSH instance usually hosts several workspaces — a paper, an experiment, an image pipeline. Each needs a different identity, language, output shape, and set of forbidden actions, but the host ships one generic system prompt:

- identity is generic, so you re-explain "what you are" every session;
- rules are shared, so workspace A's constraints leak into workspace B;
- memory is volatile — "the plan we agreed on" does not survive a new session.

The plugin replaces the whole assembly at the last step of prompt construction with the one that belongs to the current workspace. The injected text is layered — identity, rules, memory — so you only maintain *what this workspace is*.

### Isolation

| Location | What | Scope |
|---|---|---|
| `~/.dsh/prompt-inject.md` | global default injection body | whole DSH |
| `~/.dsh/dsh-prompt-frame/profiles/*.md` | named versions (switchable) | whole DSH |
| workspace `AGENTS.md` | project-level rules | one workspace |

By default the host's workspace-baseline segment is dropped to make room; set `dropWorkspaceBaseline: false` to keep both.

### Install

Requires DSH desktop 0.2.x and Node.js ≥ 22.19.

```bash
# fully quit the desktop app first (tray included), then:
install.cmd
```

Or manually: copy the folder into `<profile>/node_modules/dsh-prompt-frame` and append `"dsh-prompt-frame"` to `dsh.profile.bundles` in `<profile>/package.json`.

Verify with `~/.dsh/dsh-prompt-frame.log` — look for `"applied":true`.

### Toggle without restart

```bash
echo off > ~/.dsh/.dsh-prompt-frame.off    # off
rm ~/.dsh/.dsh-prompt-frame.off            # on
```

### How it works

DSH exposes prompt assembly as a cordis service. The plugin declares `inject = ['systemPrompt']`, receives the full assembly on the `system-prompt/assemble` waterfall, drops the host identity / optional baseline segments, strips chatml envelopes, and prepends your body at `order = -100000`.

It registers no tools, touches no host files, and never patches `app.asar`.

### License

MIT for the plugin itself. Files under `vendor/` are derived from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) v1.1.77 (Apache-2.0) — see `NOTICE`.
