/**
 * core-logic.js —— dsh-prompt-frame 的全部运行时逻辑，不依赖 schemastery，
 * 因此可以在没有宿主 profile 的普通 node 进程里被 _test.mjs 直接 import。
 *
 * 它做的事：在 cordis 的 `system-prompt/assemble` 瀑布上拿最终 assembly，
 * 交给 vendor/identity.js 的 rewritePromptAssembly() 整段改写
 * （删 harness:identity、可选删工作区基线、strip chatml/官方人格、注入正文置顶），
 * 然后返回改写后的对象；任何异常都退回宿主原本的 assembly。
 *
 * @module dsh-prompt-frame/lib/core-logic
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPipeline, truncateBytes } from "./pipeline.js";
import { registerConsole } from "./console.js";
import { readState, resolveProfileFile, resolveProfileForCwd, resolveScope, getSessionId, getSessionCwd, sessionDecision, normalizePath, safeGet, writeProfile } from "./state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 包根目录（由本文件位置推导，不含任何绝对路径字面量）。 */
export const PKG_ROOT = path.resolve(HERE, "..");
/** vendor 目录：identity.js 及其两个同目录依赖。 */
export const VENDOR_DIR = path.join(PKG_ROOT, "vendor");
/** 包内兜底注入正文。 */
export const ASSET_INJECT = path.join(PKG_ROOT, "assets", "frame.md");

/** 日志裁剪后保留的行数。 */
const KEEP_LINES = 2000;

/**
 * 解析 DSH 主目录：DSH_HOME 优先，否则 ~/.dsh。
 * @returns {string} 目录路径。
 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (env && String(env).trim()) return path.normalize(String(env).trim());
  return path.normalize(path.join(os.homedir(), ".dsh"));
}

/**
 * 把「空串=默认」的配置补齐成实际路径。
 * @param {object} cfg 已归一化的配置。
 * @returns {{injectFile: string, offFlag: string, logFile: string}} 绝对路径。
 */
export function resolvePaths(cfg) {
  const home = resolveDshHome();
  const pick = (value, fallback) => {
    const raw = typeof value === "string" ? value.trim() : "";
    return path.normalize(raw.length > 0 ? raw : fallback);
  };
  return {
    home,
    injectFile: pick(cfg.injectFile, path.join(home, "prompt-inject.md")),
    offFlag: pick(cfg.offFlag, path.join(home, ".dsh-prompt-frame.off")),
    logFile: pick(cfg.logFile, path.join(home, "dsh-prompt-frame.log")),
    stagesDir: pick(cfg.stagesDir, path.join(home, "dsh-prompt-frame", "stages")),
    profilesDir: path.join(home, "dsh-prompt-frame", "profiles"),
  };
}

/**
 * 给任意 config（可能来自 schemastery、也可能来自直接调用）补默认值。
 * 这里刻意不 import schemastery：宿主没装 schema 校验时也要能跑。
 * @param {object|null|undefined} config 原始配置。
 * @returns {object} 归一化后的配置。
 */
export function normalizeConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const str = (v, d) => (typeof v === "string" ? v : d);
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.length > 0) : []);
  return {
    enabled: bool(c.enabled, true),
    injectFile: str(c.injectFile, ""),
    offFlag: str(c.offFlag, ""),
    dropWorkspaceBaseline: bool(c.dropWorkspaceBaseline, true),
    dropMnemon: bool(c.dropMnemon, true),
    logFile: str(c.logFile, ""),
    logMaxLines: num(c.logMaxLines, 4000),
    extra: str(c.extra, ""),
    // ---- 扩展点与性能旋钮（m00785）----
    stagesDir: str(c.stagesDir, ""),
    disabledStages: list(c.disabledStages),
    dropSections: list(c.dropSections),
    keepSections: list(c.keepSections),
    cacheInjectText: bool(c.cacheInjectText, true),
    perf: bool(c.perf, true),
    maxInjectBytes: Number.isFinite(c.maxInjectBytes) && c.maxInjectBytes > 0 ? Math.floor(c.maxInjectBytes) : 0,
    // vendor 的三个开关：显式传 false，别改成 vendor 默认值。
    //   vendor 默认 capabilityProtocol=true（会多一段 dshpg-capabilities）、
    //   dropPurgeAfterFold=true（会把注入折进 persona 并删掉 dsh-purge 段），
    // 两者都是**未验证**的路径。
    capabilityProtocol: bool(c.capabilityProtocol, false),
    dropPurgeAfterFold: bool(c.dropPurgeAfterFold, false),
    roleText: str(c.roleText, ""),
  };
}

