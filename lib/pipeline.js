/**
 * pipeline.js —— 阶段（stage）流水线：本插件唯一的扩展点。
 *
 * 设计目标：以后要改行为、改性能、加后处理，都**不用改包内代码**，只需
 *   1) 在 stagesDir 里丢一个 .mjs 文件；或
 *   2) 改一个配置项（见 lib/index.js 的 Config）。
 *
 * 稳定契约（改这些要升 FRAME_API）：
 *   - createPipeline(cfg, paths, log) -> { run(assembly, info), stages }
 *   - stage 形状：{ name: string, order?: number, transform(assembly, info) }
 *     transform 返回对象 = 用返回值继续；返回 null/undefined = 不改。
 *   - FRAME_API 版本号。
 *
 * @module dsh-prompt-frame/lib/pipeline
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 流水线契约版本。stage 形状或 createPipeline 签名变化时必须 +1。 */
export const FRAME_API = 1;

/** 上游 vendor/identity.js 给注入段用的字面 section 名（不改名，避免行为漂移）。 */
export const VENDOR_INJECT_NAME = "dsh-purge";

/** 本插件的名字，仅用于日志与文档；注入段的真实名字见 VENDOR_INJECT_NAME。 */
export const FRAME_SECTION_NAME = "dsh-prompt-frame";

/** 内建阶段 order：<100 在改写前，>=100 在改写后。 */
export const ORDER = {
  identityRewrite: 100,
  sectionFilter: 150,
  userStage: 500,
};

/** 毫秒计时，返回保留两位小数的数字。 */
export function nowMs(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
}

/**
 * 按字节上限截断文本（不切断 UTF-8 码点）。
 * @param {string} text 原文。
 * @param {number} maxBytes 0 或负数表示不限。
 * @returns {{text: string, truncated: boolean, bytes: number}} 结果。
 */
export function truncateBytes(text, maxBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (!maxBytes || maxBytes <= 0 || bytes <= maxBytes) return { text, truncated: false, bytes };
  const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // 去掉尾部被切坏的半个码点：最多回退 3 字节，直到能解码且不产生替换符。
  let cut = buf.length;
  for (let i = 0; i < 4 && cut > 0; i += 1) {
    const tail = buf.subarray(0, cut).toString("utf8");
    if (!tail.endsWith("\uFFFD")) return { text: tail, truncated: true, bytes };
    cut -= 1;
  }
  return { text: buf.toString("utf8"), truncated: true, bytes };
}

/** 取 section 名列表。 */
export function sectionNames(a) {
  return Array.isArray(a?.sections) ? a.sections.map((s) => (s ? s.name : null)) : [];
}

/**
 * 内建阶段 1：整段改写（调用 vendor/identity.js）。
 * 这里只做"包装"，改写逻辑本身一个字都没改，保证与实验期行为一致。
 */
const identityRewriteStage = {
  name: "identity-rewrite",
  order: ORDER.identityRewrite,
  async transform(assembly, info) {
    const mod = info.mod;
    if (!mod || typeof mod.rewritePromptAssembly !== "function") {
      throw new Error("vendor/identity.js missing rewritePromptAssembly");
    }
    const out = mod.rewritePromptAssembly(assembly, {
      fallbackInject: info.injectText,
      dropMnemon: info.cfg.dropMnemon,
      dropWorkspaceBaseline: info.cfg.dropWorkspaceBaseline,
      // 下面三项显式传配置值，不用 vendor 默认值，
      // 否则输出会多一个 dshpg-capabilities 段、注入段也会被折进 persona
      // ——那是没验证过的行为，不能默认开。
      capabilityProtocol: info.cfg.capabilityProtocol,
      dropPurgeAfterFold: info.cfg.dropPurgeAfterFold,
      roleText: info.cfg.roleText,
      context: info.context,
    });
    // 记下改写后置顶的那一段叫什么（上游固定叫 dsh-purge），
    // 让后面的 section-filter 知道"注入段"是哪一段、不能误删。
    const head = sectionNames(out)[0];
    if (head) info.state.injectSectionName = head;
    return out;
  },
};

