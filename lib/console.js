/**
 * console.js —— dsh-prompt-frame 的控制台后端（宿主半）。
 *
 * 它只做一件事：把插件运行时状态暴露成同源 HTTP 接口，供 client/client.js 里的
 * 面板读取与操作。不持有任何业务逻辑，改写行为仍然全在 core-logic.js。
 *
 * 路由（挂在宿主的 webServer 上，前缀 CONSOLE_API_PREFIX）：
 *   GET  /status   状态快照：开关、路径、文件指纹、进程内计数、最近装配记录
 *   GET  /log      日志尾部（?limit=40&ev=assemble）
 *   GET  /stages   阶段列表（name / order / disabled / builtin）
 *   POST /toggle   { on: boolean } —— 写/删 OFF 标志文件，无需重启即生效
 *   POST /reload   清注入正文缓存 + 重建流水线（改完 prompt-inject.md 或阶段文件后用）
 *
 * 设计约束：
 *   - 只依赖 node: 内置模块；webServer 不可用时静默降级（插件主体不受影响）。
 *   - 所有读取都带 try/catch：一个坏日志不能让面板 500。
 *   - 写操作只碰 offFlag 一个文件，不写配置、不碰 profile。
 *
 * @module dsh-prompt-frame/lib/console
 */
import fs from "node:fs";
import path from "node:path";
import {
  readState,
  writeState,
  sessionDecision,
  listProfiles,
  resolveProfileFile,
  writeProfile,
  readProfile,
  deleteProfile,
  normalizePath,
  pathCovers,
  resolveScope,
  writePresetLevel,
  L2_PREFIX,
} from "./state.js";

/** 控制台 API 前缀。client 半必须与此一致。 */
export const CONSOLE_API_PREFIX = "/api/prompt-frame";

/** 读文件指纹；不存在时 exists=false，不抛错。 */
function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return {
      exists: true,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      mtime: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return { exists: false, bytes: 0, mtimeMs: 0, mtime: null };
  }
}

/** 数行数（空行不计）。读失败返回 0。 */
function countLines(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    let n = 0;
    for (const line of text.split("\n")) if (line.length > 0) n += 1;
    return n;
  } catch {
    return 0;
  }
}

/**
 * 读日志尾部若干条记录并解析成对象；坏行跳过。
 * @param {string} file 日志路径。
 * @param {number} limit 最多返回条数。
 * @param {string|null} evFilter 只保留 ev 等于该值的记录。
 * @returns {object[]} 按时间正序（旧→新）的记录。
 */
export function readLogTail(file, limit = 40, evFilter = null) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((x) => x.length > 0);
  // 只从头到尾解析尾部一段；日志已被 appendLog 裁到 ≤ logMaxLines，整份读可接受。
  const slice = lines.slice(-Math.max(limit * 4, limit));
  const out = [];
  for (const line of slice) {
    try {
      const rec = JSON.parse(line);
      if (evFilter && rec?.ev !== evFilter) continue;
      out.push(rec);
    } catch {
      /* 坏行忽略 */
    }
  }
  return out.slice(-limit);
}

/**
 * 从整份日志重算聚合统计（跨重启也准）：轮次、生效、跳过原因分布、错误数、最近一条。
 * @param {string} file 日志路径。
 * @returns {object} 统计结果。
 */
export function computeLogStats(file) {
  const stats = {
    assemblies: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    reasons: {},
    firstT: null,
    lastT: null,
    last: null,
    applies: 0,
  };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return stats;
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof rec?.t === "string" ? rec.t : null;
    if (t) {
      if (!stats.firstT) stats.firstT = t;
      stats.lastT = t;
    }
    if (rec?.ev === "apply") stats.applies += 1;
    if (rec?.ev !== "assemble") continue;
    stats.assemblies += 1;
    stats.last = rec;
    if (rec.applied === true) {
      stats.applied += 1;
    } else {
      stats.skipped += 1;
      const r = typeof rec.reason === "string" ? rec.reason : "unknown";
      stats.reasons[r] = (stats.reasons[r] ?? 0) + 1;
      if (r === "error") stats.errors += 1;
    }
  }
  return stats;
}