/** 每个日志文件的行数水标，进程内缓存，避免每次装配都读整份文件。 */
const logLines = new Map();

/** 注入正文缓存：每次装配都读 25 KB 文件是白扔的 IO，按 mtime+size 判失效。 */
const injectCache = new Map();

/**
 * 读一个文件，按 mtime+size 决定是否复用缓存。
 * @param {string} file 路径。
 * @param {boolean} useCache 是否启用缓存。
 * @returns {string} 内容；读失败返回空串。
 */
function readCached(file, useCache) {
  try {
    const st = fs.statSync(file);
    const hit = injectCache.get(file);
    if (useCache && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = fs.readFileSync(file, "utf8");
    injectCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    injectCache.delete(file);
    return "";
  }
}

/**
 * 读注入正文：优先 injectFile，其次包内 assets/frame.md，最后追加 extra。
 * @param {string} injectFile 已解析的注入文件路径。
 * @param {string} extra 附加纯文本。
 * @param {boolean} [useCache] 是否按 mtime 缓存文件内容（默认关闭，测试要可预期）。
 * @returns {{text: string, source: string}} 正文与实际来源。
 */
export function readInjectText(injectFile, extra, useCache = false) {
  let text = "";
  let source = "none";
  if (injectFile && fs.existsSync(injectFile)) {
    text = readCached(injectFile, useCache);
    source = text ? "file" : "none";
  } else if (fs.existsSync(ASSET_INJECT)) {
    text = readCached(ASSET_INJECT, useCache);
    source = text ? "asset" : "none";
  }
  const add = typeof extra === "string" ? extra.trim() : "";
  if (add) {
    const base = text.trimEnd();
    text = base ? `${base}\n\n${add}` : add;
    source = source === "none" ? "extra" : source;
  }
  if (!String(text || "").trim()) return { text: "", source: "none" };
  return { text, source };
}

/**
 * 拼装分层注入正文（v1：L1 全局层 + L2 工作区层 + extra）。
 *
 * 语义：
 *   - 没有命中工作区层 → 与"只有一份全局正文"时逐字一致（读 activeProfile 那份，缺失回落 assets/frame.md）。
 *     这是向后兼容的落点：老用户不写 pathProfiles，行为一点不变。
 *   - mode="append"（默认）→ 全局层在前、工作区层在后，空行分隔；后写的更具体，优先级更高。
 *   - mode="replace" → 只用工作区层。**但工作区层文件读不到时回落全局层**，不能让注入凭空消失。
 *   - extra 永远最后追加，且只追加一次（旧实现里是 readInjectText 内部追加）。
 *
 * 工作区层刻意**不走 assets/frame.md 回落**：那是"全局层缺失时的模板"，
 * 拿到工作区层上会把模板正文当成工作区协议注入，比不注入更糟。
 *
 * @param {object} paths 已解析路径。
 * @param {object} cfg 归一化配置。
 * @param {string} baseProfile 全局层版本名。
 * @param {{l1: string, l2: string, mode: string, rule: string}|null} scope 命中的工作区规则。
 * @returns {{text: string, source: string, layers: Array<{name: string, role: string, bytes: number}>}}
 */
export function composeInjectText(paths, cfg, baseProfile, scope) {
  const useCache = cfg.cacheInjectText === true;
  // 两级制：L1 是全局层，没写 scope.l1 就是 activeProfile；L2 是工作区层，空则不叠加。
  // 老数据（只有 profile）在 state 清洗时已折成 l2，所以这里不认 profile 字段。
  const l1Name = (scope && scope.l1) || baseProfile;
  const l2Name = scope && scope.l2 ? scope.l2 : "";
  const baseFile = resolveProfileFile(l1Name, paths, "l1");
  const base = readInjectText(baseFile, "", useCache);
  const layers = [];
  let text = base.text;
  let source = base.source;

  // 两级同名就不重复叠加：把工作区指回同一个预设是合法写法，
  // 语义应是"这一层等于上一层"，而不是把同一份正文注入两遍。
  if (l2Name && l2Name !== l1Name) {
    const layerFile = resolveProfileFile(l2Name, paths, "l2");
    let layerText = "";
    try {
      if (fs.existsSync(layerFile)) layerText = readCached(layerFile, useCache);
    } catch {
      layerText = "";
    }
    if (layerText.trim()) {
      layers.push({ name: l2Name, role: "workspace", bytes: Buffer.byteLength(layerText, "utf8") });
      if (scope.mode === "replace") {
        text = layerText;
        source = "workspace";
      } else {
        const head = text.trimEnd();
        text = head ? `${head}\n\n${layerText}` : layerText;
        source = "layers";
      }
    }
  }
  if (base.text) {
    layers.unshift({ name: l1Name, role: "global", bytes: Buffer.byteLength(base.text, "utf8") });
  }

  const add = typeof cfg.extra === "string" ? cfg.extra.trim() : "";
  if (add) {
    const head = text.trimEnd();
    text = head ? `${head}\n\n${add}` : add;
    if (source === "none") source = "extra";
  }
  if (!String(text || "").trim()) return { text: "", source: "none", layers };
  return { text, source, layers };
}

/**
 * 追加一行 JSONL 并按 logMaxLines 裁剪；任何失败静默（日志坏了不能影响装配）。
 * @param {string} file 日志路径。
 * @param {object} record 记录内容，t 由本函数补。
 * @param {number} maxLines 上限行数。
 */
export function appendLog(file, record, maxLines = 4000) {
  try {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...record }) + "\n", "utf8");
  } catch {
    return;
  }
  try {
    let lines = logLines.get(file);
    if (lines === undefined) {
      lines = fs.readFileSync(file, "utf8").split("\n").filter((x) => x.length > 0).length;
    } else {
      lines += 1;
    }
    if (lines > maxLines) {
      // 默认上限 4000 > KEEP_LINES 2000：裁剪后留 2000 行。
      // 若用户把 logMaxLines 调到 2000 以下，就按 logMaxLines 留，否则文件会无限长。
      const keep = Math.min(KEEP_LINES, Math.max(1, maxLines));
      const all = fs.readFileSync(file, "utf8").split("\n").filter((x) => x.length > 0);
      const kept = all.slice(-keep);
      fs.writeFileSync(file, kept.join("\n") + "\n", "utf8");
      lines = kept.length;
    }
    logLines.set(file, lines);
  } catch {
    logLines.delete(file);
  }
}

