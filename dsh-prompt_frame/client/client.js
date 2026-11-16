/**
 * dsh-prompt-frame 的 WebUI 半（手写 bundle，宿主不编译）。
 *
 * 宿主加载方式：package.json 的 `dsh.client` 指向 ./client，dsh-client-modules
 * 启动时把本文件当静态模块塞进页面，调用
 * `window.__ModuleLoader__.load({ id, factory })`；factory 里 require("react")
 * 拿到宿主同一份 React，再把组件注册进两个槽位：
 *
 *   plugins.bundle.config               → 插件页「注入控制台」卡片（完整面板）
 *   conversation.session.header.actions → 会话头部小徽章（一眼看 ON/OFF）
 *
 * 数据来自同源 HTTP：GET /api/prompt-frame/status（见 lib/console.js）。
 * 这个文件不参与任何 prompt 改写，纯只读 + 两个开关按钮。
 *
 * @module dsh-prompt-frame/client
 */
window.__ModuleLoader__.load({
  id: "dsh-prompt-frame",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 自证探针（1.4.4 排查用，保留无副作用）：宿主若真的把本 bundle 塞进页面，
    // DevTools Console 会出现这条日志、window 上会出现这个标记。
    // 看不到 = 宿主根本没加载 client 半（与注入本身无关，注入在 host 进程里跑）。
    try {
      window.__dshPromptFrameClient = { loadedAt: new Date().toISOString(), rev: "1.4.4" };
      console.log("[dsh-prompt-frame] client bundle loaded");
    } catch {
      /* 无 window 环境（离线测试）忽略 */
    }

    const react = require("react");
    const h = react.createElement;
    const { useCallback, useEffect, useMemo, useState } = react;

    const API = "/api/prompt-frame";

    /** 单个槽位注册失败不能连累其余槽位（rc8 兼容盖子，同 dsh-undo-savepoint 做法）。 */
    function safe(label, fn) {
      try {
        fn();
      } catch (err) {
        try {
          console.warn("[dsh-prompt-frame] " + label + " skipped:", err && err.message ? err.message : err);
        } catch {
          /* 控制台不可用时彻底静默 */
        }
      }
    }

    // ── 工具 ───────────────────────────────────────────────────────────
    const fmtKB = (bytes) => {
      const n = Number(bytes) || 0;
      if (n < 1024) return n + " B";
      return (n / 1024).toFixed(1) + " KB";
    };
    const fmtTime = (iso) => {
      if (typeof iso !== "string") return "—";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso.length >= 19 ? iso.slice(11, 19) : iso;
      const p = (x) => String(x).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    };
    const REASON_ZH = {
      disabled: "配置关闭",
      "off-flag": "OFF 标志",
      "no-inject-text": "无注入正文",
      error: "出错回退",
      unknown: "未知",
    };

    // 主题 token 全部取自宿主 --dsw-alias-*，深浅色自动跟随。
    const C = {
      card: {
        border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
        borderRadius: "10px",
        padding: "12px 14px",
        margin: "10px 0",
        fontSize: "13px",
        lineHeight: 1.65,
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-specific-tip, transparent)",
      },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      dim: { color: "var(--dsw-alias-label-tertiary, #888)" },
      sec: { color: "var(--dsw-alias-label-secondary, inherit)" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "12px" },
      btn: {
        cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, inherit)",
        borderRadius: "8px",
        height: "24px",
        padding: "0 9px",
        fontSize: "12px",
        lineHeight: "22px",
        whiteSpace: "nowrap",
      },
      table: { width: "100%", borderCollapse: "collapse", marginTop: "4px" },
      th: {
        textAlign: "left",
        fontWeight: 500,
        color: "var(--dsw-alias-label-tertiary, #888)",
        padding: "4px 8px 4px 0",
        fontSize: "12px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))",
      },
      td: {
        padding: "3px 8px 3px 0",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: "12px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))",
      },
      dot: (on) => ({
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: on === "excluded"
          ? "var(--dsw-alias-state-warning-primary, #d97706)"
          : on === "off"
            ? "var(--dsw-alias-label-tertiary, #b8b8b8)"
            : on
              ? "var(--dsw-alias-state-success-primary, #30a46c)"
              : "var(--dsw-alias-label-tertiary, #b8b8b8)",
        flex: "0 0 auto",
      }),
      // 状态灯语义（1.4.1）：绿灯只代表"全局开关开着且本工作区没被排除"。
      // 被目录/会话排除时用琥珀色，避免"明明排除了还是绿的"这种误读。
      headOf: (st) => {
        if (!st) return { text: "读取中", dot: "off", dim: true };
        if (st.enabled === false) return { text: "配置已禁用", dot: "off", dim: true };
        if (st.offFlag) return { text: "已停用（OFF 标志）", dot: "off", dim: true };
        if (st.effective === false) {
          const d = st.lastDecision || {};
          const why = d.reason === "excluded-session" ? "本会话已排除" : "本工作区已排除";
          return { text: why, dot: "excluded", dim: false, cwd: d.cwd || "" };
        }
        if (st.effective === true) return { text: "生效中", dot: true, dim: false };
        return { text: "全局已开启（尚无装配记录）", dot: "off", dim: true };
      },
    };

    async function getJson(path, init) {
      const res = await fetch(path, Object.assign({ cache: "no-store" }, init || {}));
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!res.ok) {
        const msg = body && body.error && body.error.message ? body.error.message : "HTTP " + res.status;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return body;
    }

    // ── 状态 hook：拉一次 + 4s 轮询（页面隐藏时跳过）──────────────────
    function useFrameStatus() {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(false);

      const load = useCallback(async () => {
        if (typeof document !== "undefined" && document.hidden) return;
        setLoading(true);
        try {
          const s = await getJson(API + "/status");
          setStatus(s);
          setError("");
        } catch (e) {
          setError(
            e && e.status === 404 ? "后端路由未注册（插件未加载或版本过旧）" : String((e && e.message) || e),
          );
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        load();
        const t = setInterval(load, 4000);
        return () => clearInterval(t);
      }, [load]);

      return { status, error, loading, load };
    }

    const btnStyle = (busy) => (busy ? Object.assign({}, C.btn, { opacity: 0.45, cursor: "default" }) : C.btn);

    // ── 完整面板（插件页）────────────────────────────────────────────
    // ── 注入正文查看 / 编辑 ─────────────────────────────────────────
    // 数据来自 GET /inject（返回当前生效的正文 + 来源），保存走 POST /inject，
    // 一律写"用户覆盖文件"（~/.dsh/prompt-inject.md），包内 assets/frame.md 不动。
    function InjectEditor() {
      const [open, setOpen] = useState(false);
      const [info, setInfo] = useState(null);
      const [draft, setDraft] = useState("");
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");

      const loadText = useCallback(async () => {
        setBusy("load");
        setMsg("");
        try {
          const r = await getJson(API + "/inject");
          setInfo(r || null);
          setDraft((r && r.text) || "");
          setDirty(false);
        } catch (e) {
          setMsg("读取失败：" + String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      }, []);

      useEffect(() => {
        if (open && !info) loadText();
      }, [open, info, loadText]);

      const save = useCallback(async () => {
        setBusy("save");
        setMsg("");
        try {
          const r = await getJson(API + "/inject", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: draft }),
          });
          setInfo(Object.assign({}, info, { source: "file", overridden: true, text: draft, bytes: r && r.bytes, lines: draft.split("\n").length }));
          setDirty(false);
          setMsg("已保存 " + fmtKB(r && r.bytes) + (r && r.backedUp ? " · 备份 " + String(r.backedUp).split(/[\\/]/).pop() : ""));
        } catch (e) {
          setMsg("保存失败：" + String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      }, [draft, info]);

      const reset = useCallback(async () => {
        setBusy("reset");
        setMsg("");
        try {
          const r = await getJson(API + "/inject", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reset: true }),
          });
          setMsg(r && r.backedUp ? "已还原为包内资产 · 旧覆盖文件备份 " + String(r.backedUp).split(/[\\/]/).pop() : "本来就没有覆盖文件");
          setInfo(null);
          await loadText();
        } catch (e) {
          setMsg("还原失败：" + String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      }, [loadText]);

      const sourceLabel = !info ? "—" : info.source === "file" ? "用户覆盖" : "包内资产";
      const stamp =
        (info ? fmtKB(info.bytes) + " · " + info.lines + " 行" : "—") +
        " · " + sourceLabel +
        (dirty ? " · 未保存" : "");

      const rows = [
        h(
          "div",
          { key: "h", style: Object.assign({}, C.row, { justifyContent: "space-between" }) },
          h(
            "div",
            { style: C.row },
            h("span", { style: C.sec }, "注入正文"),
            h("span", { style: Object.assign({}, C.mono, C.dim) }, stamp),
          ),
          h(
            "div",
            { style: C.row },
            h(
              "button",
              {
                style: btnStyle(busy !== ""),
                disabled: busy !== "",
                onClick: () => {
                  const next = !open;
                  setOpen(next);
                  if (!next) setMsg("");
                },
              },
              open ? "收起" : "展开查看 / 编辑",
            ),
          ),
        ),
      ];

      if (open) {
        rows.push(
          h("textarea", {
            key: "ta",
            value: draft,
            spellCheck: false,
            onChange: (e) => {
              setDraft(e.target.value);
              setDirty(true);
            },
            style: Object.assign({}, C.mono, {
              width: "100%",
              height: "320px",
              marginTop: "8px",
              padding: "8px 10px",
              boxSizing: "border-box",
              resize: "vertical",
              color: "inherit",
              background: "transparent",
              border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",
              borderRadius: "8px",
              lineHeight: 1.55,
            }),
          }),
          h(
            "div",
            { key: "act", style: Object.assign({}, C.row, { marginTop: "6px" }) },
            h("button", { style: btnStyle(busy !== "" || !dirty), disabled: busy !== "" || !dirty, onClick: save }, busy === "save" ? "保存中…" : "保存并生效"),
            h("button", { style: btnStyle(busy !== ""), disabled: busy !== "", onClick: reset }, "还原为包内资产"),
            h("button", { style: btnStyle(busy !== ""), disabled: busy !== "", onClick: loadText }, busy === "load" ? "…" : "重新读取"),
            h("span", { style: C.dim }, "保存后下一轮装配即生效，不用重启"),
          ),
        );
        if (msg) rows.push(h("div", { key: "msg", style: Object.assign({}, C.dim, { marginTop: "4px" }) }, msg));
        if (info && info.overridePath) {
          rows.push(
            h(
              "div",
              { key: "p", style: Object.assign({}, C.mono, C.dim, { marginTop: "4px", wordBreak: "break-all" }) },
              "写入 " + info.overridePath + "（包内资产 " + (info.assetPath || "?") + " 保持不变）",
            ),
          );
        }
      }

      return h("div", { style: { marginTop: "10px" }, "data-dsh-prompt-frame": "inject" }, rows);
    }

    function StatusPanel() {
      const { status, error, loading, load } = useFrameStatus();
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");

      const act = useCallback(
        async (kind) => {
          setBusy(kind);
          setNotice("");
          try {
            if (kind === "on" || kind === "off") {
              await getJson(API + "/toggle", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ on: kind === "on" }),
              });
              setNotice(kind === "on" ? "已开启注入：下一轮装配生效" : "已关闭注入：下一轮装配跳过（无需重启）");
            } else if (kind === "reload") {
              const r = await getJson(API + "/reload", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ what: "all" }),
              });
              setNotice(
                "已重载：" + ((r && r.reloaded) || []).join(" / ") + " · 正文 " + fmtKB(r && r.inject && r.inject.bytes),
              );
            }
            await load();
          } catch (e) {
            setNotice("失败：" + String((e && e.message) || e));
          } finally {
            setBusy("");
          }
        },
        [load],
      );

      const injecting = !!(status && status.state && status.state.injecting);
      const enabled = !!(status && status.state && status.state.enabled);
      const offFlag = !!(status && status.state && status.state.offFlag);
      const rt = (status && status.runtime) || null;
      const lg = (status && status.logStats) || null;
      const recent = (status && status.logRecent) || [];
      const stages = (status && status.stages) || null;

      const head = useMemo(() => {
        if (error) return { text: "控制台未连接", dot: "off" };
        if (!status) return { text: "读取中…", dot: "off" };
        return C.headOf(status.state);
      }, [error, status]);

      const lastDec = (status && status.state && status.state.lastDecision) || null;
      const children = [
        h(
          "div",
          { key: "head", style: Object.assign({}, C.row, { justifyContent: "space-between" }) },
          h(
            "div",
            { style: C.row },
            h("span", { style: C.dot(head.dot) }),
            h("strong", { style: { fontSize: "13px" } }, "注入框架"),
            h("span", { style: C.dim }, head.text),
          ),
          h(
            "div",
            { style: C.row },
            h(
              "button",
              { style: btnStyle(busy !== ""), disabled: busy !== "", onClick: () => act(injecting ? "off" : "on") },
              injecting ? "关闭注入" : "开启注入",
            ),
            h("button", { style: btnStyle(busy !== ""), disabled: busy !== "", onClick: () => act("reload") }, "重载正文"),
            h("button", { style: btnStyle(loading), disabled: loading, onClick: load }, loading ? "…" : "刷新"),
          ),
        ),
      ];

      if (error) {
        children.push(
          h("div", { key: "err", style: { marginTop: "6px", color: "var(--dsw-alias-state-error-primary, #c25b5b)" } }, error),
        );
      }

      children.push(
        h(
          "div",
          { key: "ldec", style: Object.assign({}, C.row, { marginTop: "6px", gap: "8px", flexWrap: "wrap" }) },
          h("span", { style: C.sec }, "最近一次装配"),
          !lastDec
            ? h("span", { style: C.dim }, "还没有记录（发一条消息后再看）")
            : h(
              "span",
              { style: C.dim, title: lastDec.cwd || "" },
              "目录 " + tailPath(lastDec.cwd || "（未知）"),
              " → ",
              h("b", null, lastDec.inject ? "已注入" : "已排除（" + (lastDec.reason || "excluded") + "）"),
            ),
          h(
            "span",
            { style: Object.assign({}, C.dim, { fontSize: "11px" }) },
            "注：页面没有会话身份，这里的判定依据是最近一次装配的目录；换工作区后发一条消息就会刷新。",
          ),
        ),
      );

      children.push(
        h(
          "div",
          { key: "proc", style: Object.assign({}, C.row, { marginTop: "8px", gap: "14px" }) },
          h("span", { style: C.sec }, "本进程装配 ", h("b", null, rt ? rt.assemblies : "—"), " 次"),
          h("span", { style: C.sec }, "生效 ", h("b", null, rt ? rt.applied : "—")),
          h("span", { style: C.sec }, "跳过 ", h("b", null, rt ? rt.skipped : "—")),
          h("span", { style: C.sec }, "错误 ", h("b", null, rt ? rt.errors : "—")),
          rt && rt.last && rt.last.ms != null
            ? h("span", { style: C.dim }, "最近 " + rt.last.ms + " ms")
            : null,
        ),
      );

      children.push(
        h(
          "div",
          { key: "agg", style: Object.assign({}, C.row, { gap: "14px" }) },
          h("span", { style: C.dim }, "累计 ", lg ? lg.assemblies : "—", " 轮 / 生效 ", lg ? lg.applied : "—"),
          h(
            "span",
            { style: C.dim },
            "注入正文 ",
            status ? fmtKB(status.inject && status.inject.bytes) : "—",
            status && status.inject && status.inject.source && status.inject.source !== "none"
              ? "（" + status.inject.source + "）"
              : "",
          ),
          h("span", { style: C.dim }, "日志 ", status && status.files && status.files.log ? status.files.log.lines + " 行" : "—"),
          h("span", { style: C.dim }, offFlag ? "OFF 标志：存在" : "OFF 标志：无"),
        ),
      );

      if (notice) {
        children.push(
          h(
            "div",
            {
              key: "notice",
              style: {
                marginTop: "6px",
                color: "var(--dsw-alias-state-success-primary, #2f8f5b)",
                opacity: notice.indexOf("失败") === 0 ? 0.9 : 1,
              },
            },
            notice,
          ),
        );
      }

      if (stages && stages.stages && stages.stages.length) {
        children.push(
          h(
            "div",
            { key: "stages", style: { marginTop: "8px" } },
            h("div", { style: C.dim }, "流水线阶段" + (stages.loaded ? "" : "（未加载用户阶段）")),
            h(
              "div",
              { style: Object.assign({}, C.row, { gap: "6px", marginTop: "2px" }) },
              stages.stages.map((s) =>
                h(
                  "span",
                  {
                    key: s.name,
                    style: Object.assign({}, C.mono, {
                      border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
                      borderRadius: "4px",
                      padding: "0 5px",
                      opacity: s.disabled ? 0.4 : 1,
                      textDecoration: s.disabled ? "line-through" : "none",
                    }),
                    title: (s.builtin ? "内建" : "用户阶段") + " · order " + s.order,
                  },
                  s.name,
                ),
              ),
            ),
          ),
        );
      }

      if (recent.length) {
        children.push(
          h(
            "table",
            { key: "recent", style: C.table },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { style: C.th }, "时间"),
                h("th", { style: C.th }, "结果"),
                h("th", { style: C.th }, "段数"),
                h("th", { style: C.th }, "耗时"),
              ),
            ),
            h(
              "tbody",
              null,
              recent
                .slice()
                .reverse()
                .map((r, i) =>
                  h(
                    "tr",
                    { key: (r.t || "") + i },
                    h("td", { style: C.td }, fmtTime(r.t)),
                    h("td", { style: C.td }, r.applied ? "改写" : "跳过 · " + (REASON_ZH[r.reason] || r.reason || "?")),
                    h("td", { style: C.td }, String(r.inSections ?? "?") + " → " + String(r.outSections ?? "—")),
                    h("td", { style: C.td }, r.ms != null ? r.ms + " ms" : "—"),
                  ),
                ),
            ),
          ),
        );
      } else {
        children.push(
          h("div", { key: "empty", style: Object.assign({}, C.dim, { marginTop: "8px" }) }, "还没有装配记录（重启后跑一轮对话再看）"),
        );
      }

      if (status && status.paths) {
        children.push(
          h(
            "div",
            { key: "paths", style: Object.assign({}, C.mono, C.dim, { marginTop: "8px", wordBreak: "break-all" }) },
            "正文 " + status.paths.injectFile + "　·　日志 " + status.paths.logFile,
          ),
        );
      }

      children.push(h(InjectEditor, { key: "inject-editor" }));

      return h("div", { style: C.card, "data-dsh-prompt-frame": "panel" }, children);
    }

    // ── 会话头部徽章 ─────────────────────────────────────────────────
    function HeaderBadge() {
      const { status } = useFrameStatus();
      if (!status || !status.state) return null;
      const head = C.headOf(status.state);
      const excluded = head.dot === "excluded";
      const title =
        "注入框架：" + head.text
        + (head.cwd ? " · " + head.cwd : "")
        + (status.inject ? " · 正文 " + fmtKB(status.inject.bytes) : "")
        + (excluded ? "（该目录/会话在排除表里，走原生 prompt）" : "");
      return h(
        "span",
        {
          title,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "11px",
            height: "20px",
            padding: "0 7px",
            borderRadius: "999px",
            border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
            color: "var(--dsw-alias-label-secondary, inherit)",
            cursor: "default",
            whiteSpace: "nowrap",
            flex: "none",
          },
        },
        h("span", { style: C.dot(head.dot) }),
        h("span", null, excluded ? "原生" : "注入"),
      );
    }

    // ── 设置页：版本管理 + 按会话注入范围 ───────────────────────────
    // 槽位范式照 dsh-undo-savepoint：settings.section 开一个侧栏分区，子槽
    // settings.frame.item 放正文。两级都失败时整页跳过，插件页卡片不受影响。
    // 这里改的是"运行时状态"（~/.dsh/dsh-prompt-frame-state.json），下一轮
    // 装配立即生效，不需要重启，也不动 settings.json。
    // 1.4.0：取消「全部 / 黑名单 / 白名单」三态。默认对所有会话注入，页面只维护两张
    // "不注入"的表：工作目录（跨对话稳定，主用旋钮）与会话 id（临时精确排除）。
    // 这样新开对话、切换工作区都自动继承默认，不需要重新登记；也不会出现
    // "选了全部，下面名单还有内容"这种没有语义的歧义。
    const kb = (b) => (typeof b === "number" ? (b / 1024).toFixed(1) + " KB" : "-");
    const tailPath = (p) => {
      const s = String(p || "");
      if (s.length <= 46) return s;
      return "…" + s.slice(-45);
    };
    const shortTime = (iso) => {
      if (!iso) return "-";
      const s = String(iso);
      return s.length >= 19 ? s.slice(11, 19) : s;
    };

    function useGovState() {
      const [gov, setGov] = useState(null);
      const [err, setErr] = useState("");
      const load = useCallback(async () => {
        try {
          const r = await getJson(API + "/state");
          setGov(r);
          setErr("");
        } catch (e) {
          setErr(e && e.status === 404 ? "后端路由未注册（插件版本过旧或未加载）" : String((e && e.message) || e));
        }
      }, []);
      useEffect(() => {
        load();
        const t = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          load();
        }, 5000);
        return () => clearInterval(t);
      }, [load]);
      return { gov, err, load };
    }

    function FrameGovernance() {
      const { gov, err, load } = useGovState();
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");
      const [newName, setNewName] = useState("");
      const [sidInput, setSidInput] = useState("");
      const [pathInput, setPathInput] = useState("");

      const post = useCallback(
        async (url, body, okMsg) => {
          setBusy(String(url) + JSON.stringify(body));
          setMsg("");
          try {
            const r = await getJson(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            setMsg(okMsg || "完成");
            await load();
            return r;
          } catch (e) {
            setMsg("失败：" + String((e && e.message) || e));
            return null;
          } finally {
            setBusy("");
          }
        },
        [load],
      );

      if (err) {
        return h("div", { style: C.card }, [
          h("div", null, "读取失败：" + err),
          h("button", { style: C.btn, onClick: load }, "重试"),
        ]);
      }
      if (!gov) return h("div", { style: Object.assign({}, C.card, C.dim) }, "读取中…");

      const st = gov.state || {};
      const profiles = gov.profiles || [];
      const active = st.activeProfile || "default";
      const exPaths = st.excludePaths || [];
      const exSessions = st.excludeSessions || [];
      const recent = gov.recentSessions || [];
      const lastSid = st.lastSessionId || gov.lastSessionId || null;
      const lastCwd = st.lastCwd || gov.lastCwd || null;
      const activeInfo = profiles.find((p) => p.name === active) || {};
      const rt = gov.runtime || {};

      const label = (txt) => h("span", { style: { minWidth: "76px", color: "var(--dsw-alias-label-secondary, inherit)" } }, txt);
      const line = (txt, node, hint) =>
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: "7px 0" } }, [
          label(txt),
          node,
          hint ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, hint) : null,
        ]);

      // —— 版本表 ——
      const profileRows = profiles.map((p) =>
        h("tr", { key: p.name }, [
          h("td", { style: C.td }, [
            h("span", { style: C.dot(p.name === active) }),
            " ",
            p.name === active ? h("strong", null, p.name) : p.name,
          ]),
          h("td", { style: C.td }, kb(p.bytes)),
          h("td", { style: C.td }, String(p.lines == null ? "-" : p.lines)),
          h("td", { style: C.td }, [
            p.name === active
              ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "生效中")
              : h(
                  "button",
                  {
                    style: btnStyle(!!busy),
                    disabled: !!busy,
                    onClick: () => post(API + "/profiles", { action: "activate", name: p.name }, "已切到 " + p.name),
                  },
                  "启用",
                ),
            " ",
            p.name === "default" || p.name === active
              ? null
              : h(
                  "button",
                  {
                    style: btnStyle(!!busy),
                    disabled: !!busy,
                    onClick: () => post(API + "/profiles", { action: "delete", name: p.name }, "已删除 " + p.name),
                  },
                  "删除",
                ),
          ]),
        ]),
      );

      // —— 两张排除表：工作目录（主用，跨对话稳定）＋ 会话 id（备用，精确到单次对话）——
      const smallBtn = (label, onClick, disabled) =>
        h(
          "button",
          {
            style: Object.assign({}, C.btn, { height: "20px", lineHeight: "18px", fontSize: "11px" }),
            disabled: !!busy || !!disabled,
            onClick,
          },
          label,
        );

      const pathRows = exPaths.length
        ? exPaths.map((p) =>
            h("div", { key: p, style: { display: "flex", alignItems: "center", gap: "6px", margin: "3px 0" } }, [
              h("code", { style: C.mono, title: p }, tailPath(p)),
              smallBtn("恢复注入", () => post(API + "/state", { action: "path-remove", path: p }, "已恢复注入：" + p)),
            ]),
          )
        : [h("div", { key: "empty", style: C.dim }, "暂无排除目录 —— 所有工作区都注入")];

      const sessionRows = exSessions.length
        ? exSessions.map((s) =>
            h("div", { key: s, style: { display: "flex", alignItems: "center", gap: "6px", margin: "3px 0" } }, [
              h("code", { style: C.mono, title: s }, s),
              smallBtn("恢复注入", () => post(API + "/state", { action: "session-remove", sessionId: s }, "已恢复注入：" + s)),
            ]),
          )
        : [h("div", { key: "empty", style: C.dim }, "暂无排除会话")];

      const recentRows = recent.length
        ? recent.slice(0, 8).map((r) =>
            h("tr", { key: r.id }, [
              h("td", { style: C.td }, [
                h("code", { style: C.mono, title: r.id }, String(r.id).length > 22 ? "…" + String(r.id).slice(-20) : r.id),
                r.id === lastSid ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, " 当前") : null,
              ]),
              h("td", { style: C.td, title: r.cwd || "" }, r.cwd ? tailPath(r.cwd) : "-"),
              h("td", { style: C.td }, String(r.count) + " / " + String(r.applied)),
              h("td", { style: C.td }, shortTime(r.last)),
              h("td", { style: C.td },
                r.listed
                  ? smallBtn("恢复注入", () => post(API + "/state", { action: "session-remove", sessionId: r.id }, "已恢复注入"))
                  : smallBtn("排除此会话", () => post(API + "/state", { action: "session-add", sessionId: r.id }, "已排除")),
              ),
            ]),
          )
        : [h("tr", { key: "none" }, h("td", { style: C.td, colSpan: 6 }, "本进程还没有装配记录（发一条消息就会出现在这里）"))];

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "2px 0" } }, [
        // 状态摘要
        h("div", { style: C.card }, [
          h("div", { style: Object.assign({}, C.row, { marginBottom: "4px" }) }, [
            h("span", { style: C.dot(!st.offFlag && activeInfo.bytes > 0) }),
            h("strong", null, "提示词注入"),
            h(
              "span",
              { style: Object.assign({}, C.dim, { fontSize: "11px" }) },
              "本进程装配 " + String(rt.assemblies || 0) + " 轮（注入 " + String(rt.applied || 0) + " / 跳过 " + String(rt.skipped || 0) + "）",
            ),
          ]),
          line("注入版本", h("code", { style: C.mono }, active + "（" + kb(activeInfo.bytes) + "）")),
          line(
            "生效范围",
            h("span", null, "默认全部注入；排除 " + String(exPaths.length) + " 个目录 / " + String(exSessions.length) + " 个会话"),
          ),
          line(
            "当前会话目录",
            h("code", { style: C.mono, title: lastCwd || "" }, lastCwd ? tailPath(lastCwd) : "（本进程还没装配过）"),
          ),
          line("状态文件", h("code", { style: C.mono }, gov.stateFile || "-")),
        ]),

        // 版本管理
        h("div", { style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "注入版本"),
          h(
            "div",
            { style: Object.assign({}, C.dim, { fontSize: "11px", marginBottom: "6px" }) },
            "default = 用户覆盖文件（可在插件页编辑正文）；其余版本存放在版本目录，切过去立即生效。",
          ),
          h("table", { style: C.table }, [
            h("thead", null, h("tr", null, [
              h("th", { style: C.th }, "版本"),
              h("th", { style: C.th }, "体积"),
              h("th", { style: C.th }, "行数"),
              h("th", { style: C.th }, "操作"),
            ])),
            h("tbody", null, profileRows),
          ]),
          h("div", { style: Object.assign({}, C.row, { marginTop: "8px" }) }, [
            h("input", {
              style: {
                flex: "1 1 140px",
                minWidth: "120px",
                height: "24px",
                padding: "0 8px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
                background: "transparent",
                color: "inherit",
              },
              placeholder: "新版本名（字母数字 . _ -）",
              value: newName,
              onChange: (e) => setNewName(e.target.value),
            }),
            h(
              "button",
              {
                style: btnStyle(!!busy),
                disabled: !!busy || !newName.trim(),
                onClick: async () => {
                  const r = await post(API + "/profiles", { action: "create", name: newName.trim(), from: active }, "已创建 " + newName.trim());
                  if (r) setNewName("");
                },
              },
              "从当前版本复制",
            ),
          ]),
        ]),

        // 生效范围：默认全部注入，只维护「不注入」的名单
        h("div", { style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "生效范围（默认全部注入）"),
          h(
            "div",
            { style: Object.assign({}, C.dim, { fontSize: "11px", marginBottom: "6px" }) },
            "注入在每轮请求上重新装配，旧对话同样生效 —— 不需要另开新对话，也不需要换干净工作区。这里只维护「不注入」的地方：学术/写作类工作区排除掉就完全走原生行为。目录排除对该目录下所有会话（含以后新开的）生效，是主用旋钮；会话排除只影响单个对话。",
          ),
          h("div", { style: C.row }, [
            smallBtn(
              "把当前工作区加进排除",
              () => post(API + "/state", { action: "path-add", path: lastCwd }, "已排除目录：" + lastCwd),
              !lastCwd,
            ),
            smallBtn("清空目录排除", () => post(API + "/state", { action: "paths-clear" }, "目录排除已清空"), exPaths.length === 0),
            h(
              "span",
              { style: Object.assign({}, C.dim, { fontSize: "11px" }) },
              lastCwd ? "当前：" + tailPath(lastCwd) : "还没装配记录（发一条消息）",
            ),
          ]),
          h("div", { style: { marginTop: "8px" } }, [
            h("div", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "排除的目录（含子目录）"),
            ...pathRows,
          ]),
          h("div", { style: Object.assign({}, C.row, { marginTop: "6px" }) }, [
            h("input", {
              style: {
                flex: "1 1 220px",
                minWidth: "180px",
                height: "24px",
                padding: "0 8px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
                background: "transparent",
                color: "inherit",
              },
              placeholder: "工作目录，如 E:\\dsh-aggent-deepseekv4flash",
              value: pathInput,
              onChange: (e) => setPathInput(e.target.value),
            }),
            smallBtn(
              "添加目录",
              async () => {
                const r = await post(API + "/state", { action: "path-add", path: pathInput.trim() }, "已排除目录");
                if (r) setPathInput("");
              },
              !pathInput.trim(),
            ),
          ]),
        ]),
        // 会话级排除（备用：只想让某一个对话走原生行为时用）
        h("div", { style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "按会话排除（备用）"),
          h(
            "div",
            { style: Object.assign({}, C.dim, { fontSize: "11px", marginBottom: "6px" }) },
            "会话 id 每开一个新对话就会变，所以优先用上面的目录排除。这里适合临时让「这一个对话」不注入。",
          ),
          ...sessionRows,
          h("div", { style: Object.assign({}, C.row, { marginTop: "6px" }) }, [
            h("input", {
              style: {
                flex: "1 1 220px",
                minWidth: "180px",
                height: "24px",
                padding: "0 8px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
                background: "transparent",
                color: "inherit",
              },
              placeholder: "会话 id（从下表复制）",
              value: sidInput,
              onChange: (e) => setSidInput(e.target.value),
            }),
            smallBtn(
              "添加会话",
              async () => {
                const r = await post(API + "/state", { action: "session-add", sessionId: sidInput.trim() }, "已排除该会话");
                if (r) setSidInput("");
              },
              !sidInput.trim(),
            ),
            smallBtn("清空会话排除", () => post(API + "/state", { action: "sessions-clear" }, "会话排除已清空"), exSessions.length === 0),
          ]),
          h("div", { style: { marginTop: "10px" } }, [
            h("div", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "本进程活动会话"),
            h("table", { style: C.table }, [
              h("thead", null, h("tr", null, [
                h("th", { style: C.th }, "会话 id"),
                h("th", { style: C.th }, "工作目录"),
                h("th", { style: C.th }, "装配/注入"),
                h("th", { style: C.th }, "最近"),
                h("th", { style: C.th }, "操作"),
              ])),
              h("tbody", null, recentRows),
            ]),
          ]),
        ]),

        msg ? h("div", { style: Object.assign({}, C.dim, { fontSize: "12px", padding: "0 2px" }) }, msg) : null,
      ]);
    }

    /** 设置页分区容器：只负责渲染自己的子槽（范式同 dsh-undo-savepoint）。 */
    function FrameSettingsSection(props) {
      const renderSlot = props && typeof props.renderSlot === "function" ? props.renderSlot : null;
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
        h(
          "div",
          { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" } },
          "默认对所有工作区注入。学术/写作类工作区建议加进「排除目录」，那里的会话就完全走原生行为（引用、公式、长文写作更稳）。",
        ),
        renderSlot ? renderSlot("settings.frame.item", {}) : h(FrameGovernance, null),
      ]);
    }

    // ── 注册 ─────────────────────────────────────────────────────────
    const inject = ["slots"];

    function apply(ctx) {
      safe("slots:plugins.bundle.config", () =>
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-prompt-frame" }, StatusPanel),
        ),
      );
      safe("slots:conversation.session.header.actions", () =>
        ctx.slots.inject("conversation.session.header.actions", () =>
          ctx.slots.register(
            { name: "conversation.session.header.actions", id: "frame-badge", order: 12 },
            HeaderBadge,
          ),
        ),
      );
      // 设置页：独立分区（版本 + 生效范围）。两级分开 safe：分区挂不上时内容槽不注册，避免孤儿槽。
      let settingsOk = false;
      safe("slots:settings.section", () => {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "prompt-frame",
              order: 40,
              label: () => "提示词注入",
              children: { "settings.frame.item": { kind: "list", scope: "root" } },
            },
            FrameSettingsSection,
          ),
        );
        settingsOk = true;
      });
      if (settingsOk) {
        safe("slots:settings.frame.item", () =>
          ctx.slots.inject("settings.frame.item", () =>
            ctx.slots.register({ name: "settings.frame.item", id: "main", order: 0 }, FrameGovernance),
          ),
        );
      }
      // 自证探针：宿主若调用了 apply，这里会打印；settingsSection=false 说明
      // 设置页分区槽注册被跳过（Console 里上面的 warn 会给出具体原因）。
      try {
        console.log("[dsh-prompt-frame] apply done, settingsSection=" + settingsOk);
      } catch {
        /* ignore */
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.StatusPanel = StatusPanel;
    exports.HeaderBadge = HeaderBadge;
    return module.exports;
  },
});