/** 能给前端看的配置子集（不含任何凭据；全是行为开关）。 */
function publicConfig(cfg) {
  return {
    enabled: cfg.enabled !== false,
    dropWorkspaceBaseline: cfg.dropWorkspaceBaseline !== false,
    dropMnemon: cfg.dropMnemon !== false,
    cacheInjectText: cfg.cacheInjectText !== false,
    perf: cfg.perf !== false,
    maxInjectBytes: cfg.maxInjectBytes ?? 0,
    logMaxLines: cfg.logMaxLines ?? 0,
    disabledStages: Array.isArray(cfg.disabledStages) ? cfg.disabledStages : [],
    dropSections: Array.isArray(cfg.dropSections) ? cfg.dropSections : [],
    keepSections: Array.isArray(cfg.keepSections) ? cfg.keepSections : [],
    capabilityProtocol: cfg.capabilityProtocol === true,
    dropPurgeAfterFold: cfg.dropPurgeAfterFold === true,
  };
}

/** 阶段列表：内建阶段 + 已加载的用户阶段。 */
async function stageList(handler) {
  const builtin = [
    { name: "identity-rewrite", order: 100, builtin: true },
    { name: "section-filter", order: 150, builtin: true },
  ];
  let stages = null;
  try {
    if (typeof handler?.getPipeline === "function") {
      const pipe = await handler.getPipeline();
      stages = Array.isArray(pipe?.stages)
        ? pipe.stages.map((s) => ({
            name: String(s?.name ?? "?"),
            order: Number(s?.order ?? 500),
            builtin: builtin.some((b) => b.name === s?.name),
          }))
        : null;
    }
  } catch {
    stages = null;
  }
  if (stages === null) {
    // 流水线还没建（宿主本轮还没装配过）：返回内建阶段，并标记未加载用户阶段。
    return { loaded: false, stages: builtin, note: "流水线尚未建立；本进程装配过一轮后可见用户阶段" };
  }
  const disabled = new Set(Array.isArray(handler?.cfg?.disabledStages) ? handler.cfg.disabledStages : []);
  for (const s of stages) s.disabled = disabled.has(s.name);
  return { loaded: true, stages };
}

/**
 * 组装一次状态快照。
 * @param {object} opts {cfg, paths, handler, registered}
 * @returns {Promise<object>} 状态对象。
 */