/**
 * 内建阶段 2：按 section 名精确增删。
 * 默认配置下两个列表都为空 → 直接返回 null（不改），零开销。
 * keep 语义：非空时只保留列出的段（注入段永远保留），比布尔开关更细。
 */
const sectionFilterStage = {
  name: "section-filter",
  order: ORDER.sectionFilter,
  transform(assembly, info) {
    const drop = new Set(info.cfg.dropSections || []);
    const keep = info.cfg.keepSections || [];
    if (drop.size === 0 && keep.length === 0) return null;
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
    const keepSet = new Set(keep);
    const injected = info.state?.injectSectionName || VENDOR_INJECT_NAME;
    const out = sections.filter((s) => {
      const n = s ? s.name : null;
      if (n === injected || n === FRAME_SECTION_NAME) return true;
      if (drop.has(n)) return false;
      if (keepSet.size > 0 && !keepSet.has(n)) return false;
      return true;
    });
    return { ...assembly, sections: out };
  },
};

/**
 * 从目录扫描用户阶段。
 * 支持两种导出：`export default { name, order, transform }` 或 `export const stage = {...}`。
 * 单个文件坏掉只跳过它自己。
 * @param {string} dir 目录，空串表示不扫描。
 * @param {(record: object) => void} log 日志函数。
 * @returns {Promise<object[]>} 阶段数组。
 */
export async function loadUserStages(dir, log) {
  if (!dir) return [];
  let entries;
  try {
    if (!fs.existsSync(dir)) return [];
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  } catch (err) {
    log({ ev: "stages-dir-error", dir, message: String((err && err.message) || err) });
    return [];
  }
  const out = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const mod = await import(pathToFileURL(full).href);
      const stage = mod.stage || mod.default;
      if (!stage || typeof stage.transform !== "function") {
        log({ ev: "stage-invalid", file, message: "no transform()" });
        continue;
      }
      const order = Number.isFinite(stage.order) ? stage.order : ORDER.userStage;
      out.push({ name: String(stage.name || file.replace(/\.mjs$/, "")), order, transform: stage.transform, file });
    } catch (err) {
      log({ ev: "stage-load-error", file, message: String((err && err.message) || err) });
    }
  }
  return out;
}

/**
 * 造流水线。内建阶段 + 用户阶段按 order 升序、同 order 按 name 字典序。
 * @param {object} cfg 归一化配置。
 * @param {object} paths 已解析路径（供 info 用）。
 * @param {(record: object) => void} log 日志函数。
 * @returns {Promise<{stages: object[], run: Function}>} 流水线。
 */
export async function createPipeline(cfg, paths, log) {
  const disabled = new Set(cfg.disabledStages || []);
  const user = await loadUserStages(cfg.stagesDir, log);
  const all = [identityRewriteStage, sectionFilterStage, ...user].filter((s) => !disabled.has(s.name));
  all.sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name)));

  /**
   * 跑流水线。任何阶段抛错只跳过它自己并记 stage-error。
   * @param {object} assembly 宿主装配结果。
   * @param {object} info { context, cfg, paths, injectText, mod, log }
   * @returns {Promise<{assembly: object, errors: object[], ms: number}>} 结果。
   */
  async function run(assembly, info) {
    const start = process.hrtime.bigint();
    let current = assembly;
    const errors = [];
    // state 在同一次装配的所有阶段之间共享（例如注入段名），不跨轮次。
    const ctxInfo = { ...info, state: {} };
    for (const stage of all) {
      try {
        const next = await stage.transform(current, ctxInfo);
        if (next && typeof next === "object") current = next;
      } catch (err) {
        errors.push({ stage: stage.name, message: String((err && err.message) || err) });
        log({ ev: "stage-error", stage: stage.name, message: String((err && err.message) || err) });
      }
    }
    return { assembly: current, errors, ms: nowMs(start) };
  }

  return { stages: all, run };
}