let vendorModule = null;

/**
 * 懒加载 vendor/identity.js（同一进程只 import 一次）。
 * @returns {Promise<object>} identity.js 的模块命名空间。
 */
export async function loadVendor() {
  if (vendorModule) return vendorModule;
  vendorModule = await import(pathToFileURL(path.join(VENDOR_DIR, "identity.js")).href);
  return vendorModule;
}

/** 从 assembly 里取 section 名列表。 */
function sectionNames(a) {
  return Array.isArray(a?.sections) ? a.sections.map((s) => s?.name) : [];
}

/**
 * 造一个挂在 `system-prompt/assemble` 上的 handler。
 * @param {object} rawConfig 原始配置（会自动补默认值）。
 * @returns {(assembly: object, context: object, next?: Function) => Promise<object>} 瀑布 handler。
 */
export function createHandler(rawConfig, runtimeOpts) {
  const cfg = normalizeConfig(rawConfig);
  const paths = resolvePaths(cfg);
  // 进程级工作区根（宿主 sandboxPolicy 服务给出）。会话级 cwd 取不到时用它兜底：
  // 桌面端一个进程只服务一个工作区，所以它等价于"用户当前打开的工作区"。
  const procWorkspaceRoot = normalizePath(runtimeOpts && runtimeOpts.workspaceRoot) || null;
  // 进程内计数：控制台读它拿"本进程装配了多少轮"，跨重启的聚合数从日志重算。
  const stats = {
    assemblies: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    startedAt: Date.now(),
    last: null,
    lastError: null,
    // 最近一次装配的会话 id 与工作目录：控制台用它做"一键把当前工作区/会话排除"。
    lastSessionId: null,
    lastCwd: null,
    lastReason: null,
    // 本进程见过的会话：sid -> {first,last,count,applied,profile,cwd}，只留最近 50 个。
    sessionSeen: Object.create(null),
    seenCount: 0,
  };
  const touchSession = (sid, t, applied, profile, cwd, layers) => {
    if (!sid) return;
    const k = String(sid);
    const s = stats.sessionSeen[k]
      || (stats.sessionSeen[k] = { first: null, last: null, count: 0, applied: 0, profile: null, cwd: null, l1: null, l2: null, mode: null });
    if (!s.first) {
      s.first = t;
      stats.seenCount += 1;
    }
    s.last = t;
    s.count += 1;
    s.applied += applied ? 1 : 0;
    s.profile = profile ?? s.profile;
    s.cwd = cwd ?? s.cwd;
    if (layers) {
      s.l1 = layers.l1 ?? s.l1;
      s.l2 = layers.l2 ?? s.l2;
      s.mode = layers.mode ?? s.mode;
    }
    stats.lastSessionId = k;
    if (stats.seenCount > 50) {
      let oldestKey = null;
      let oldestT = "";
      for (const key of Object.keys(stats.sessionSeen)) {
        const v = stats.sessionSeen[key];
        if (oldestKey === null || String(v.last) < oldestT) {
          oldestKey = key;
          oldestT = String(v.last);
        }
      }
      if (oldestKey !== null) {
        delete stats.sessionSeen[oldestKey];
        stats.seenCount -= 1;
      }
    }
  };
  const log = (record) => {
    if (record && record.ev === "assemble") {
      stats.assemblies += 1;
      if (record.applied === true) {
        stats.applied += 1;
      } else {
        stats.skipped += 1;
        if (record.reason === "error") stats.errors += 1;
      }
      stats.last = {
        t: new Date().toISOString(),
        applied: record.applied === true,
        reason: record.reason ?? null,
        inSections: record.inSections ?? null,
        outSections: record.outSections ?? null,
        ms: record.ms ?? null,
        sessionId: record.sessionId ?? null,
        sessionCwd: record.sessionCwd ?? null,
        profile: record.profile ?? null,
        workspaceL1: record.workspaceL1 ?? null,
        workspaceL2: record.workspaceL2 ?? null,
        workspaceMode: record.workspaceMode ?? null,
      };
      if (record.sessionCwd) stats.lastCwd = record.sessionCwd;
      stats.lastReason = record.reason ?? (record.applied === true ? "applied" : null);
      touchSession(record.sessionId, stats.last.t, record.applied === true, record.profile ?? null, record.sessionCwd ?? null, {
        l1: record.workspaceL1 ?? null,
        l2: record.workspaceL2 ?? null,
        mode: record.workspaceMode ?? null,
      });
      if (record.reason === "error") {
        stats.lastError = { t: stats.last.t, message: record.message ?? null };
      }
    }
    appendLog(paths.logFile, record, cfg.logMaxLines);
  };
  let firstAssemble = true;
  // 流水线（含用户阶段）只建一次：阶段文件的 import 与排序不该每轮重做。
  let pipelinePromise = null;
  const getPipeline = () => {
    if (!pipelinePromise) pipelinePromise = createPipeline(cfg, paths, log);
    return pipelinePromise;
  };

  const handler = async function handler(assembly, context, next) {
    // 先走下一环：不调用 next() 会让瀑布后面的 handler 全部被跳过，
    // 那样 enabled=false 就等于把别人的 prompt 段也一起吞了（见 _build_report.md）。
    let a = assembly;
    if (typeof next === "function") {
      try {
        a = await next();
      } catch (err) {
        log({ ev: "waterfall", message: String((err && err.message) || err) });
        a = assembly;
      }
    }

    const inNames = sectionNames(a);
    const base = { ev: "assemble", inSections: inNames.length, inHead: inNames[0] ?? null };

    // 进程内第一次装配时把真实 section 名与"哪些段会被判成工作区基线"记一次，
    // 用来在真机上确认 dropWorkspaceBaseline 到底有没有命中（宿主段名无法离线推断）。
    if (firstAssemble) {
      firstAssemble = false;
      try {
        const mod = await loadVendor();
        const list = Array.isArray(a?.sections) ? a.sections : [];
        base.inNames = inNames.slice(0, 64);
        base.baselineHits = list.filter((s) => mod.isWorkspaceBaselineSection(s)).map((s) => s?.name);
      } catch {
        /* 只为诊断，失败不影响注入 */
      }
    }

    if (cfg.enabled === false) {
      log({ ...base, applied: false, reason: "disabled" });
      return a;
    }
    try {
      if (fs.existsSync(paths.offFlag)) {
        log({ ...base, applied: false, reason: "off-flag" });
        return a;
      }
    } catch {
      /* offFlag 判断失败当作未命中，继续注入 */
    }

    // ---- 运行时状态：注入版本 + 排除名单（存在 state 文件里，改完即时生效，不用重启）----
    // 会话 id 来自瀑布 context（宿主 assembleContextFor 传 { agent, scope: agent }，
    // 而 agent.session.id === agent id）。cwd 来自 session.cwd —— 它跨对话不变，
    // 所以"某个工作区不注入"用目录排除，比逐个登记会话稳。默认全注入，只做减法。
    const state = readState(paths.home);
    const sid = getSessionId(context);
    const sessionCwd = getSessionCwd(context);
    const cwd = sessionCwd ?? procWorkspaceRoot;
    const cwdSource = sessionCwd ? "session" : procWorkspaceRoot ? "sandboxPolicy" : "none";
    const decision = sessionDecision(state, sid, cwd);
    if (!decision.inject) {
      log({ ...base, applied: false, reason: decision.reason, sessionId: sid ?? undefined, sessionCwd: cwd ?? undefined, profile: state.activeProfile });
      return a;
    }
    // 两级：L1 = activeProfile（可被工作区规则换成别的预设），L2 = 命中的工作区预设。
    // 没命中工作区规则时 composeInjectText 与旧版逐字等价——这是向后兼容的保证。
    const profile = state.activeProfile;
    // 两级作用域：目录规则 + 默认第二层兜底（逻辑在 state.resolveScope，可单测）。
    // 第一级永远有值（activeProfile），所以"两级同时为空"只可能出现在
    // 默认第二层也没设、且第一层正文被清空的情况下——那时下面 no-inject-text
    // 分支会放弃注入，退回宿主的原生提示词。
    const scope = resolveScope(state, cwd);
    const composed = composeInjectText(paths, cfg, profile, scope);
    const { text, source } = composed;
    if (!text) {
      log({
        ...base,
        applied: false,
        reason: "no-inject-text",
        injectSource: source,
        profile: profile,
        workspaceL1: scope?.l1 || undefined,
        workspaceL2: scope?.l2 || undefined,
        sessionId: sid ?? undefined,
      });
      return a;
    }
    const cut = truncateBytes(text, cfg.maxInjectBytes);

    try {
      const mod = await loadVendor();
      const pipe = await getPipeline();
      const res = await pipe.run(a, { context, cfg, paths, injectText: cut.text, mod, log });
      const outNames = sectionNames(res.assembly);
      log({
        ...base,
        applied: true,
        injectSource: source,
        profile,
        workspaceL1: scope?.l1 || undefined,
        workspaceL2: scope?.l2 || undefined,
        workspaceMode: scope?.mode ?? undefined,
        layers: composed.layers.length > 1 ? composed.layers : undefined,
        sessionId: sid ?? undefined,
        sessionCwd: cwd ?? undefined,
        injectBytes: cut.text.length,
        injectTruncated: cut.truncated || undefined,
        stages: pipe.stages.length,
        stageErrors: res.errors.length ? res.errors : undefined,
        outSections: outNames.length,
        outHead: outNames[0] ?? null,
        dropped: inNames.filter((n) => !outNames.includes(n)),
        outBytes: JSON.stringify(res.assembly?.sections ?? []).length,
        ms: cfg.perf ? res.ms : undefined,
      });
      return res.assembly;
    } catch (err) {
      log({
        ...base,
        applied: false,
        reason: "error",
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || "").slice(0, 800),
      });
      return a;
    }
  };

  // ---- 给控制台（lib/console.js）用的只读/清理钩子 ----
  handler.stats = stats;
  handler.cfg = cfg;
  handler.paths = paths;
  // 进程级工作区根：控制台用它做"把当前工作区加入排除"的一键填充（会话级 cwd 常为空）。
  handler.procWorkspaceRoot = procWorkspaceRoot;
  handler.getPipeline = getPipeline;
  /** 丢掉已建流水线，下次装配按当前配置重建（改完阶段文件后用）。 */
  handler.resetPipeline = () => {
    pipelinePromise = null;
  };
  /** 清注入正文与日志行数缓存，强制重新读盘。 */
  handler.clearCaches = () => {
    injectCache.delete(paths.injectFile);
    injectCache.delete(ASSET_INJECT);
    logLines.delete(paths.logFile);
  };
  /** 探测"下一轮会用哪份正文、多大"，不产生副作用（不走缓存，读一次盘）。 */
  handler.probeInject = async () => {
    const st = readState(paths.home);
    const file = resolveProfileFile(st.activeProfile, paths);
    const { text, source } = readInjectText(file, cfg.extra, false);
    return { source, bytes: Buffer.byteLength(text, "utf8"), profile: st.activeProfile, file };
  };

  return handler;
}