export async function buildStatus(opts) {
  const { cfg, paths, handler, registered } = opts;
  const injectStamp = fileStamp(paths.injectFile);
  const logStamp = fileStamp(paths.logFile);
  const offStamp = fileStamp(paths.offFlag);
  const runtime = handler?.stats && typeof handler.stats === "object" ? handler.stats : null;
  let injectSource = "none";
  let injectBytes = 0;
  try {
    if (typeof handler?.probeInject === "function") {
      const probe = await handler.probeInject();
      injectSource = probe?.source ?? "none";
      injectBytes = probe?.bytes ?? 0;
    }
  } catch {
    /* 探测失败不影响状态展示 */
  }
  const stages = await stageList(handler);
  const st = readState(paths.home);
  const profiles = listProfiles(paths);

  // HTTP 请求本身没有会话身份，状态灯只能基于"最近一次装配"的 cwd/session 反推
  // 本工作区会不会被排除。lastDecision.effective=false 时灯必须是"已排除"而不是绿色——
  // 否则会出现"目录已排除、指示灯却还是绿的"。
  // 装配记录在内存里，重启后为空 —— 此时退回宿主给的工作区根做"预判"，
  // 让状态灯在还没跑过一轮对话时就能亮，而不是一直灰着等第一次装配。
  const previewCwd = runtime?.lastCwd ? null : (handler?.procWorkspaceRoot ?? null);
  const lastCwd = runtime?.lastCwd ?? previewCwd ?? null;
  const lastSid = runtime?.lastSessionId ?? null;
  // v1 工作区层：列表要能直接看出"这个预设文件到底存不存在"。
  // 不存在的规则在注入时会被静默跳过，用户只会觉得"配了没生效"，所以这里标出来。
  // 两级：每行给出 L1（全局层覆盖，空 = 跟随 activeProfile）与 L2（工作区层）两个预设名，
  // 以及各自文件是否存在——缺正文的层在注入时会被静默跳过，用户只会觉得"配了没生效"。
  const fileStat = (name) => {
    if (!name || !paths.profilesDir) return { exists: false, bytes: 0 };
    try {
      const s = fs.statSync(path.join(paths.profilesDir, `${name}.md`));
      return { exists: true, bytes: s.size };
    } catch {
      return { exists: false, bytes: 0 };
    }
  };
  const workspaceRows = (Array.isArray(st.pathProfiles) ? st.pathProfiles : []).map((r) => {
    const l1 = r.l1 || "";
    const l2 = r.l2 || "";
    const s1 = fileStat(l1);
    const s2 = fileStat(l2);
    return {
      path: r.path,
      l1,
      l2,
      mode: r.mode,
      l1Exists: l1 ? s1.exists : true,
      l1Bytes: s1.bytes,
      l2Exists: s2.exists,
      l2Bytes: s2.bytes,
      // 兼容字段：旧前端只认 profile/exists/bytes，按第二级返回
      profile: l2,
      exists: s2.exists,
      bytes: s2.bytes,
      current: lastCwd ? pathCovers(r.path, lastCwd) : false,
    };
  });
  const globalInjecting = cfg.enabled !== false && !offStamp.exists;
  let lastDecision = null;
  if (lastCwd !== null || lastSid !== null) {
    const d = sessionDecision(st, lastSid, lastCwd);
    // 两级注入的正文名：L1 = 全局层（工作区规则可覆盖），L2 = 工作区层/默认第二层。
    // 灯背后的文字要同时给出这两级，否则用户只看到第二层，误以为第一层没生效。
    const scope = lastCwd ? resolveScope(st, lastCwd) : null;
    lastDecision = {
      cwd: lastCwd,
      sessionId: lastSid,
      inject: d.inject === true,
      reason: d.reason ?? (d.inject ? "ok" : "excluded"),
      effective: globalInjecting && d.inject === true,
      l1: (scope && scope.l1) || st.activeProfile || "",
      l2: (scope && scope.l2) || "",
      mode: (scope && scope.mode) || "append",
      // preview = 这次判定不是"跑过一轮对话"得出的，而是按工作区根预判的；
      // 前端据此把灯标成"预判"，用户不会把预判当成既成事实。
      preview: runtime?.lastCwd ? false : true,
      rule: (scope && scope.rule) || null,
    };
  }
  return {
    ok: true,
    plugin: "dsh-prompt-frame",
    pid: process.pid,
    node: process.version,
    now: new Date().toISOString(),
    registered: registered ?? null,
    config: publicConfig(cfg),
    paths: {
      injectFile: paths.injectFile,
      offFlag: paths.offFlag,
      logFile: paths.logFile,
      stagesDir: paths.stagesDir ?? null,
      profilesDir: paths.profilesDir ?? null,
      stateFile: paths.home ? path.join(paths.home, "dsh-prompt-frame-state.json") : null,
    },
    files: {
      inject: injectStamp,
      log: { ...logStamp, lines: countLines(paths.logFile) },
      off: offStamp,
    },
    // 语义统一：injecting = 全局开关开着、下一轮真的会改写 prompt（全局语义）。
    // effective = 结合"最近一次装配"的目录/会话后的实际结果；没有装配记录时为 null。
    // 只有排除名单（默认全注入），页面不需要模式开关，避免"选了全部名单还有意义吗"的歧义。
    state: {
      injecting: globalInjecting,
      enabled: cfg.enabled !== false,
      offFlag: offStamp.exists,
      effective: lastDecision ? lastDecision.effective : null,
      lastDecision,
      profile: st.activeProfile,
      excludeSessions: st.excludeSessions,
      excludePaths: st.excludePaths,
      // v1 分层：工作区层规则表。排除看 excludePaths（减法），叠加看 pathProfiles（加法）。
      pathProfiles: st.pathProfiles,
      // 默认第二层：没被规则覆盖的对话用它兜底（空串＝不设）。
      defaultL2: st.defaultL2 || "",
      workspaces: workspaceRows,
      updatedAt: st.updatedAt,
      lastSessionId: lastSid,
      lastCwd,
      lastReason: runtime?.lastReason ?? null,
    },
    profiles,
    inject: { source: injectSource, bytes: injectBytes },
    runtime,
    logStats: computeLogStats(paths.logFile),
    logRecent: readLogTail(paths.logFile, 12, "assemble"),
    stages,
  };
}

/** 给一个最小可用的 JSON 响应器。 */
function sender(res) {
  return (status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };
}

/** 读请求体 JSON。maxBytes 缺省 64 KB；注入正文保存要放到 1 MB。 */
function readJson(req, maxBytes = 65536) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * 注册控制台 HTTP 路由。webServer 服务缺失时返回 false（不算错误）。
 * @param {object} ctx cordis 插件上下文。
 * @param {object} opts {cfg, paths, handler, registered}
 * @returns {boolean} 是否注册成功。
 */
