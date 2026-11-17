/**
 * state.js —— 运行时状态（版本选择 + 按会话开关），独立于 schemastery 配置。
 *
 * 为什么不放进 Config：schemastery 的 Config 是**启动时**读的，改它要重启或
 * 走宿主设置通道；而"这个会话别注入"必须当场生效。所以运行时可变的两个旋钮
 * 存在 $DSH_HOME/dsh-prompt-frame-state.json，每次装配热读（按 mtime+size 缓存）。
 *
 * 状态文件形状（只有排除名单，没有模式开关）：
 * {
 *   "activeProfile": "default",              // 注入正文版本名；default = Config.injectFile
 *   "excludeSessions": ["<sessionId>"],      // 这些会话不注入
 *   "excludePaths": ["E:\\some-workspace"],  // 这些工作目录（含子目录）不注入
 *   "updatedAt": "2026-...Z"
 * }
 *
 * 语义：**默认全注入，只做减法**。任一名单命中就不注入，所以新开会话、新换目录
 * 都不必重新登记，只有"想让模型恢复原样能力"的地方才需要显式排除。
 * 会话 id 每开一个新对话就变，稳定性差；工作目录（cwd）跨会话不变，是主用旋钮。
 *
 * @module dsh-prompt-frame/lib/state
 */
import fs from "node:fs";
import path from "node:path";

/** 状态文件里的默认值（文件缺失/损坏时用它）。 */
export const DEFAULT_STATE = {
  activeProfile: "default",
  excludeSessions: [],
  excludePaths: [],
  // 工作区层（v1）：按 cwd 前缀命中后叠加到全局层之上。
  // 形状 [{ path: "E:\\ws", profile: "comfy", mode: "append" | "replace" }]
  pathProfiles: [],
  // 默认第二级（v2）：没有任何工作区规则命中时，拿它当第二层正文。
  // 空串 = 不设默认，这类对话就只有第一层。第一级与默认第二级不能同时为空，
  // 否则装配出来的正文是空串，连原生提示词都不如（装配层会直接放弃注入）。
  defaultL2: "",
  updatedAt: null,
};

/** 工作区层允许的叠加方式。append = 全局层 + 工作区层；replace = 只用工作区层。 */
export const LAYER_MODES = ["append", "replace"];

/** profile 名只允许这些字符，避免 `../` 之类的路径穿越。 */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 第二层预设的文件名前缀。
 *
 * 为什么需要命名空间：第一层和第二层是两套独立预设，用户完全可能两层都想要
 * 一个叫 "1" 的预设。若两层共用一个文件名空间，先在第一层建了 "1"，第二层就
 * 再也建不出同名的（`1.md` 已存在）。加前缀后两层的名字互不挤占。
 */
export const L2_PREFIX = "l2~";

/**
 * 预设的层级标记文件（位于 profilesDir 下）。
 *
 * 为什么单独一个文件、不塞进 state.json：state.json 是私有版与开源版**共用**的，
 * 往里面加字段会被更老的版本在 normalizeState 里丢掉；而"这份正文属于第一层
 * 还是第二层"是纯界面分类，不该影响注入语义。放这里两边都不打架。
 *
 * 形状 { "<预设名>": "l1" | "l2" }。没记录的预设视为 l1（历史预设都是全局正文）。
 */
const LEVELS_FILE = "presets.json";

/** 旧版（1.3.x）模式名，仅用于迁移识别。 */
const LEGACY_BLACKLIST = "blacklist";

/**
 * 状态文件路径。
 * @param {string} home DSH 主目录。
 * @returns {string} 绝对路径。
 */
export function statePath(home) {
  return path.join(home, "dsh-prompt-frame-state.json");
}

/**
 * 版本正文目录。
 * @param {string} home DSH 主目录。
 * @returns {string} 绝对路径。
 */
export function profilesDirOf(home) {
  return path.join(home, "dsh-prompt-frame", "profiles");
}

/** 状态缓存：file -> { mtimeMs, size, value }。 */
const cache = new Map();

/**
 * 规范目录写法：统一反斜杠、去尾分隔符、盘符补根。保留大小写便于页面显示。
 * @param {unknown} p 原始路径。
 * @returns {string} 规范路径；空输入返回空串。
 */
