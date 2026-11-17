# dsh-prompt-frame

A lightweight context-management plugin for DeepSeek Harness. Two-level prompt injection gives every workspace its own identity, rules, and standing memory.

[English](#english) · [中文](#中文)

---

## English

`dsh-prompt-frame` is a bundle plugin for [DeepSeek Harness](https://deepseek.com) (DSH). It takes over the system-prompt assembly step and injects the body that belongs to the *current working directory*, instead of letting every workspace share one generic identity.

- **Two-level injection** — a global body for every conversation, plus a workspace body that can be appended on top of it or take over entirely.
- **Directory rules** — matched by longest path prefix, so one rule can cover a whole tree and narrower rules refine it.
- **Named presets on disk** — plain Markdown files. Level-1 and level-2 presets live in separate filename namespaces, so `1` can exist in both.
- **Per-directory and per-session opt-out** — excluded places run on the host's native prompt, untouched, not on a stripped one.
- **Settings pages** — overview, level 1, level 2. Pick presets on the overview, write bodies on the level pages.
- **Header badge** — shows which two bodies are live in this conversation; clicking opens a popover that switches them for the current directory.
- **Hot-loadable stage pipeline** — transform the assembly in plain JavaScript, no rebuild.
- Registers no tools, patches no host files, never touches `app.asar`.

### The problem

One DSH instance usually hosts several workspaces — a paper, an experiment, an image pipeline. Each needs its own identity, language, output shape, and set of forbidden actions, but the host ships one generic system prompt:

- identity is generic, so you re-explain "what you are" every session;
- rules are shared, so workspace A's constraints leak into workspace B;
- memory is volatile — "the plan we agreed on" does not survive a new session.

The plugin replaces the whole assembly at the last step of prompt construction with the one that belongs to the current workspace, so you only maintain *what this workspace is*.

### Two-level injection

The injected body is assembled from two levels, both resolved per conversation from its working directory:

| Level | Default | Scope |
|---|---|---|
| Level 1 (global) | the preset in `activeProfile`; `default` means `~/.dsh/prompt-inject.md` | every conversation; a single directory rule can point this level at another preset |
| Level 2 (workspace) | empty; you may also set a *default level 2* as a fallback | the matched directory and its children; conversations with no rule of their own use the default level 2 |

```
level 1 body ──┐
               ├──▶ injected at the head of the system prompt
level 2 body ──┘     (or level 2 alone, in replace mode)
```

The **default level 2** (`defaultL2`) is a fallback for level 2: without writing a rule per directory, every conversation gets "global body + this addition". Set it with **Set as default** in the level-2 preset table; clear it the same way.

A directory rule is `{ path, l1, l2, mode }`:

- `l1` empty — level 1 follows the global `activeProfile`; non-empty — this directory uses another preset as its global body ("this workspace does not even share the global protocol").
- `l2` empty — no level 2; non-empty — append or replace with this body when matched.
- `mode` only matters when there is a level 2:
  - `append` (default) — level 1 first, level 2 after it, separated by a blank line. For "global protocol + project-specific addition".
  - `replace` — level 2 only. For places that need an entirely different voice. **If the level-2 file is unreadable, level 1 is used instead** — injection never silently disappears.

Guard rails:

- Both levels pointing at the same preset injects it once — the semantics are "this level equals the one above", not the same body twice.
- A level whose body is empty is skipped, so a rule with no text yet behaves like no rule.
- **But the two levels together may not be empty.** The global body is the last line of defence; emptying it means a blank system prompt, which is worse than the host default. So `default` refuses to store an empty body, and rules with both levels empty are dropped on read. To run somewhere natively, use `excludePaths`.
- Longest prefix wins: a rule for a subtree overrides the rule for its parent.

```json
// ~/.dsh/dsh-prompt-frame-state.json
{
  "activeProfile": "default",
  "pathProfiles": [
    { "path": "D:\\work\\research", "l1": "", "l2": "research", "mode": "append" },
    { "path": "D:\\work\\comfy", "l1": "strict", "l2": "comfy", "mode": "replace" }
  ]
}
```

Bodies live in `~/.dsh/dsh-prompt-frame/profiles/`: `research.md`, `comfy.md`, `strict.md`. Level-2 presets carry an `l2~` prefix on disk (`l2~comfy.md`), which is what keeps the two namespaces apart. Older state files that only carried `profile` are read as level 2 and still resolve the original `<name>.md`, so existing configs keep working untouched.

Exclusion and layering are two separate channels: `excludePaths` ("inject nothing here", subtraction) and `pathProfiles` ("inject something else here", addition). When both match, **exclusion wins**. With no `pathProfiles` at all, behaviour is exactly the "one global body" case.

### Workspace isolation

| Location | What | Scope |
|---|---|---|
| `~/.dsh/prompt-inject.md` | global default body | whole DSH |
| `~/.dsh/dsh-prompt-frame/profiles/*.md` | named presets (switchable, `l2~` = level 2) | whole DSH |
| `pathProfiles` in `~/.dsh/dsh-prompt-frame-state.json` | per-directory two-level rules | matched directory and its children |
| workspace `AGENTS.md` | project-level rules | one workspace |

By default the host's workspace-baseline segment is dropped to make room for the injected body; set `dropWorkspaceBaseline: false` to keep both side by side.

### Settings pages

The **Prompt injection** section in settings keeps a status line on top of every page: whether injection is on, which preset is level 1, which preset is the default level 2, how many directory rules exist, how large the native range is, and how many assemblies this process has served. Below it, three tabs:

- **Overview** — control page, no body editing. The rule table is expanded by default (click the title to collapse): one row per rule is `workspace | level 1 | level 2 | mode | remove`. Both level columns are dropdowns that write immediately, no save button; rows can be dragged by the handle to reorder (order only affects display and ties in prefix length). The add row is paste-directory → pick level 1 → pick level 2 → append/replace → add. The same page hosts the native range (excluded directories) and the per-session exclusion table, which lists each conversation's working directory, the levels actually applied, assembly counters, and a switch to run it natively.
- **Level 1 · global prompt** — pick a preset, edit, save; **New blank preset** creates `profiles/<name>.md` and switches to it; **Save as a new preset** copies the current body; **Make global** promotes it to `activeProfile`; the preset table can delete. A review line at the bottom says whether this body is live and how many directory rules use it as level 1.
- **Level 2 · workspace prompt** — this page does not know about directories: pick (or create) a level-2 preset, write, save. Which directory uses it is chosen on the overview page, so one level-2 body can serve several workspaces. A review line lists the rules referencing it; the level-2 preset table offers **Set as default** and delete.

Preset identity is the filename, and the namespace is the level: `l2~<name>.md` is level 2, everything else is level 1 (`default` is the special level-1 override pointing at `~/.dsh/prompt-inject.md`). `profiles/presets.json` only records the level of early, prefix-less presets. Deleting a preset deletes only the body file — rules that referenced it show "missing body · this level is skipped"; deleting a rule never deletes a body.

Every submit prints one feedback line under the tabs: `in progress` → `done · elapsed · time`, or `failed: reason`. Buttons do not silently grey out for a missing body or name any more — pressing tells you what is missing.

> Dark mode: the `<select>` options are pinned to a light background with dark text. Native `option` elements inherit the theme's white text over a system-light background and become unreadable — browser behaviour, not a styling preference.

### Header badge

The dot in the conversation header shows the body that is **actually applied this turn**: `level1 -- level2` in append mode, `level1 → level2` when level 2 replaces it, one name when only one level applies. Green = injecting; amber = native, meaning the directory or the session is excluded and the host prompt is left byte-for-byte alone. Hover lists both preset names, the mode, and the current directory.

The badge is clickable, but **clicking opens a popover and changes nothing by itself**: status and directory on top, three dropdowns (level 1 / level 2 / append-or-replace) that read and write the rule for this directory, and two buttons — **Save these two levels** and **Run this directory natively / Restore injection**. A plain click cannot flip the whole workspace any more: the badge only knows the cwd, not which rule matched. Per-session switching stays in the settings' native-range table, and both write the same exclusion list.

The badge lights up **before the first turn** too. Assembly records live in memory and are empty after a restart, so the console falls back to the workspace root the host handed the plugin at startup and computes a preview (marked as such in the tooltip). The preview is display-only; the real decision still happens in every assembly.

### Memory

The plugin stores no memory itself — it only makes sure your memory is **in the context every turn**.

The convention is to keep what must survive a session in files: the workspace's `AGENTS.md`, `STATE.md`, or `~/.dsh/prompt-inject.md`. Those files are re-read every turn (cached by mtime + size), so editing a file changes the next turn's behaviour without a restart.

### Install

Requires DSH desktop 0.2.x and Node.js ≥ 22.19.

**Option 1 — release archive.** Unzip, then, with the desktop app **fully closed (tray included)**:

```bash
install.cmd
```

It does three things: copies the folder into `<profile>/node_modules/dsh-prompt-frame`, runs `_patch_bundles.mjs` to append `dsh-prompt-frame` to `dsh.profile.bundles` in the profile's `package.json`, and verifies the files.

**Option 2 — manual.**

```bash
cp -r dsh-prompt-frame "$USERPROFILE/.dsh/profiles/desktop/node_modules/"
# then add "dsh-prompt-frame" to dsh.profile.bundles in <profile>/package.json
```

**Option 3 — npm.**

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-prompt-frame
```

`@deepseek-ai/schemastery` is declared as a `peerDependencies` entry (the profile already ships one, and 3.x is on the public registry); pnpm resolves it. If the target profile root lacks it, run `pnpm add @deepseek-ai/schemastery` first.

Start the app, send one message, then check `~/.dsh/dsh-prompt-frame.log`:

```json
{"applied":true,"segments":3,"bytes":1204,"ms":1.7}
```

`"applied":true` means it is working.

### Configuration

Configuration lives in the DSH settings form, generated from the `Config` schema in `lib/index.js`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Off = the waterfall continues untouched. |
| `injectFile` | `""` | Empty = `$DSH_HOME/prompt-inject.md`; if missing, the packaged `assets/frame.md` is used. |
| `offFlag` | `""` | Empty = `$DSH_HOME/.dsh-prompt-frame.off`. While the file exists, injection is skipped — checked every turn, no restart. |
| `dropWorkspaceBaseline` | `true` | Drop the workspace `AGENTS.md` baseline segment. |
| `dropMnemon` | `true` | Drop the mnemon memory-plugin segment. |
| `logFile` | `""` | Empty = `$DSH_HOME/dsh-prompt-frame.log`. |
| `logMaxLines` | `4000` | Log cap; beyond it only the last 2000 lines are kept. |
| `extra` | `""` | Plain text appended after the injected body. |
| `stagesDir` | `""` | Empty = `$DSH_HOME/dsh-prompt-frame/stages`. `*.mjs` files there are loaded as stages. |
| `disabledStages` | `[]` | Skip the named stages. |
| `dropSections` | `[]` | Delete segments by exact name, after the rewrite. |
| `keepSections` | `[]` | When non-empty, keep only these segments; the injected segment always survives. |
| `cacheInjectText` | `true` | Cache bodies by mtime + size. |
| `perf` | `true` | Record `ms` and stage count in the assembly log. |
| `maxInjectBytes` | `0` | Byte cap for the injected body, 0 = unlimited; overflow is truncated and logged as `truncated`. |
| `capabilityProtocol` | `false` | Let the vendor append a `dshpg-capabilities` segment. Off by default; not a verified path. |
| `dropPurgeAfterFold` | `false` | Fold the body into the persona and delete the dsh-purge segment (vendor default is `true`). Off by default, keeping the body as its own top segment. |
| `roleText` | `""` | Extra role text handed to the vendor. Empty by default. |

Bodies are always written to the user override file — `assets/frame.md` inside the package is never modified.

Besides those fields, `~/.dsh/dsh-prompt-frame-state.json` holds runtime state edited by the settings pages, not by the Config form: `activeProfile`, `pathProfiles` (the `{path, l1, l2, mode}` table), `defaultL2`, `excludePaths`, `excludeSessions`. Edit them in the UI or in the JSON — the file is re-read every turn.

**Toggle without restart:**

```bash
echo off > ~/.dsh/.dsh-prompt-frame.off    # off
rm ~/.dsh/.dsh-prompt-frame.off            # on
```

The next assembly picks it up and logs `"applied":false,"reason":"off-flag"`.

### How it works

DSH 0.2.x exposes prompt assembly as a cordis service. The plugin declares `inject = ['systemPrompt']` and then:

```
host assemble ──▶ system-prompt/assemble (waterfall)
                        │
                        ▼
              ┌──────────────────┐
              │ dsh-prompt-frame │  receives the full assembly
              └────────┬─────────┘
                       │  1. resolve the two levels for this cwd
                       │  2. drop the host identity segment
                       │  3. drop mnemon / workspace baseline (configurable)
                       │  4. strip chatml envelopes and the default persona line
                       │  5. prepend the injected body (order = -100000)
                       ▼
                  rewritten assembly ──▶ model
```

It registers no tools, touches no host files, patches no `app.asar` — one handler on one waterfall event. Uninstall and it is gone.

The console also exposes a hot-loadable **stage pipeline** (`lib/pipeline.js`, `FRAME_API = 1`): a stage is `{ name, order?, transform(assembly, info) }`; returning an object continues with it, returning `null` leaves the assembly alone. Two built-in stages — `identity-rewrite` (order 100, the main rewrite) and `section-filter` (order 150, add/remove by segment name); user stages default to order 500. A throwing stage only skips itself.

**Performance:** one assembly is a few file reads and string concatenations — milliseconds, no network calls. Bodies are cached by mtime, so consecutive turns in the same workspace do not re-parse them.

### File layout

```
dsh-prompt-frame/
├── lib/
│   ├── index.js         cordis entry + Config schema + tool registration
│   ├── core-logic.js    config normalization, path resolution, body composition
│   ├── pipeline.js      stage pipeline (hot-loadable)
│   ├── console.js       console backend (HTTP handler)
│   └── state.js         state IO (activeProfile / pathProfiles / exclusions / preset levels)
├── client/
│   └── client.js        settings pages + header badge (hand-written bundle, not compiled by the host)
├── tests/
│   ├── _test_v1_layers.mjs      two-level composition, rule resolution, file naming
│   ├── _test_v1_l2default.mjs   default level 2, same-name presets, delete isolation
│   ├── _test_v1_e2e.mjs         end-to-end assembly path
│   └── _test_v1_badge.mjs       status API and badge data
├── vendor/
│   ├── identity.js      assembly rewrite engine
│   ├── capability-protocol.js
│   └── phase1-keep.js
├── assets/
│   └── frame.md         default injected body (blank template)
├── _patch_bundles.mjs   writes the package name into the profile's dsh.profile.bundles
├── cordis.patch.yml     bundle registration
├── install.cmd
└── uninstall.cmd
```

### Development and tests

No external dependencies; run from the repository root:

```bash
node tests/_test_v1_layers.mjs
node tests/_test_v1_l2default.mjs
node tests/_test_v1_e2e.mjs
node tests/_test_v1_badge.mjs
```

All four are self-contained: they build state and presets in a system temp directory, clean up after themselves, never read or write `~/.dsh`, and do not disturb a running instance. Run them before and after touching the logic.

### License

MIT for the plugin itself — see `LICENSE`.

Files under `vendor/` are derived from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) v1.1.77 (Apache-2.0); the file list and their modifications are in `NOTICE`.

---

## 中文

**轻量化的 AI Agent 上下文管理插件。** 两级提示词注入，让每个工作区都有自己的身份定位、规则约束和持续记忆。

`dsh-prompt-frame` 是 [DeepSeek Harness](https://deepseek.com)（DSH）的 bundle 插件。它在 system prompt 装配阶段接管整段结果，注入**属于当前工作目录**的那一份，而不是让所有工作区共用一套身份和规则。

- **两级注入** —— 一段全局正文给所有对话，一段工作区正文按目录叠加在它后面，或者直接顶替它。
- **目录规则** —— 最长路径前缀优先，一条规则覆盖整棵树，更长的路径再收紧局部。
- **磁盘上的命名预设** —— 都是普通 Markdown。第一层和第二层各用一套文件名空间，同名互不覆盖。
- **目录级与会话级排除** —— 排除的地方走宿主原生提示词，一个字节不动，不是"剥剩下的"。
- **设置页三档** —— 概览选预设，第一层、第二层各写正文。
- **会话头部灯** —— 显示这一轮实际生效的两份正文；点开是浮窗，改的是当前目录这条规则。
- **可热加载的阶段流水线** —— 用普通 JavaScript 改写装配结果，不用重新编译。
- 不注册工具、不改宿主文件、不碰 `app.asar`。

### 它解决什么问题

同一个 DSH 桌面端里往往同时开着几个工作区——一个写论文、一个跑实验、一个管图片生成。它们的身份、语言、输出格式、禁止操作全是两套逻辑，但宿主只给一份通用的 system prompt：

- 身份是通用的，每个工作区都要在对话里反复交代"你是干什么的"；
- 规则是共享的，A 工作区的约束会被 B 工作区的对话继承；
- 记忆是易失的，"上次定的方案"活不过一次新会话。

插件的做法是：**在装配的最后一个环节，把整段结果换成当前工作区的那一份**。你只需要维护"这个工作区是什么"。

### 两级注入

注入正文按对话的**工作目录**分成两级，每一级都指向一个预设（预设 = `profiles/<名字>.md`，或 `default` 指向的覆盖文件）：

| 级 | 默认取值 | 作用范围 |
|---|---|---|
| 第一级（全局层） | `activeProfile` 指向的预设；`default` = `~/.dsh/prompt-inject.md` | 所有对话；单条目录规则可以把这一级换成别的预设 |
| 第二级（工作区层） | 空；可以另设一份「默认第二层」兜底 | 命中的目录及子目录；没被任何规则覆盖的对话用默认第二层 |

```
第一级正文 ──┐
             ├──▶ 置顶注入 system prompt
第二级正文 ──┘     （替换模式下只有第二级）
```

**默认第二层**（`defaultL2`）是第二级的兜底档：不用给每个目录写规则，也能让所有对话都带上「全局正文 + 这份补充」。在设置页「第二层」页的预设表里点**设为默认**设置，再点一次取消。

一条规则写成 `{ path, l1, l2, mode }`：

- `l1` 空 —— 第一级跟随全局 `activeProfile`；非空 —— 这个目录改用另一个预设当全局层（"这个工作区连全局协议都不一样"）。
- `l2` 空 —— 没有第二级；非空 —— 命中时叠加或替换这份正文。
- `mode` 只在有 `l2` 时起作用：
  - `append`（默认）—— 第一级在前、第二级在后，空行分隔。用于"全局协议 + 本项目补充"。
  - `replace` —— 只用第二级。用于绘画区、实验区这种要完全换一套说话的场合。**第二级文件读不到时回落第一级**，不会让注入凭空消失。

护栏：

- 两级指向同一个预设时只注入一次——语义是"这一级等于上一层"，不是把同一份正文叠两遍。
- 空正文的层会被跳过：配了规则还没写正文时，行为跟没配一样。
- **但两级的最终结果不能都是空。** 全局正文是最后兜底，把它清空等于让系统提示词变成空白，那还不如原生——所以 `default` 不允许存空正文，两级都为空的规则在读入时被丢弃。要让某处走原生，用 `excludePaths`。
- 规则按最长前缀优先：子树的规则盖过父目录的规则。

```json
// ~/.dsh/dsh-prompt-frame-state.json
{
  "activeProfile": "default",
  "pathProfiles": [
    { "path": "D:\\work\\research", "l1": "", "l2": "research", "mode": "append" },
    { "path": "D:\\work\\comfy", "l1": "strict", "l2": "comfy", "mode": "replace" }
  ]
}
```

对应正文放 `~/.dsh/dsh-prompt-frame/profiles/`：`research.md`、`comfy.md`、`strict.md`。第二层预设的文件名带 `l2~` 前缀（`l2~comfy.md`），所以第一层叫 `1`、第二层也叫 `1` 可以并存。老数据只写了 `profile` 的，读入时按第二级处理，仍读原来的 `<名字>.md`——旧配置不改就能继续跑。

排除与叠加是两条独立通道：`excludePaths` 是"这些目录完全不注入"（减法），`pathProfiles` 是"这些目录换成另一份"（加法）。同一个目录两边都写时，**排除优先**。没有 `pathProfiles` 时，行为与"只有一份全局正文"完全一致。

### 工作区隔离

| 位置 | 内容 | 隔离粒度 |
|---|---|---|
| `~/.dsh/prompt-inject.md` | 全局默认注入正文 | 整个 DSH |
| `~/.dsh/dsh-prompt-frame/profiles/*.md` | 命名预设（可切换，`l2~` 为第二层） | 整个 DSH |
| `~/.dsh/dsh-prompt-frame-state.json` 的 `pathProfiles` | 按目录的两级规则 | 匹配到的目录及子目录 |
| 工作区 `AGENTS.md` | 该项目自己的规则文件 | 单个工作区 |

默认会**剥掉宿主的 workspace baseline 段**（`AGENTS.md` 那段自动基线），把位置让给注入正文；想让 `AGENTS.md` 保持原样，把 `dropWorkspaceBaseline` 设成 `false`，两者叠加。

### 设置页

设置里的「提示词注入」在**所有页面顶部常驻**一条状态摘要：是否在注入、第一级是哪个预设、默认第二层是哪份（或"没设"）、有几条目录规则、原生范围多大、本进程装配了多少轮。下面三档页面：

- **概览** —— 总控页，只做"调用"不写正文。规则表默认展开（点标题折叠），一行就是一套配置：`工作区 | 第一层 | 第二层 | 方式 | 删除`。两个层级列都是下拉，改一下立刻写入，不用点保存；左侧手柄可以拖动换行序（顺序只影响展示，以及前缀长度相同时的取舍）。底下是"添加"：粘目录 → 选第一级 → 选第二级 → 选叠加/替换 → 添加。同页还有生效范围（原生模式）与会话表——逐条列出工作目录、实际生效的 L1/L2、装配次数和最近时间，可逐个切原生。
- **第一层 · 全局提示词** —— 选预设 → 改正文 → 保存；「新建空白预设」落一个 `profiles/<名字>.md` 并切过去；「把当前正文另存为新预设」复制成新文件；「设为全局生效」提升为 `activeProfile`；预设表可删除。底部审查行：这份正文此刻是否在生效、被几条目录规则当作第一级引用。
- **第二层 · 工作区提示词** —— 这一页**不认识"目录"**：不填目录、不选方式，只选（或新建）一个第二层预设、写正文、保存。哪个目录用它，回概览页那一行的下拉里选——所以一份第二层正文可以被多个工作区共用。审查行列出引用它的规则；「第二层预设管理」表只列第二层预设，操作列可以「设为默认」、也可以删除。

**名字就是预设**，**层级由文件名决定**：`l2~<名字>.md` 是第二层，其余都算第一层（`default` 是特殊的第一层覆盖文件，指向 `~/.dsh/prompt-inject.md`）。`profiles/presets.json` 只用来记录早期没有前缀的第一层预设。删规则不会连正文一起删；删预设只删正文文件，引用它的规则会显示"缺正文 · 这一级被跳过"。

每次提交都在导航下方留一行反馈：`进行中` → `完成 · 耗时 · 时间`，失败是 `失败：原因`。按钮不再因为"正文为空 / 没填名字"静默置灰，点了会直接告诉你缺什么。

> 深色模式：两级规则里的 `<select>` 选项显式固定为浅底深字。原生 `option` 在深色主题里会继承白字叠系统浅底，直接看不见——这是浏览器行为，不是样式偏好。

### 会话头部灯

那颗灯显示的是**这一轮实际生效的正文**：叠加模式下是 `第一层 -- 第二层`，第二层顶替第一层时是 `第一层 → 第二层`，只有一层就只显示那一层。绿点 = 正在注入；琥珀点 = 原生，即该目录或该会话在排除表里，**全局注入也一起隔离**，宿主 prompt 一个字节不动。悬停能看到两级各自叫什么、叠加还是替换，以及当前目录。

灯可以点，但**点开是浮窗，本身不改任何东西**：上半是这个工作区的状态与目录，中间三个下拉（第一层 / 第二层 / 叠加还是替换）直接读写这条目录规则，底部两个按钮是「保存这两级」和「整目录走原生 / 恢复注入」。单击不再直接翻转配置——徽章只知道 cwd、不知道命中了哪条规则，直改会把整个工作区一次性切走。按会话切仍在设置页的会话表里，两者写的是同一张排除表。

灯在**还没跑过一轮对话**时也会亮：装配记录在内存里，重启后为空，这时控制台退回插件启动时宿主给的工作区根先算一次预判（悬停里注明"预判"）。预判只是显示，真正的判定仍在每轮装配里。

### 持续记忆

插件本身不存记忆——它只负责**每轮都把记忆带进上下文**。

约定是把跨会话要延续的东西写进文件：工作区的 `AGENTS.md`、`STATE.md`、或 `~/.dsh/prompt-inject.md`。这些文件每轮重读（按 mtime + size 缓存，改了自动失效），所以改文件 = 改下一轮的行为，不用重启。

### 安装

**前置**：DSH 桌面端 0.2.x、Node.js ≥ 22.19。

**方式一 · 安装包**：解压后，**完全退出桌面端（含托盘）**再双击 `install.cmd`。它做三件事：把目录 robocopy 进 `<profile>/node_modules/dsh-prompt-frame`；跑 `_patch_bundles.mjs` 把 `dsh-prompt-frame` 追加进 profile `package.json` 的 `dsh.profile.bundles`；校验文件齐全。

**方式二 · 手动**：`cp -r dsh-prompt-frame "$USERPROFILE/.dsh/profiles/desktop/node_modules/"`，再在 `<profile>/package.json` 的 `dsh.profile.bundles` 里加一行 `"dsh-prompt-frame"`。

**方式三 · npm**：`cd ~/.dsh/profiles/desktop && pnpm add dsh-prompt-frame`。`@deepseek-ai/schemastery` 已声明为 `peerDependencies`（宿主 profile 本就带一份，公共 registry 上也有 3.x），pnpm 会自动解析；若目标 profile 根没有它，先 `pnpm add @deepseek-ai/schemastery`。

装完启动桌面端，随便聊一轮，看 `~/.dsh/dsh-prompt-frame.log`：

```json
{"applied":true,"segments":3,"bytes":1204,"ms":1.7}
```

出现 `"applied":true` 就成了。

### 配置

配置走 DSH 的设置页，字段由 `lib/index.js` 的 `Config` 自动生成表单。

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

写正文的操作**永远只写用户覆盖文件**（`~/.dsh/prompt-inject.md` 或 `profiles/*.md`），包内 `assets/frame.md` 不会被改写。

除上面的 Config 字段，`~/.dsh/dsh-prompt-frame-state.json` 里还有一组由设置页维护、不走 Config 表单的运行时状态：`activeProfile`、`pathProfiles`（`{path, l1, l2, mode}` 规则表）、`defaultL2`、`excludePaths` / `excludeSessions`。改这些用设置页，或直接改 JSON——每轮重读。

**免重启开关：**

```bash
echo off > ~/.dsh/.dsh-prompt-frame.off    # 关闭
rm ~/.dsh/.dsh-prompt-frame.off            # 打开
```

下一轮装配立刻生效，日志里出现 `"applied":false,"reason":"off-flag"`。

### 工作原理

DSH 0.2.x 把 prompt 组装做成了 cordis 服务。插件声明 `inject = ['systemPrompt']` 之后：

```
host assemble ──▶ system-prompt/assemble（瀑布）
                        │
                        ▼
              ┌──────────────────┐
              │ dsh-prompt-frame │  取到完整 assembly
              └────────┬─────────┘
                       │  1. 按 cwd 解析两级
                       │  2. 丢掉宿主身份段
                       │  3. 丢掉 mnemon / workspace baseline 段（可配）
                       │  4. 其余段剥掉 chatml 信封与默认人格句
                       │  5. 注入正文置顶（order = -100000）
                       ▼
                  改写后的 assembly ──▶ 模型
```

插件**不注册工具、不改宿主文件、不碰 `app.asar`**，只在这一个瀑布事件上挂一个 handler。卸载即完全消失。

控制台还提供一个可热加载的**阶段流水线**（`lib/pipeline.js`，`FRAME_API = 1`）：一个阶段就是 `{ name, order?, transform(assembly, info) }`，返回对象表示继续用这个结果、返回 `null` 表示不改。内建两个阶段——`identity-rewrite`（order 100，主改写）和 `section-filter`（order 150，按段名增删）；用户阶段默认 order 500。阶段抛错只跳过它自己。

**性能**：一次装配就是几次文件读取加字符串拼接，毫秒量级，没有网络调用；正文按 mtime 缓存，同一个工作区连续多轮不会重复解析。

### 文件布局

```
dsh-prompt-frame/
├── lib/
│   ├── index.js         cordis 入口 + Config schema + 工具注册
│   ├── core-logic.js    配置归一化、路径解析、两级正文拼装
│   ├── pipeline.js      阶段流水线（可热加载）
│   ├── console.js       控制台后端（HTTP handler）
│   └── state.js         状态读写（activeProfile / pathProfiles / 排除表 / 预设层级）
├── client/
│   └── client.js        设置页 + 会话头部灯（手写 bundle，宿主不编译）
├── tests/
│   ├── _test_v1_layers.mjs      两级组合、规则解析、层级文件命名
│   ├── _test_v1_l2default.mjs   默认第二层、同名两层、删除隔离
│   ├── _test_v1_e2e.mjs         装配链路端到端
│   └── _test_v1_badge.mjs       状态接口与灯的数据
├── vendor/
│   ├── identity.js      装配体改写引擎
│   ├── capability-protocol.js
│   └── phase1-keep.js
├── assets/
│   └── frame.md         默认注入正文（空白模板）
├── _patch_bundles.mjs   把包名写进 profile 的 dsh.profile.bundles
├── cordis.patch.yml     bundle 注册
├── install.cmd
└── uninstall.cmd
```

### 开发与测试

没有外部依赖，直接在仓库根跑：

```bash
node tests/_test_v1_layers.mjs
node tests/_test_v1_l2default.mjs
node tests/_test_v1_e2e.mjs
node tests/_test_v1_badge.mjs
```

四套用例都是自包含的：在系统临时目录里造 state 和预设、跑完自己清掉，不读写 `~/.dsh`，也不影响正在运行的实例。改逻辑前先跑一遍，改动后再跑一遍。

### 许可

插件本体 MIT，见 `LICENSE`。

`vendor/` 下的文件源自 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) v1.1.77（Apache-2.0），文件清单与改动见 `NOTICE`。