export function registerConsole(ctx, opts) {
  // 探测顺序有意为之：先 ctx.get("webServer")，再退回 ctx.webServer 属性。
  // cordis 里访问未 inject 声明的服务，属性代理会抛错；而 get() 只返回 undefined。
  // 旧写法 `ctx?.webServer ?? ctx?.get?.(...)` 把属性放前面，一次抛错就整体落空，
  // 结果 apply 日志里 console:false、路由根本没注册（/api/prompt-frame/* 401）。
  const diag = { via: null, error: null };
  registerConsole.diagnose = diag;
  const describe = (e) => String((e && e.message) || e);
  let webServer = null;
  if (ctx && typeof ctx.get === "function") {
    try {
      webServer = ctx.get("webServer") ?? null;
      if (webServer) diag.via = "get";
    } catch (e) {
      diag.error = `get: ${describe(e)}`;
    }
  }
  if (!webServer) {
    try {
      webServer = ctx?.webServer ?? null;
      if (webServer) diag.via = "property";
    } catch (e) {
      diag.error = (diag.error ? `${diag.error}; ` : "") + `property: ${describe(e)}`;
    }
  }
  if (!webServer || typeof webServer.register !== "function") return false;

  const handler = async (req, res) => {
    const send = sender(res);
    try {
      const url = new URL(req.url ?? "/", "http://dsh.local");
      const p = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      // 跨站防护：浏览器跨源请求必带 Origin，与 Host 不符即拒；无 Origin（本机脚本）放行。
      const origin = req.headers?.origin;
      if (origin) {
        let same = false;
        try {
          const o = new URL(origin);
          same = o.host === String(req.headers?.host ?? "");
        } catch {
          same = false;
        }
        if (!same) return send(403, { ok: false, error: { code: "forbidden", message: "cross-origin request rejected" } });
      }

      if (method === "GET" && (p === `${CONSOLE_API_PREFIX}/status` || p === `${CONSOLE_API_PREFIX}/status/`)) {
        const status = await buildStatus(opts);
        return send(200, status);
      }

      if (method === "GET" && p === `${CONSOLE_API_PREFIX}/log`) {
        const limitRaw = Number(url.searchParams.get("limit") ?? 40);
        const limit = Math.min(400, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 40));
        const ev = url.searchParams.get("ev");
        const records = readLogTail(opts.paths.logFile, limit, ev && ev !== "all" ? ev : null);
        return send(200, { ok: true, file: opts.paths.logFile, limit, ev: ev ?? "all", records });
      }

      if (method === "GET" && p === `${CONSOLE_API_PREFIX}/stages`) {
        return send(200, { ok: true, ...(await stageList(opts.handler)) });
      }

      if (method === "POST" && p === `${CONSOLE_API_PREFIX}/toggle`) {
        const body = await readJson(req);
        const on = body?.on !== false; // 缺省视为开启
        try {
          fs.mkdirSync(path.dirname(opts.paths.offFlag), { recursive: true });
          if (on) {
            fs.rmSync(opts.paths.offFlag, { force: true });
          } else {
            fs.writeFileSync(opts.paths.offFlag, `off by console at ${new Date().toISOString()}\n`, "utf8");
          }
        } catch (err) {
          return send(500, { ok: false, error: { code: "write-failed", message: String(err?.message || err) } });
        }
        const status = await buildStatus(opts);
        return send(200, { ...status, action: on ? "on" : "off", changed: true });
      }

      if (method === "POST" && p === `${CONSOLE_API_PREFIX}/reload`) {
        const body = await readJson(req);
        const what = typeof body?.what === "string" ? body.what : "all";
        const done = [];
        try {
          if (what === "all" || what === "inject") {
            if (typeof opts.handler?.clearCaches === "function") {
              opts.handler.clearCaches();
              done.push("inject-cache");
            }
          }
          if (what === "all" || what === "pipeline") {
            if (typeof opts.handler?.resetPipeline === "function") {
              opts.handler.resetPipeline();
              done.push("pipeline");
            }
          }
        } catch (err) {
          return send(500, { ok: false, error: { code: "reload-failed", message: String(err?.message || err) } });
        }
        const status = await buildStatus(opts);
        return send(200, { ...status, action: "reload", reloaded: done });
      }

      // ── 运行时状态：注入版本 + 排除名单（默认全注入，只做减法）──────────
      // 名单存在 state 文件里（不是 schemastery Config），改完下一轮装配立即生效，不用重启。
      // 不提供 all/blacklist/whitelist 三模式：白名单语义下"默认全部注入"无意义，
      // 而且新开会话要重新登记。现在只维护"不注入"的目录与会话，交集之外一律注入。
      const STATE_FILE = () => path.join(opts.paths.home, "dsh-prompt-frame-state.json");
      const profileNames = () => listProfiles(opts.paths).map((x) => x.name);
      const dedupe = (arr) => [...new Set((arr ?? []).map((x) => String(x).trim()).filter((x) => x.length > 0))];
      // 目录条目按"路径等价"去重：`E:\a` 与 `e:/a` 是同一条（Windows 大小写不敏感、斜杠等价）。
      const dedupePaths = (arr) => {
        const out = [];
        for (const raw of arr ?? []) {
          const v = normalizePath(raw);
          if (v === "") continue;
          if (out.some((x) => pathCovers(x, v) && pathCovers(v, x))) continue;
          out.push(v);
        }
        return out;
      };

      if (method === "GET" && p === `${CONSOLE_API_PREFIX}/state`) {
        const st = readState(opts.paths.home);
        const seen = opts.handler?.stats?.sessionSeen ?? {};
        const recentSessions = Object.keys(seen)
          .map((id) => ({
            id,
            count: seen[id].count,
            applied: seen[id].applied,
            last: seen[id].last,
            profile: seen[id].profile,
            l1: seen[id].l1 ?? null,
            l2: seen[id].l2 ?? null,
            mode: seen[id].mode ?? null,
            cwd: seen[id].cwd ?? null,
            listed: st.excludeSessions.includes(id),
          }))
          .sort((a, b) => String(b.last).localeCompare(String(a.last)));
        return send(200, {
          ok: true,
          state: st,
          profiles: listProfiles(opts.paths),
          stateFile: STATE_FILE(),
          lastSessionId: opts.handler?.stats?.lastSessionId ?? null,
          // 会话级 cwd 常为空（实测 session 上没有 cwd 字段），此时用进程级工作区根。
          lastCwd: opts.handler?.stats?.lastCwd ?? opts.handler?.procWorkspaceRoot ?? null,
          // 进程级工作区根（来自宿主 sandboxPolicy 服务）；null 表示这条路没取到。
          workspaceRoot: opts.handler?.procWorkspaceRoot ?? null,
          // 本进程计数（页面显示"装配 N 轮"必须从这里拿；1.3.x 误读 gov.pipeline 恒为 0）
          runtime: (() => {
            const s = opts.handler?.stats;
            if (!s || typeof s !== "object") return null;
            return { assemblies: s.assemblies, applied: s.applied, skipped: s.skipped, errors: s.errors, startedAt: s.startedAt };
          })(),
          recentSessions,
        });
      }

      if (method === "POST" && p === `${CONSOLE_API_PREFIX}/state`) {
        const body = await readJson(req);
        const patch = {};
        const cur = readState(opts.paths.home);

        if (typeof body?.activeProfile === "string") {
          if (!profileNames().includes(body.activeProfile)) {
            return send(404, { ok: false, error: { code: "no-such-profile", message: `没有名为 ${body.activeProfile} 的版本` } });
          }
          patch.activeProfile = body.activeProfile;
        }
        // 整表替换（页面"保存"用）
        if (Array.isArray(body?.excludePaths)) {
          patch.excludePaths = dedupePaths(body.excludePaths);
        }
        if (Array.isArray(body?.excludeSessions)) {
          patch.excludeSessions = dedupe(body.excludeSessions);
        }
        // 整表替换工作区层。先验 profile 名存在，避免写出指向不存在版本的规则——
        // 那种规则在注入时会被静默跳过，用户只会觉得"配了没生效"。
        if (Array.isArray(body?.pathProfiles)) {
          const names = profileNames();
          let bad = "";
          for (const x of body.pathProfiles) {
            if (!x || typeof x !== "object") continue;
            const cand = [];
            for (const k of ["l1", "l2", "profile"]) {
              if (typeof x[k] === "string" && x[k].trim() !== "") cand.push(x[k].trim());
            }
            const miss = cand.find((n) => !names.includes(n));
            if (miss) {
              bad = miss;
              break;
            }
          }
          if (bad) {
            return send(404, { ok: false, error: { code: "no-such-profile", message: `没有名为 ${bad} 的版本` } });
          }
          patch.pathProfiles = body.pathProfiles;
        }
        // 默认第二层：没有被任何工作区规则覆盖的对话，用这份正文当第二层。
        // 空名字表示取消默认（此时未覆盖的对话只有第一层）。
        if (body?.action === "set-default-l2") {
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          if (name !== "") {
            const hit = listProfiles(opts.paths).find((x) => x.name === name && x.level === "l2");
            if (!hit) {
              return send(404, { ok: false, error: { code: "no-such-l2", message: `没有名为 ${name} 的第二层预设` } });
            }
          }
          patch.defaultL2 = name;
        }

        // 单条 upsert（详情页"保存这条规则"用）：按目录互含匹配替换，l1/l2 至少一个非空。
        if (body?.action === "path-set") {
          const dir = normalizePath(body?.path);
          if (dir === "") {
            return send(400, { ok: false, error: { code: "bad-path", message: "工作目录为空" } });
          }
          const l1 = typeof body?.l1 === "string" ? body.l1.trim() : "";
          const l2 = typeof body?.l2 === "string" ? body.l2.trim() : "";
          const mode = body?.mode === "replace" ? "replace" : "append";
          if (l1 === "" && l2 === "") {
            return send(400, { ok: false, error: { code: "bad-rule", message: "第一级和第二级至少要指定一个预设" } });
          }
          const names = profileNames();
          const miss = [l1, l2].filter((n) => n !== "").find((n) => !names.includes(n));
          if (miss) {
            return send(404, { ok: false, error: { code: "no-such-profile", message: `没有名为 ${miss} 的版本` } });
          }
          const rest = cur.pathProfiles.filter((x) => !(pathCovers(x.path, dir) && pathCovers(dir, x.path)));
          patch.pathProfiles = [...rest, { path: dir, l1, l2, mode }];
        }
        if (body?.action === "path-rule-remove") {
          const dir = normalizePath(body?.path);
          if (dir === "") {
            return send(400, { ok: false, error: { code: "bad-path", message: "工作目录为空" } });
          }
          patch.pathProfiles = cur.pathProfiles.filter((x) => !(pathCovers(x.path, dir) && pathCovers(dir, x.path)));
        }
        // 增量动作（列表里点按钮用）
        if (body?.action === "path-add") {
          const p1 = normalizePath(body?.path);
          if (p1 === "") {
            return send(400, { ok: false, error: { code: "bad-path", message: "路径为空" } });
          }
          patch.excludePaths = dedupePaths([...cur.excludePaths, p1]);
        }
        if (body?.action === "path-remove") {
          const t = normalizePath(body?.path);
          // 互含即视为同一条目（忽略大小写与末尾反斜杠差异）
          patch.excludePaths = cur.excludePaths.filter((x) => !(pathCovers(x, t) && pathCovers(t, x)));
        }
        if (body?.action === "paths-clear") {
          patch.excludePaths = [];
        }
        if (body?.action === "session-add" && typeof body?.sessionId === "string" && body.sessionId.trim()) {
          patch.excludeSessions = dedupe([...cur.excludeSessions, body.sessionId.trim()]);
        }
        if (body?.action === "session-remove" && typeof body?.sessionId === "string" && body.sessionId.trim()) {
          patch.excludeSessions = cur.excludeSessions.filter((x) => x !== body.sessionId.trim());
        }
        if (body?.action === "sessions-clear") {
          patch.excludeSessions = [];
        }
        if (Object.keys(patch).length === 0) {
          return send(400, { ok: false, error: { code: "no-patch", message: "没有可应用的字段（activeProfile / excludePaths / excludeSessions / pathProfiles / action）" } });
        }
        const next = writeState(opts.paths.home, patch);
        opts.handler?.clearCaches?.();
        return send(200, { ok: true, state: next, profiles: listProfiles(opts.paths) });
      }

      // ── 版本管理（增删改名激活）──────────────────────────────────
      const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

      if (method === "GET" && p === `${CONSOLE_API_PREFIX}/profiles`) {
        return send(200, {
          ok: true,
          profiles: listProfiles(opts.paths),
          active: readState(opts.paths.home).activeProfile,
        });
      }

      if (method === "POST" && p === `${CONSOLE_API_PREFIX}/profiles`) {
        const body = await readJson(req);
        const action = String(body?.action ?? "");
        const name = String(body?.name ?? "").trim();
        if (!NAME_RE.test(name)) {
          return send(400, { ok: false, error: { code: "bad-name", message: "版本名只允许字母数字与 . _ -（1–64 字符，不能以外点开头）" } });
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");

        if (action === "create") {
          const level = body?.level === "l2" ? "l2" : "l1";
          // 两层各有自己的名字空间：只看"这一层的文件在不在"，不看"有没有同名预设"。
          // 否则第一层建了 1，第二层就再也建不了 1（原来两层挤在同一个 .md 上）。
          const ownFile = level === "l2"
            ? path.join(opts.paths.profilesDir, `${L2_PREFIX}${name}.md`)
            : path.join(opts.paths.profilesDir, `${name}.md`);
          if (fs.existsSync(ownFile)) {
            return send(409, { ok: false, error: { code: "exists", message: `${level === "l2" ? "第二层" : "第一层"}已有名为 ${name} 的预设` } });
          }
          // from="" 表示创建**空白**预设（v1 工作区层用）：新工作区预设通常是
          // 从零写自己的协议，先复制一份全局正文再删干净反而更麻烦。
          const rawFrom = body?.from;
          const blank = rawFrom === "";
          const from = blank ? "" : String(rawFrom ?? readState(opts.paths.home).activeProfile);
          if (!blank && !profileNames().includes(from)) {
            return send(404, { ok: false, error: { code: "no-source", message: `来源版本 ${from} 不存在` } });
          }
          let text = "";
          if (!blank) {
            const src = readProfile(from, opts.paths);
            text = src.exists ? src.text : "";
            // 来源没有正文字节时（典型情况：default 的覆盖文件刚被 reset 掉）回退到包内
            // 资产，否则"从当前版本复制"在这种状态下会直接失败。
            if (!String(text).trim()) {
              try {
                text = fs.readFileSync(new URL("../assets/frame.md", import.meta.url), "utf8");
              } catch {
                text = "";
              }
            }
            if (!String(text).trim()) {
              return send(404, { ok: false, error: { code: "no-source-text", message: `来源版本 ${from} 没有正文文件` } });
            }
          }
          const wrote = writeProfile(name, opts.paths, text, level);
          // 只给第一层写层级标记：第二层的层级由文件名前缀自带，再写标记会让
          // 同名的第一层预设被误判成第二层。
          if (level !== "l2") writePresetLevel(name, level, opts.paths);
          opts.handler?.clearCaches?.();
          return send(200, { ok: true, action: "create", name, from, level, bytes: wrote.bytes, file: wrote.file, profiles: listProfiles(opts.paths) });
        }

        if (action === "activate") {
          if (!profileNames().includes(name)) {
            return send(404, { ok: false, error: { code: "no-such-profile", message: `没有名为 ${name} 的版本` } });
          }
          const next = writeState(opts.paths.home, { activeProfile: name });
          opts.handler?.clearCaches?.();
          return send(200, { ok: true, action: "activate", name, state: next });
        }

        if (action === "delete") {
          if (name === "default") {
            return send(400, { ok: false, error: { code: "protected", message: "default 是内置版本，不能删除" } });
          }
          const cur = readState(opts.paths.home);
          const level = body?.level === "l2" ? "l2" : "l1";
          const gone = deleteProfile(name, opts.paths, level);
          if (level !== "l2") writePresetLevel(name, "", opts.paths);
          let next = cur;
          if (cur.activeProfile === name) next = writeState(opts.paths.home, { activeProfile: "default" });
          opts.handler?.clearCaches?.();
          return send(200, { ok: gone, action: "delete", name, fellBackTo: cur.activeProfile === name ? "default" : null, state: next, profiles: listProfiles(opts.paths) });
        }

        if (action === "duplicate") {
          // duplicate = create 的别名（保留给旧调用方）
          return send(400, { ok: false, error: { code: "use-create", message: "请用 action=create 并传 from" } });
        }

        return send(400, { ok: false, error: { code: "bad-action", message: `未知 action: ${action}（create / activate / delete）` } });
      }

      // ── 注入正文读写 ──────────────────────────────────────────────
      // 正文来源按「当前生效版本」解析：default = 覆盖文件（paths.injectFile），
      // 其余 = profiles/<name>.md；两者都不存在时对 default 用包内 assets/frame.md 兜底。
      const injectPathInfo = (profileName, level) => {
        const st = readState(opts.paths.home);
        const name = typeof profileName === "string" && profileName.trim() ? profileName.trim() : st.activeProfile;
        const isL2 = level === "l2";
        const file = resolveProfileFile(name, opts.paths, isL2 ? "l2" : undefined);
        // 第二层没有包内资产可回落：l2 预设文件不存在就等于"还没写"。
        const asset = isL2 ? null : (opts.assetPath ?? null);
        const hasFile = Boolean(file) && fs.existsSync(file);
        const active = hasFile ? file : asset;
        return { name, file, asset, hasFile, active };
      };

      if (method === "GET" && p === `${CONSOLE_API_PREFIX}/inject`) {
        const info = injectPathInfo(url.searchParams.get("profile"), url.searchParams.get("level") || undefined);
        if (!info.active) {
          // 预设存在但正文文件还没建（新建后第一次打开）：返回空正文，让编辑器直接写。
          return send(200, {
            ok: true,
            profile: info.name,
            source: "empty",
            overridden: false,
            path: info.file,
            overridePath: info.file,
            assetPath: null,
            bytes: 0,
            lines: 0,
            mtime: null,
            text: "",
          });
        }
        let text = "";
        let stamp = null;
        try {
          text = fs.readFileSync(info.active, "utf8");
          const st = fs.statSync(info.active);
          stamp = { mtime: st.mtime.toISOString(), bytes: st.size };
        } catch (err) {
          return send(500, { ok: false, error: { code: "read-failed", message: String(err?.message || err) } });
        }
        return send(200, {
          ok: true,
          profile: info.name,
          source: info.hasFile ? "file" : "asset",
          overridden: info.hasFile,
          path: info.active,
          overridePath: info.file,
          assetPath: info.asset,
          bytes: Buffer.byteLength(text, "utf8"),
          lines: text === "" ? 0 : text.split("\n").length,
          mtime: stamp?.mtime ?? null,
          text,
        });
      }

      if (method === "POST" && p === `${CONSOLE_API_PREFIX}/inject`) {
        const body = await readJson(req, 1 << 20);
        const info = injectPathInfo(body?.profile, body?.level === "l2" ? "l2" : undefined);
        if (!info.file) {
          return send(400, { ok: false, error: { code: "no-override-path", message: "覆盖文件路径未解析" } });
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");

        // reset=true：删掉覆盖文件，回退到包内资产（删前备份，可再恢复）。
        if (body?.reset === true) {
          try {
            if (fs.existsSync(info.file)) {
              const bak = `${info.file}.bak-${ts}`;
              fs.copyFileSync(info.file, bak);
              fs.rmSync(info.file, { force: true });
              opts.handler?.clearCaches?.();
              const status = await buildStatus(opts);
              return send(200, { ...status, action: "reset", backedUp: bak });
            }
            const status = await buildStatus(opts);
            return send(200, { ...status, action: "reset", backedUp: null });
          } catch (err) {
            return send(500, { ok: false, error: { code: "reset-failed", message: String(err?.message || err) } });
          }
        }

        const text = typeof body?.text === "string" ? body.text : null;
        if (text === null) {
          return send(400, { ok: false, error: { code: "bad-request", message: "body.text 必须是字符串" } });
        }
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > 512 * 1024) {
          return send(413, { ok: false, error: { code: "too-large", message: `正文 ${bytes} B 超过 512 KB 上限` } });
        }
        // 第二层和其他预设允许存空（存空＝这一级被跳过）；只有第一层的 default 不行，
        // 它是最后兜底，清空等于把系统提示词变成空白（那还不如原生，用户明确要求避免）。
        if (text.trim() === "" && info.name === "default") {
          return send(400, { ok: false, error: { code: "empty", message: "default 是兜底正文，不能清空" } });
        }
        let backedUp = null;
        try {
          fs.mkdirSync(path.dirname(info.file), { recursive: true });
          if (fs.existsSync(info.file)) {
            backedUp = `${info.file}.bak-${ts}`;
            fs.copyFileSync(info.file, backedUp);
          } else if (info.asset && fs.existsSync(info.asset)) {
            // 首次覆盖：把包内资产也留一份，方便对照"改之前长什么样"。
            backedUp = `${info.file}.bak-asset-${ts}`;
            fs.copyFileSync(info.asset, backedUp);
          }
          fs.writeFileSync(info.file, text, "utf8");
          opts.handler?.clearCaches?.();
        } catch (err) {
          return send(500, { ok: false, error: { code: "write-failed", message: String(err?.message || err) } });
        }
        // 只保留最近 5 份备份，避免 ~/.dsh 里堆垃圾。
        try {
          const dir = path.dirname(info.file);
          const base = path.basename(info.file) + ".bak-";
          const baks = fs.readdirSync(dir)
            .filter((n) => n.startsWith(base))
            .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
          for (const old of baks.slice(5)) fs.rmSync(path.join(dir, old.n), { force: true });
        } catch {
          /* 清理失败不影响保存结果 */
        }
        const status = await buildStatus(opts);
        return send(200, { ...status, action: "save", path: info.file, bytes, backedUp });
      }

      return send(404, { ok: false, error: { code: "not-found", message: `no route for ${method} ${p}` } });
    } catch (err) {
      try {
        return send(500, { ok: false, error: { code: "internal", message: String((err && err.message) || err) } });
      } catch {
        return undefined;
      }
    }
  };

  try {
    webServer.register({ kind: "prefix", path: CONSOLE_API_PREFIX, handler });
    return true;
  } catch (e) {
    diag.error = (diag.error ? `${diag.error}; ` : "") + `register: ${describe(e)}`;
    return false;
  }
}