export function normalizePath(p) {
  let s = String(p ?? "").trim();
  if (s === "") return "";
  // 用户常把 JSON 里的值连引号一起粘过来（"E:\\dsh\\x"），或从命令行带了单引号。
  // 剥离成对/单边的引号与反引号，否则规则永远匹配不到真实 cwd（实际踩过的故障）。
  s = s.replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();
  if (s === "") return "";
  s = s.replace(/\//g, "\\").replace(/\\+$/, "");
  if (s === "") return "";
  if (/^[A-Za-z]:$/.test(s)) s += "\\";
  return s;
}

/**
 * 目录规则是否覆盖某个工作目录：相等或以"规则 + 分隔符"开头。
 * Windows 下路径大小写不敏感，比较时统一转小写。
 * @param {string} rule 规则目录。
 * @param {string} cwd 会话工作目录。
 * @returns {boolean} 是否命中。
 */
export function pathCovers(rule, cwd) {
  const r = normalizePath(rule);
  const c = normalizePath(cwd);
  if (r === "" || c === "") return false;
  const win = process.platform === "win32";
  const lr = win ? r.toLowerCase() : r;
  const lc = win ? c.toLowerCase() : c;
  if (lc === lr) return true;
  return lc.startsWith(lr.endsWith("\\") ? lr : `${lr}\\`);
}

/**
 * 把任意输入归一化成合法状态。
 * 兼容 1.3.x：旧 `sessionMode: "blacklist"` + `sessions` 迁成 `excludeSessions`；
 * 旧 `whitelist`（只注入名单内）无法用"只做减法"表达，按空排除表处理并丢弃名单。
 * @param {unknown} raw 读到的原始对象。
 * @returns {object} 完整状态。
 */
export function normalizeState(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const profile = typeof o.activeProfile === "string" && PROFILE_NAME.test(o.activeProfile)
    ? o.activeProfile
    : DEFAULT_STATE.activeProfile;
  const legacy = Array.isArray(o.sessions)
    ? o.sessions.map((x) => String(x).trim()).filter((x) => x.length > 0)
    : [];
  const seedSessions = Array.isArray(o.excludeSessions)
    ? o.excludeSessions
    : o.sessionMode === LEGACY_BLACKLIST
      ? legacy
      : [];
  const excludeSessions = [...new Set(seedSessions.map((x) => String(x).trim()).filter((x) => x.length > 0))];
  const excludePaths = o.excludePaths === undefined
    ? []
    : [...new Set((Array.isArray(o.excludePaths) ? o.excludePaths : [])
      .map(normalizePath)
      .filter((x) => x.length > 0))];
  // 工作区层：非法条目直接丢弃（cwd 为空、profile 名非法、mode 不认识），
  // 宁可少注入一层，也不要把半截规则带进装配。
  const seen = new Set();
  const pathProfiles = [];
  for (const raw of Array.isArray(o.pathProfiles) ? o.pathProfiles : []) {
    if (!raw || typeof raw !== "object") continue;
    const dir = normalizePath(raw.path);
    if (dir === "") continue;
    // 两级制：l1 = 第一级（全局层）显式指定用哪个预设，空串表示"跟随全局
    // activeProfile"；l2 = 第二级（工作区层）的预设，空串表示这一级没有内容。
    // 老条目只有 profile 字段，按第二级读入，语义与"只配工作区预设"的旧行为一致。
    const l1 = typeof raw.l1 === "string" ? raw.l1.trim() : "";
    const l2 = typeof raw.l2 === "string"
      ? raw.l2.trim()
      : typeof raw.profile === "string" ? raw.profile.trim() : "";
    if (l1 !== "" && !PROFILE_NAME.test(l1)) continue;
    if (l2 !== "" && !PROFILE_NAME.test(l2)) continue;
    if (l1 === "" && l2 === "") continue;
    const mode = raw.mode === "replace" ? "replace" : "append";
    const key = `${dir.toLowerCase()}|${l1}|${l2}|${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pathProfiles.push({ path: dir, l1, l2, mode });
  }

  const defaultL2 = typeof o.defaultL2 === "string" && PROFILE_NAME.test(o.defaultL2.trim())
    ? o.defaultL2.trim()
    : "";
  return {
    activeProfile: profile,
    defaultL2,
    excludeSessions,
    excludePaths,
    pathProfiles,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
  };
}

/**
 * 读状态（带 mtime+size 缓存，文件不变就不重复解析）。
 * @param {string} home DSH 主目录。
 * @returns {object} 归一化后的状态；文件缺失或损坏时返回默认值。
 */
export function readState(home) {
  const file = statePath(home);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(file);
    return { ...DEFAULT_STATE };
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value;
  try {
    value = normalizeState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    value = { ...DEFAULT_STATE };
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/**
 * 原子写状态：先写 .tmp 再 rename，避免读到写了一半的 JSON。
 * @param {string} home DSH 主目录。
 * @param {object} patch 要合并进当前状态的字段。
 * @returns {object} 写入后的状态。
 */
export function writeState(home, patch) {
  const cur = readState(home);
  const next = normalizeState({
    ...cur,
    ...(patch && typeof patch === "object" ? patch : {}),
    updatedAt: new Date().toISOString(),
  });
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  cache.delete(file);
  return next;
}

/**
 * profile 名 → 正文文件路径。
 * `default` 指向 Config.injectFile（保持旧行为），其余指向 profiles 目录。
 * @param {string} name profile 名。
 * @param {{injectFile: string, profilesDir: string}} paths 已解析路径。
 * @returns {string} 绝对路径。
 */
export function resolveProfileFile(name, paths, level) {
  const n = typeof name === "string" && PROFILE_NAME.test(name) ? name : "default";
  if (n === "" || n === "default") return paths.injectFile;
  const lv = level === "l2" || (level === undefined && readPresetLevels(paths)[n] === "l2") ? "l2" : "l1";
  if (lv === "l2") {
    const prefixed = path.join(paths.profilesDir, `${L2_PREFIX}${n}.md`);
    // 老数据：层级标记写着 l2 但文件名没前缀（早期版本）。继续用老文件，
    // 否则用户打开一个已有正文的第二层预设会看到空白。
    if (fs.existsSync(prefixed)) return prefixed;
    const legacy = path.join(paths.profilesDir, `${n}.md`);
    return fs.existsSync(legacy) ? legacy : prefixed;
  }
  return path.join(paths.profilesDir, `${n}.md`);
}

/**
 * 读预设层级标记。文件缺失/损坏一律返回 {}，调用方按"没标记 = l1"处理。
 * @param {{profilesDir: string}} paths 已解析路径。
 * @returns {Record<string, "l1"|"l2">} 预设名 → 层级。
 */
export function readPresetLevels(paths) {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(paths.profilesDir, LEVELS_FILE), "utf8");
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj || {})) {
      if (PROFILE_NAME.test(k) && (v === "l1" || v === "l2")) out[k] = v;
    }
  } catch {
    /* 没有标注文件是正常状态（全新安装） */
  }
  return out;
}

/**
 * 写一个预设的层级标记；level 为空表示清掉标记（删除预设时调用）。
 * @param {string} name 预设名。
 * @param {"l1"|"l2"|""} level 层级。
 * @param {{profilesDir: string}} paths 已解析路径。
 * @returns {Record<string, "l1"|"l2">} 写后的完整映射。
 */
export function writePresetLevel(name, level, paths) {
  const cur = readPresetLevels(paths);
  if (PROFILE_NAME.test(String(name)) && (level === "l1" || level === "l2")) cur[name] = level;
  else delete cur[name];
  try {
    fs.mkdirSync(paths.profilesDir, { recursive: true });
    fs.writeFileSync(path.join(paths.profilesDir, LEVELS_FILE), JSON.stringify(cur, null, 2) + "\n");
  } catch {
    /* 写失败不影响正文写入；层级只是界面分类 */
  }
  return cur;
}

/**
 * 列出可用版本：`default` 永远在，其余是 profiles 目录下的 *.md。
 * @param {{injectFile: string, profilesDir: string}} paths 已解析路径。
 * @returns {Array<{name: string, bytes: number, mtime: string|null, path: string}>} 版本清单。
 */
export function listProfiles(paths) {
  const out = [];
  const stamp = (file) => {
    try {
      const s = fs.statSync(file);
      return { bytes: s.size, mtime: s.mtime.toISOString() };
    } catch {
      return { bytes: 0, mtime: null };
    }
  };
  const levels = readPresetLevels(paths);
  out.push({ name: "default", ...stamp(paths.injectFile), path: paths.injectFile, level: levels.default || "l1" });
  let names = [];
  try {
    names = fs.readdirSync(paths.profilesDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  } catch {
    names = [];
  }
  for (const raw of names.sort()) {
    // 前缀是第二层的命名空间：l2~1.md 的预设名是 "1"，层级固定 l2。
    // 两层可以各有一个叫 "1" 的预设，页面靠 level 分开显示。
    const isL2 = raw.startsWith(L2_PREFIX);
    const name = isL2 ? raw.slice(L2_PREFIX.length) : raw;
    if (!PROFILE_NAME.test(name)) continue;
    const file = path.join(paths.profilesDir, `${raw}.md`);
    out.push({ name, isL2, ...stamp(file), path: file, level: isL2 ? "l2" : levels[name] || "l1" });
  }
  return out;
}

/**
 * 读某个版本的正文。
 * @param {string} name profile 名。
 * @param {{injectFile: string, profilesDir: string}} paths 已解析路径。
 * @returns {{text: string, file: string, exists: boolean}} 正文与来源。
 */
export function readProfile(name, paths, level) {
  const file = resolveProfileFile(name, paths, level);
  try {
    return { text: fs.readFileSync(file, "utf8"), file, exists: true };
  } catch {
    return { text: "", file, exists: false };
  }
}

/**
 * 写某个版本的正文（新建即创建）。
 * @param {string} name profile 名。
 * @param {{injectFile: string, profilesDir: string}} paths 已解析路径。
 * @param {string} text 正文。
 * @returns {{file: string, bytes: number}} 写入结果。
 */
export function writeProfile(name, paths, text, level) {
  // 写路径必须直拼，不能走 resolveProfileFile：后者对第二层有"没有前缀文件就回落
  // 到同名老文件"的兼容回落，用在写操作上会把已经存在的第一层正文覆盖掉
  // （现象：第一层建了 1，再建第二层 1，第二层的正文写进了 1.md，第二层还没出现）。
  const n = typeof name === "string" && PROFILE_NAME.test(name) ? name : "default";
  let file;
  if (n === "default") {
    file = paths.injectFile;
  } else {
    const lv = level === "l2" || (level === undefined && readPresetLevels(paths)[n] === "l2") ? "l2" : "l1";
    file = lv === "l2" ? path.join(paths.profilesDir, `${L2_PREFIX}${n}.md`) : path.join(paths.profilesDir, `${n}.md`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text ?? ""), "utf8");
  return { file, bytes: Buffer.byteLength(String(text ?? ""), "utf8") };
}

/**
 * 删除一个非 default 版本。
 * @param {string} name profile 名。
 * @param {{injectFile: string, profilesDir: string}} paths 已解析路径。
 * @returns {boolean} 是否真的删掉了。
 */
export function deleteProfile(name, paths, level) {
  if (!PROFILE_NAME.test(name) || name === "default") return false;
  const lv = level === "l2" || (level === undefined && readPresetLevels(paths)[name] === "l2") ? "l2" : "l1";
  // 第二层可能同时存在带前缀的新文件与没前缀的老文件，两个都清掉，
  // 否则"删了但下拉里还在"会反复出现。
  // 第二层只删自己的文件：带前缀的一定是第二层；不带前缀的那份只有在层级标记
  // 也写着 l2（早期版本的老数据）时才算第二层，否则它是同名的第一层预设，不能动。
  const files = [];
  if (lv === "l2") {
    files.push(path.join(paths.profilesDir, `${L2_PREFIX}${name}.md`));
    const legacy = path.join(paths.profilesDir, `${name}.md`);
    if (readPresetLevels(paths)[name] === "l2" && fs.existsSync(legacy)) files.push(legacy);
  } else {
    files.push(path.join(paths.profilesDir, `${name}.md`));
  }
  let gone = false;
  for (const file of files) {
    try {
      fs.unlinkSync(file);
      gone = true;
    } catch {
      /* 不存在的那个跳过 */
    }
  }
  return gone;
}

/**
 * 从装配 context 里取会话 id。
 * 宿主 assembleContextFor() 传的是 `{ agent, scope: agent, signal? }`，
 * 而 agent.session.id === agent id（dsh-agent 的 resume 校验强制二者相同）。
 * @param {object} context 瀑布 context。
 * @returns {string|null} 会话 id；拿不到返回 null。
 */
export function getSessionId(context) {
  if (!context || typeof context !== "object") return null;
  const agent = context.agent ?? context.scope ?? null;
  if (!agent || typeof agent !== "object") return null;
  const sid = agent.session?.id ?? agent.id ?? null;
  if (typeof sid === "string" && sid.trim().length > 0) return sid.trim();
  if (typeof sid === "number" && Number.isFinite(sid)) return String(sid);
  return null;
}

/**
 * 从装配 context 里取会话工作目录（按目录排除的主依据）。
 * 宿主 `node_modules/@deepseek-ai/dsh-agent` 里 `workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot`，
 * 故 session.cwd 是会话自己的目录；取不到再退回 agent.cwd / context.cwd。
 * @param {object} context 瀑布 context。
 * @returns {string|null} 规范后的绝对路径；拿不到返回 null。
 */
/**
 * 安全读属性。**必须以它为唯一读口**：cordis 的 ctx 是 Proxy，未在 `inject` 里
 * 声明的服务一碰就抛 `cannot get property "<name>" without inject`，
 * 而这句话一旦抛在装配阶段，整个回合直接失败。曾经就踩在这里。
 * @param {unknown} obj 目标对象。
 * @param {string} key 属性名。
 * @returns {unknown} 值，读不到或抛错一律 undefined。
 */
export function safeGet(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  const t = typeof obj;
  if (t !== "object" && t !== "function") return undefined;
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

/**
 * 遍历时禁止入队的 key：这些位置挂着 cordis 的服务容器（Proxy），
 * 对它做 `Object.keys` / 属性读都可能触发 inject 断言或服务实例化。
 */
export const BLOCKED_KEYS = new Set(["ctx", "container", "registry", "services", "root", "__cordis__", "$app"]);

/**
 * 安全取 key 列表（不让 Object.keys 的异常冒出去）。
 * @param {unknown} node 目标对象。
 * @returns {string[]} 可枚举键，失败为空数组。
 */
export function safeKeys(node) {
  try {
    return Object.keys(node);
  } catch {
    return [];
  }
}

export function getSessionCwd(context) {
  if (!context || typeof context !== "object") return null;
  const agent = safeGet(context, "agent") ?? safeGet(context, "scope");
  // 只读确定是普通对象的字段。**绝不碰 agent.ctx**（那是服务容器，见 safeGet 注释）。
  const exact = [
    safeGet(safeGet(agent, "session"), "cwd"),
    safeGet(safeGet(agent, "session"), "workspaceRoot"),
    safeGet(safeGet(agent, "session"), "directory"),
    safeGet(agent, "cwd"),
    safeGet(agent, "workspaceRoot"),
    safeGet(safeGet(context, "session"), "cwd"),
    safeGet(context, "cwd"),
    safeGet(context, "workspaceRoot"),
  ];
  for (const cand of exact) {
    const s = normalizePath(cand);
    if (s !== "") return s;
  }
  // 2) 浅扫描兜底：只认 key 名像目录的字段（cwd / workspaceRoot / dir …），
  //    值必须是盘符或根开头的路径。深度 ≤ 3、节点 ≤ 200，避免碰到 ctx 那棵大树。
  return scanForCwd(context, 3);
}

/** key 名像"工作目录"的字段。 */
const CWD_KEY_RE = /^(cwd|pwd|dir|directory|workingdirectory|workspaceroot|workspace|root|folder|basedir)$/i;

/**
 * 在对象树里找第一个像工作目录的值（兜底用，仅当精确路径全部落空时执行）。
 * @param {unknown} root 起点（装配 context）。
 * @param {number} maxDepth 最大深度。
 * @returns {string|null} 规范路径或 null。
 */
export function scanForCwd(root, maxDepth = 3) {
  const seen = new WeakSet();
  const queue = [{ node: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    if (visited > 200 || depth > maxDepth) continue;
    const keys = safeKeys(node);
    for (const key of keys) {
      if (!CWD_KEY_RE.test(key)) continue;
      let value;
      try {
        value = node[key];
      } catch {
        continue;
      }
      const s = normalizePath(value);
      // 只接受绝对路径，避免把 "default" 这种东西当目录。
      if (s !== "" && /^([A-Za-z]:[\\/]|[\\/])/.test(s)) return s;
    }
    for (const key of keys) {
      if (BLOCKED_KEYS.has(key)) continue;
      let value;
      try {
        value = node[key];
      } catch {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return null;
}

/**
 * 按工作目录解析工作区层（v1）。
 *
 * 只看 pathProfiles：命中越多条，取**路径最长**的那条（最长前缀优先，规则可嵌套，
 * 子目录的专门规则盖过父目录的通用规则）。一条都没命中返回 null，调用方保持
 * 原有行为——这就是向后兼容的落点：没有 pathProfiles 时行为与"只配全局正文"完全一致。
 *
 * 注意这是**叠加**层，不是排除层：排除仍然走 excludePaths，两者互不影响。
 * @param {object} state 归一化状态。
 * @param {string|null} cwd 会话工作目录。
 * @returns {{profile: string, mode: string, rule: string}|null} 命中的工作区层。
 */
export function resolveProfileForCwd(state, cwd) {
  const list = Array.isArray(state?.pathProfiles) ? state.pathProfiles : [];
  let best = null;
  let bestLen = -1;
  for (const rule of list) {
    if (!rule || typeof rule.path !== "string") continue;
    if (!pathCovers(rule.path, cwd)) continue;
    const len = normalizePath(rule.path).length;
    if (len > bestLen) {
      bestLen = len;
      best = rule;
    }
  }
  if (!best) return null;
  return { l1: best.l1 || "", l2: best.l2 || "", mode: best.mode, rule: best.path };
}

/**
 * 会话最终用哪两级：先看目录规则，再用默认第二层兜底。
 *
 * 兜底只补第二级，不改第一级——第一级永远有值（跟随 activeProfile）。
 * 目录规则自己写了 l2 时不覆盖，用户显式选择优先。
 * @param {object} state 归一化状态。
 * @param {string|null} cwd 会话工作目录。
 * @returns {{l1: string, l2: string, mode: string, rule: string}|null} 两级作用域。
 */
export function resolveScope(state, cwd) {
  const hit = resolveProfileForCwd(state, cwd);
  const def = state && typeof state.defaultL2 === "string" ? state.defaultL2 : "";
  if (hit) {
    if (!def || hit.l2) return hit;
    return { l1: hit.l1, l2: def, mode: hit.mode, rule: hit.rule };
  }
  return def ? { l1: "", l2: def, mode: "append", rule: "default-l2" } : null;
}

/**
 * 判断某个会话要不要注入：**默认注入，命中任一排除名单才不注入**。
 * 目录排除优先于会话排除（前者更稳定，跨会话继承）。
 * @param {object} state 归一化状态。
 * @param {string|null} sid 会话 id。
 * @param {string|null} cwd 会话工作目录。
 * @returns {{inject: boolean, reason: string}} 决定与原因。
 */
export function sessionDecision(state, sid, cwd) {
  const id = typeof sid === "string" ? sid.trim() : "";
  const dir = normalizePath(cwd);
  const paths = Array.isArray(state?.excludePaths) ? state.excludePaths : [];
  for (const rule of paths) {
    if (pathCovers(rule, dir)) return { inject: false, reason: "excluded-path" };
  }
  if (id !== "" && Array.isArray(state?.excludeSessions) && state.excludeSessions.includes(id)) {
    return { inject: false, reason: "excluded-session" };
  }
  return { inject: true, reason: "default-all" };
}

/**
 * 清空状态缓存（测试用）。
 * @returns {void}
 */
export function clearStateCache() {
  cache.clear();
}