/**
 * 随包分发的初始正文表（可选）。
 *
 * 装好后 profiles/ 默认为空，设置页只有 default。希望开箱就有几份可选预设时，
 * 把正文文件放进 assets/ 并在这里登记，seedProfiles() 会在加载时补齐缺失的条目。
 *
 * 登记格式 [版本名, assets 下的文件名]。
 */
const SEED_PROFILES = [
  // 本发行版为空：装好之后在设置页新建预设即可。
];

/**
 * 幂等补齐版本文件：目标已存在就跳过，源缺失也跳过，任何失败都不影响注入。
 * @param {{profilesDir: string}} paths 已解析路径。
 * @returns {string[]} 本次真正补出来的版本名。
 */
export function seedProfiles(paths) {
  const done = [];
  // 缺失/写失败的版本名挂在返回数组上（done.missing），调用方写进 apply 日志。
  // 源文件缺失会静默跳过，界面少几份预设却查不出原因，所以把缺的名字带回去写进日志。
  const missing = [];
  for (const [name, src] of SEED_PROFILES) {
    try {
      const target = path.join(paths.profilesDir, `${name}.md`);
      if (fs.existsSync(target)) continue;
      const from = path.join(PKG_ROOT, "assets", src);
      if (!fs.existsSync(from)) {
        missing.push(name + "←assets/" + src);
        continue;
      }
      writeProfile(name, paths, fs.readFileSync(from, "utf8"));
      done.push(name);
    } catch (e) {
      missing.push(name + "←" + String((e && e.message) || e));
    }
  }
  done.missing = missing;
  return done;
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const paths = resolvePaths(cfg);
  // 版本目录先备好，再把包内存量正文补成正式版本（幂等；失败不阻断加载）
  let seededProfiles = [];
  try {
    fs.mkdirSync(paths.profilesDir, { recursive: true });
    seededProfiles = seedProfiles(paths);
  } catch {
    seededProfiles = [];
  }
  for (const file of [paths.logFile, paths.injectFile, paths.offFlag]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* 目录建不出来不阻断加载，后续写日志会静默失败 */
    }
  }
  // 进程级工作区根：`ctx.get()` 取服务不触发 cordis 的 inject 断言，取不到就是 undefined，不会崩。
  // （早期曾用 `agent.ctx.sandboxPolicy` 直读，抛 `cannot get property "sandboxPolicy" without inject`，
  //   把整个回合打挂——那条路已废弃，只留这条。）
  let spPolicy = null;
  try {
    if (typeof ctx.get === "function") spPolicy = ctx.get("sandboxPolicy");
  } catch {
    spPolicy = null;
  }
  const procRoot = normalizePath(safeGet(spPolicy, "workspaceRoot")) || null;
  const handler = createHandler(cfg, { workspaceRoot: procRoot });
  let registered = "plain";
  try {
    ctx.on("system-prompt/assemble", handler, { global: true, prepend: true });
    registered = "global+prepend";
  } catch {
    ctx.on("system-prompt/assemble", handler);
  }

  // 控制台（宿主 HTTP 路由 + WebUI 面板）。webServer 不在时静默跳过，不影响注入。
  let consoleRegistered = false;
  let consoleError = null;
  try {
    consoleRegistered = registerConsole(ctx, { cfg, paths, handler, registered, assetPath: ASSET_INJECT });
  } catch (e) {
    consoleRegistered = false;
    consoleError = String((e && e.message) || e);
  }
  // 注册失败时把探测经过写进 apply 日志，免得上线后只能靠猜（webServer 通过 get/属性哪条路拿到）。
  const consoleDiag = registerConsole.diagnose ?? null;
  const consoleNote = consoleRegistered
    ? `ok:${consoleDiag?.via ?? "unknown"}`
    : `fail:${consoleError ?? consoleDiag?.error ?? "no-webServer"}`;

  appendLog(
    paths.logFile,
    {
      ev: "apply",
      enabled: cfg.enabled,
      registered,
      console: consoleRegistered,
      consoleNote,
      injectFile: paths.injectFile,
      offFlag: paths.offFlag,
      logFile: paths.logFile,
      dropWorkspaceBaseline: cfg.dropWorkspaceBaseline,
      dropMnemon: cfg.dropMnemon,
      workspaceRoot: procRoot ?? undefined,
      seededProfiles: seededProfiles.length > 0 ? seededProfiles : undefined,
      seedMissing: seededProfiles.missing?.length > 0 ? seededProfiles.missing : undefined,
    },
    cfg.logMaxLines,
  );
}
