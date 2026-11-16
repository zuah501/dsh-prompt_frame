/**
 * dsh-prompt-frame —— 把 DSH 的 system prompt 装配结果整段换成一份可配置的注入框架。
 *
 * 它挂的是 cordis 的 `system-prompt/assemble` 瀑布：宿主每轮把各插件贡献的 section
 * 收成一个 assembly 交过来，本插件在瀑布最前面（prepend）拿到最终结果，交给
 * vendor/identity.js 的 rewritePromptAssembly() 做整段改写——删掉 harness:identity
 * 官方身份段、可选删掉工作区 AGENTS.md 基线、剥掉 chatml/官方人格句，再把注入正文
 * 以最高优先级置顶（order = -100000）。不是"追加一段"，是"换掉装配结果"。
 *
 * 为什么不需要 asar 补丁：
 *   0.2.1-rc.3 的 prompt 组装本身是 cordis 服务（systemPrompt），
 *   `system-prompt/assemble` 是公开瀑布事件。插件只要 inject 了 systemPrompt 服务
 *   并在 apply() 里 ctx.on() 挂上去，就在宿主进程内、在最终 prompt 生成之前拿到
 *   完整 assembly，改写后直接返回即可。dsh-purge 早期版本要改 app.asar 是因为它
 *   想改的是渲染层之外的静态字符串，且没有走瀑布；本插件不碰任何宿主文件。
 *
 * 只依赖 node: 内置模块 + @deepseek-ai/schemastery；不改 profile、不读宿主源码、
 * 不 import 任何 @deepseek-ai/dsh-* 包，卸载即完全消失。
 *
 * @module dsh-prompt-frame
 */
import Schema from "@deepseek-ai/schemastery";

import { apply as applyCore, createHandler } from "./core-logic.js";

/** 流水线契约版本：stage 形状或 createPipeline 签名变化时 +1（见 README「扩展点」）。 */
export { FRAME_API } from "./pipeline.js";

/** cordis 插件名，loader 诊断用。 */
export const name = "dsh-prompt-frame";

/**
 * apply 之前必须就绪的服务。
 * - systemPrompt：提供 system-prompt/assemble 瀑布（注入本体）。
 * - webServer：提供 register() 用来挂 /api/prompt-frame/* 控制台路由。
 *   cordis 里访问未声明的服务，属性代理直接抛
 *   `cannot get property "webServer" without inject`，控制台会静默降级成「未连接」。
 *   2026-10-24 实测踩过：不写这一项，registerConsole 永远返回 false。
 */
export const inject = ["systemPrompt", "webServer"];

/**
 * 设置表单 schema。宿主 dsh-settings 会读这个 schema 自动渲染表单，
 * 所以每个字段都带中文 description。
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description("总开关。关闭后本插件不改写装配结果，瀑布继续往下走。"),
  injectFile: Schema.string()
    .default("")
    .description("注入正文文件路径。留空 = $DSH_HOME/prompt-inject.md；该文件不存在时用包内 assets/frame.md。"),
  offFlag: Schema.string()
    .default("")
    .description("OFF 标志文件路径。留空 = $DSH_HOME/.dsh-prompt-frame.off；该文件存在即跳过注入，每次装配检查，无需重启。"),
  dropWorkspaceBaseline: Schema.boolean()
    .default(true)
    .description("删掉工作区 AGENTS.md 基线段。开启后项目级 AGENTS.md 不再进 prompt，副作用见 README。"),
  dropMnemon: Schema.boolean()
    .default(true)
    .description("删掉 mnemon 记忆插件的提示段。"),
  logFile: Schema.string()
    .default("")
    .description("装配日志路径（JSONL）。留空 = $DSH_HOME/dsh-prompt-frame.log。"),
  logMaxLines: Schema.number()
    .default(4000)
    .description("日志行数上限；超过后只保留最后 2000 行。"),
  extra: Schema.string()
    .default("")
    .description("附加到注入正文末尾的纯文本；留空表示不追加。"),

  // ---------------- 扩展点与性能旋钮（改行为/调性能不必重写本包） ----------------
  stagesDir: Schema.string()
    .default("")
    .description("自定义阶段目录。留空 = $DSH_HOME/dsh-prompt-frame/stages；目录里的 *.mjs 会被自动加载并按 order 排序执行。"),
  disabledStages: Schema.array(Schema.string())
    .default([])
    .description("要跳过的阶段名列表，内建阶段 identity-rewrite / section-filter 也可以关。"),
  dropSections: Schema.array(Schema.string())
    .default([])
    .description("按 section 名精确删除指定的 prompt 段（在改写之后执行）。"),
  keepSections: Schema.array(Schema.string())
    .default([])
    .description("非空时只保留列出的 prompt 段（注入段始终保留），比布尔开关更细。"),
  cacheInjectText: Schema.boolean()
    .default(true)
    .description("按 mtime 缓存注入正文，避免每次装配都重读文件。注入文件被改动后自动失效。"),
  perf: Schema.boolean()
    .default(true)
    .description("在装配日志里记录 ms 与阶段数，便于以后对比性能。"),
  maxInjectBytes: Schema.number()
    .default(0)
    .description("注入正文字节上限；0 = 不限。超出时截断并记录 truncated，防止正文变长后撑爆上下文。"),
  capabilityProtocol: Schema.boolean()
    .default(false)
    .description("是否让 vendor 追加 dshpg-capabilities 能力协议段。默认 false：与实验期取值一致，多这一段属于未验证路径。"),
  dropPurgeAfterFold: Schema.boolean()
    .default(false)
    .description("是否把注入正文折进 persona 并删掉 dsh-purge 段（vendor 默认 true）。默认 false，保持注入段独立置顶。"),
  roleText: Schema.string()
    .default("")
    .description("额外的角色文本，交给 vendor 拼接。默认空，与实验期一致。"),
});

/**
 * 挂载入口。真正的逻辑在 core-logic.js（那边不依赖 schemastery，便于离线测试）。
 * @param {object} ctx cordis 插件上下文，已注入 systemPrompt 服务。
 * @param {object} config schemastery 校验后的配置。
 */
export function apply(ctx, config) {
  return applyCore(ctx, config);
}

export { createHandler };
