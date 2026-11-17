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

    // 自证探针（排查用，保留无副作用）：宿主若真的把本 bundle 塞进页面，
    // DevTools Console 会出现这条日志、window 上会出现这个标记。
    // 看不到 = 宿主根本没加载 client 半（与注入本身无关，注入在 host 进程里跑）。
    try {
      window.__dshPromptFrameClient = { loadedAt: new Date().toISOString(), rev: "1.0.0" };
      console.log("[dsh-prompt-frame] client bundle loaded");
    } catch {
      /* 无 window 环境（离线测试）忽略 */
    }

    const react = require("react");
    const h = react.createElement;
    // react-dom 只在宿主模块表里有它时才拿得到；没有就退化成原位渲染（同 dsh-undo-savepoint 的降级做法）。
    let reactDom = null;
    try {
      reactDom = require("react-dom");
    } catch (err) {
      reactDom = null;
    }
    /**
     * 浮层挂到 document.body。
     * 会话头部容器常带 overflow:hidden / transform / backdrop-filter，三者任一都会把 fixed 子元素
     * 裁进那个包含块里 —— 于是"点开了但什么都看不见"，caret 却已经翻转。portal 是唯一干净的解法。
     */
    const portalTo = (node) => {
      if (
        node
        && reactDom
        && typeof reactDom.createPortal === "function"
        && typeof document !== "undefined"
        && document.body
      ) {
        try {
          return reactDom.createPortal(node, document.body);
        } catch (err) {
          /* 降级为原位渲染 */
        }
      }
      return node;
    };
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

    // 当前生效的两级正文名（v2）：第一层 -- 第二层。
    // append 时两层都进 prompt，用 " -- "；replace 时第二层顶掉第一层，用 " → " 更醒目。
    // 只用来显示，不参与任何判定——判定在后端 composeInjectText 里。
    const labelOfProfile = (name) => (!name || name === "default" ? "默认" : name);
    const layerNameOf = (st) => {
      const d = (st && st.lastDecision) || {};
      const l1 = labelOfProfile(d.l1 || (st && st.profile));
      const l2 = d.l2 ? labelOfProfile(d.l2) : "";
      if (!l2) return l1;
      return (d.mode === "replace" ? l1 + " → " + l2 : l1 + " -- " + l2);
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
      // 状态灯语义（v1）：绿 = 正在注入，琥珀 = 走原生（连全局注入一起隔离），灰 = 关掉。
      // 绿点后面跟"这一轮生效的是哪一份正文"：工作区层 replace 时是工作区名，
      // append 时是"全局 + 工作区"，没有工作区层就是全局版本名。
      headOf: (st) => {
        if (!st) return { text: "读取中", dot: "off", dim: true };
        if (st.enabled === false) return { text: "配置已禁用", dot: "off", dim: true };
        if (st.offFlag) return { text: "已停用（OFF 标志）", dot: "off", dim: true };
        const d = st.lastDecision || {};
        if (st.effective === false) {
          const why = d.reason === "excluded-session" ? "本会话已切原生" : "本工作区已切原生";
          return { text: "原生", dot: "excluded", dim: false, cwd: d.cwd || "", why };
        }
        if (st.effective === true) {
          return {
            text: "注入",
            dot: true,
            dim: false,
            layer: layerNameOf(st),
            l1: labelOfProfile(d.l1 || st.profile),
            l2: d.l2 ? labelOfProfile(d.l2) : "",
            mode: d.mode || "append",
            // 还没跑过一轮对话，这个判定是按宿主的工作区根预判的（不是既成事实）。
            preview: d.preview === true,
            cwd: d.cwd || "",
          };
        }
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
            h(
              "span",
              { style: C.dim },
              head.text
              + (head.layer ? " · " + head.layer : "")
              + (head.preview ? "（预判）" : ""),
            ),
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

    // ── 会话头部徽章：绿点 + 两级正文名；点开是浮窗，不直接改配置 ──
    // 为什么是浮窗：徽章只知道 cwd，不知道命中的是哪条规则；单击直接翻转等于
    // 一次点击改掉整个工作区，误触代价太大。浮窗里摆明「这个目录的第一层/第二层」
    // 与「整目录切原生」，改与不改都看得见。会话级切换仍在设置页的「生效范围」。
    function HeaderBadge() {
      const { status, load } = useFrameStatus();
      // 所有 hook 必须在下面那个 early return 之前：晚出生一个 hook 会让整个组件
      // 在 gov 从 null 变有值的那次渲染里报 "Rendered more hooks than during the
      // previous render"，设置页会整块空白。
      const [open, setOpen] = useState(false);
      const [gov, setGov] = useState(null);
      const [draft, setDraft] = useState({ l1: "", l2: "", mode: "append" });
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [box, setBox] = useState(null);
      if (!status || !status.state) return null;
      const head = C.headOf(status.state);
      const excluded = head.dot === "excluded";
      const cwd = head.cwd || "";
      const st = gov && gov.state ? gov.state : null;
      const allProfiles = (gov && gov.profiles) || [];
      const l1List = allProfiles.filter((p) => p.level !== "l2");
      const l2List = allProfiles.filter((p) => p.level === "l2");
      const active = (st && st.profile) || status.state.profile || "";
      const hitPath = (status.state.lastDecision && status.state.lastDecision.rule) || "";
      const rule = ((st && st.workspaces) || []).find((w) => w.path === hitPath) || null;
      const targetPath = (rule && rule.path) || hitPath || cwd;
      // 打开浮窗时才拉 /state（profiles + workspaces 都在里面），平时只轮询 /status。
      const togglePanel = async (ev) => {
        const next = !open;
        setOpen(next);
        setMsg("");
        if (!next) return;
        // 浮窗用 fixed 定位：会话头部容器通常带 overflow:hidden，absolute 落下就被裁掉，
        // 视觉上等于"点了没反应"。这里按徽章的实际位置算一个视口坐标。
        try {
          const r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect
            ? ev.currentTarget.getBoundingClientRect()
            : null;
          if (r) setBox({ top: Math.round(r.bottom + 6), right: Math.round(Math.max(8, window.innerWidth - r.right)) });
        } catch {
          setBox(null);
        }
        try {
          const g = await getJson(API + "/state");
          setGov(g);
          const hp = (g && g.state && g.state.lastDecision && g.state.lastDecision.rule) || "";
          const r = ((g && g.state && g.state.workspaces) || []).find((w) => w.path === hp) || null;
          setDraft({ l1: (r && r.l1) || "", l2: (r && r.l2) || "", mode: (r && r.mode) || "append" });
        } catch (e) {
          setMsg("读取失败：" + ((e && e.message) || String(e)));
        }
      };
      const saveRule = async () => {
        if (!targetPath) { setMsg("没有可写的工作目录"); return; }
        setBusy(true);
        setMsg("⏳ 保存中…");
        try {
          await getJson(API + "/state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "path-set",
              path: targetPath,
              l1: draft.l1 || active,
              l2: draft.l2,
              mode: draft.l2 ? draft.mode : "append",
            }),
          });
          setMsg("✅ 已保存，下一轮生效");
          await load();
          setGov(await getJson(API + "/state"));
        } catch (e) {
          setMsg("❌ 失败：" + ((e && e.message) || String(e)));
        } finally {
          setBusy(false);
        }
      };
      const pbtn = (label, onClick) =>
        h(
          "span",
          {
            key: label,
            onClick: busy ? undefined : onClick,
            style: busy ? Object.assign({}, C.btn, { opacity: 0.5, cursor: "default" }) : C.btn,
          },
          label,
        );
      const prow = { display: "flex", alignItems: "center", gap: "6px", margin: "6px 0", fontSize: "12px" };
      const psel = { height: "22px", fontSize: "12px", maxWidth: "156px" };
      // 深色模式下原生 option 会继承白字叠浅底而看不见，这里显式钉死对比色。
      // 不能在徽章里复用 FrameGovernance 的 optCss —— 那个是函数内局部变量。
      const pOpt = { color: "#1a1a1a", background: "#ffffff" };
      const flip = async () => {
        if (!cwd) return;
        setBusy(true);
        setMsg("⏳ 提交中…");
        try {
          await getJson(API + "/state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: excluded ? "path-remove" : "path-add", path: cwd }),
          });
          setMsg(excluded ? "✅ 已恢复注入" : "✅ 这个目录已切原生");
          await load();
          setGov(await getJson(API + "/state"));
        } catch (e) {
          setMsg("❌ 失败：" + ((e && e.message) || String(e)));
        } finally {
          setBusy(false);
        }
      };
      const title =
        "注入框架：" + head.text
        + (head.layer ? " · 生效正文 " + head.layer : "")
        + (head.l1 ? "\n第一层 " + head.l1 + (head.l2 ? "\n第二层 " + head.l2 + (head.mode === "replace" ? "（替换第一层）" : "（叠加在第一层之后）") : "（无第二层）") : "")
        + (head.preview ? "\n（预判：本进程还没跑过对话，按工作区根估算）" : "")
        + (head.why ? " · " + head.why : "")
        + (head.cwd ? "\n当前目录 " + head.cwd : "")
        + (status.inject ? "\n正文 " + fmtKB(status.inject.bytes) : "")
        + (cwd ? "\n点开浮窗：改两级 / 切原生" : "");
      const panelBody = open
        ? h(
            "div",
            {
              style: {
                position: "fixed",
                top: (box && box.top ? box.top : 64) + "px",
                right: (box && box.right !== undefined && box.right !== null ? box.right : 16) + "px",
                zIndex: 10000,
                maxHeight: "70vh",
                overflowY: "auto",
                minWidth: "268px",
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
                background: "var(--dsw-alias-bg-base, #ffffff)",
                color: "var(--dsw-alias-label-primary, inherit)",
                boxShadow: "0 6px 20px rgba(0,0,0,.18)",
                textAlign: "left",
                whiteSpace: "normal",
                cursor: "default",
              },
              onClick: (ev) => ev.stopPropagation(),
            },
            [
              h(
                "div",
                { key: "top", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
                [
                  h("strong", { key: "t", style: { fontSize: "12px" } }, excluded ? "本工作区：原生" : "本工作区：注入"),
                  pbtn("关闭", () => setOpen(false)),
                ],
              ),
              h(
                "div",
                { key: "path", style: Object.assign({}, C.dim, { fontSize: "11px", margin: "4px 0 8px", wordBreak: "break-all" }) },
                tailPath(targetPath || cwd || "（未知目录）"),
              ),
              h("div", { key: "l1", style: prow }, [
                h("span", { key: "k", style: { width: "42px" } }, "第一层"),
                h(
                  "select",
                  {
                    key: "v",
                    value: draft.l1,
                    onChange: (ev) => setDraft(Object.assign({}, draft, { l1: ev.target.value })),
                    style: psel,
                  },
                  [h("option", { key: "__follow", value: "", style: pOpt }, "跟随全局（" + labelOfProfile(active) + "）")].concat(
                    l1List.map((p) => h("option", { key: p.name, value: p.name, style: pOpt }, p.name)),
                  ),
                ),
              ]),
              h("div", { key: "l2", style: prow }, [
                h("span", { key: "k", style: { width: "42px" } }, "第二层"),
                h(
                  "select",
                  {
                    key: "v",
                    value: draft.l2,
                    onChange: (ev) => setDraft(Object.assign({}, draft, { l2: ev.target.value })),
                    style: psel,
                  },
                  [h("option", { key: "__none", value: "", style: pOpt }, "无")]
                    .concat(
                      draft.l2 && !l2List.some((p) => p.name === draft.l2)
                        ? [h("option", { key: "__missing", value: draft.l2, style: pOpt }, draft.l2 + "（缺正文 · 这一级会被跳过）")]
                        : [],
                    )
                    .concat(l2List.map((p) => h("option", { key: p.name, value: p.name, style: pOpt }, p.name))),
                ),
              ]),
              h("div", { key: "mode", style: prow }, [
                h("span", { key: "k", style: { width: "42px" } }, "方式"),
                h(
                  "select",
                  {
                    key: "v",
                    value: draft.mode,
                    onChange: (ev) => setDraft(Object.assign({}, draft, { mode: ev.target.value })),
                    style: psel,
                    disabled: !draft.l2,
                  },
                  [
                    h("option", { key: "append", value: "append", style: pOpt }, "叠加在第一层之后"),
                    h("option", { key: "replace", value: "replace", style: pOpt }, "替换第一层"),
                  ],
                ),
              ]),
              h("div", { key: "ops", style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" } }, [
                pbtn("保存这两级", saveRule),
                pbtn(excluded ? "恢复注入" : "整目录走原生", flip),
              ]),
              msg
                ? h("div", { key: "msg", style: Object.assign({}, C.dim, { fontSize: "11px", marginTop: "6px" }) }, msg)
                : null,
            ],
          )
        : null;
      // 透明全屏遮罩：点空白处关掉浮窗，同时保证浮窗不在任何裁剪容器里。
      const panel = panelBody
        ? portalTo(
            h(
              "div",
              {
                key: "scrim",
                onClick: () => setOpen(false),
                style: {
                  position: "fixed",
                  left: 0,
                  top: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 9998,
                  background: "transparent",
                },
              },
              panelBody,
            ),
          )
        : null;
      return h("span", { style: { position: "relative", display: "inline-flex", flex: "none" } }, [
        h(
          "span",
          {
            key: "badge",
            title,
            onClick: (ev) => togglePanel(ev),
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
              cursor: cwd ? "pointer" : "default",
              whiteSpace: "nowrap",
              flex: "none",
              maxWidth: "300px",
              userSelect: "none",
            },
          },
          [
            h("span", { key: "dot", style: C.dot(head.dot) }),
            h(
              "span",
              { key: "txt", style: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: "270px" } },
              excluded ? "原生" : "注入" + (head.layer ? " · " + head.layer : ""),
            ),
            h("span", { key: "caret", style: { fontSize: "9px", opacity: 0.6 } }, open ? "▴" : "▾"),
          ],
        ),
        panel,
      ]);
    }

    // ── 设置页：版本管理 + 按会话注入范围 ───────────────────────────
    // 槽位范式照 dsh-undo-savepoint：settings.section 开一个侧栏分区，子槽
    // settings.frame.item 放正文。两级都失败时整页跳过，插件页卡片不受影响。
    // 这里改的是"运行时状态"（~/.dsh/dsh-prompt-frame-state.json），下一轮
    // 装配立即生效，不需要重启，也不动 settings.json。
    // 取消「全部 / 黑名单 / 白名单」三态。默认对所有会话注入，页面只维护两张
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
      // 工作区规则（两级）表单：路径 + 第一级预设 + 第二级预设 + 方式（正文在两级各自的页面里写）
      const [wpPath, setWpPath] = useState("");
      const [wpL1, setWpL1] = useState("");
      const [wpL2, setWpL2] = useState("");
      const [wpMode, setWpMode] = useState("append");
      // 页面导航：home = 概览（工作区隔离 + 对话隔离默认展开）；l1 = 第一层全局正文；l2 = 第二层工作区正文
      const [page, setPage] = useState("home");
      // 第一层正文编辑器：l1Name = 正在编辑的预设，l1Text = 草稿，l1Loaded = 已加载的预设名
      const [l1Name, setL1Name] = useState("");
      const [l1Text, setL1Text] = useState("");
      const [l1Loaded, setL1Loaded] = useState("");
      // 第二层正文编辑器：选中的工作区规则目录 + 草稿
      const [l2Path, setL2Path] = useState("");
      const [l2Text, setL2Text] = useState("");
      // 第二层页：直接为某目录绑定/新建第二级（不用先回概览）
      const [l2NewPath, setL2NewPath] = useState("");
      const [l2Pick, setL2Pick] = useState("");
      const [l2Mode, setL2Mode] = useState("append");
      // 第一层页：新建空白预设的名字
      const [blankName, setBlankName] = useState("");
      // 概览里的规则列表默认展开（折叠时整页看着是空的），仍可手动折叠
      const [wsOpen, setWsOpen] = useState(true);

      const post = useCallback(
        async (url, body, okMsg) => {
          const t0 = Date.now();
          setBusy(String(url) + JSON.stringify(body));
          setMsg("⏳ " + (okMsg || "提交中") + " …");
          try {
            const r = await getJson(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            setMsg("✅ " + (okMsg || "完成") + " · " + (Date.now() - t0) + " ms · " + new Date().toLocaleTimeString());
            await load();
            return r;
          } catch (e) {
            setMsg("❌ 失败：" + String((e && e.message) || e) + " · " + new Date().toLocaleTimeString());
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
      // 默认第二层：没有任何工作区规则命中时，全对话都用这份第二层正文
      const defaultL2 = st.defaultL2 || "";
      const exPaths = st.excludePaths || [];
      const exSessions = st.excludeSessions || [];
      const recent = gov.recentSessions || [];
      const lastSid = st.lastSessionId || gov.lastSessionId || null;
      const lastCwd = st.lastCwd || gov.lastCwd || null;
      const activeInfo = profiles.find((p) => p.name === active) || {};
      const rt = gov.runtime || {};
      // 预设按层分开：第一层页只列 l1，第二层页只列 l2（未标层的旧预设按 l1 算），
      // 免得把全局正文选到工作区层上去——两层混用等于把全局正文再叠一遍。
      const l1Profiles = profiles.filter((p) => p.level !== "l2");
      const l2Profiles = profiles.filter((p) => p.level === "l2");

      const label = (txt) => h("span", { style: { minWidth: "76px", color: "var(--dsw-alias-label-secondary, inherit)" } }, txt);
      const line = (txt, node, hint) =>
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: "7px 0" } }, [
          label(txt),
          node,
          hint ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, hint) : null,
        ]);

      // —— 预设表：调用方传过滤后的列表（第一层页传 l1Profiles，第二层页传 l2Profiles）——
      // —— 预设表：调用方传过滤后的列表（第一层传 l1Profiles，第二层传 l2Profiles）——
      // kind 决定操作列语义：第一层是「设为全局生效」，第二层是「设为默认」——
      // 默认第二层会被所有没有单独配规则的对话使用。
      const profileRowsFor = (list, kind) =>
        list.map((p) =>
          h("tr", { key: p.path || p.name }, [
            h("td", { style: C.td }, [
              h("span", { style: C.dot(kind === "l2" ? p.name === defaultL2 : p.name === active) }),
              " ",
              kind === "l2" && p.name === defaultL2 ? h("strong", null, p.name + "（默认第二层）") : p.name,
            ]),
            h("td", { style: C.td }, kb(p.bytes)),
            h("td", { style: C.td }, [
              kind === "l2"
                ? p.name === defaultL2
                  ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "默认 · 挂到全对话")
                  : smallBtn(
                      "设为默认第二层",
                      () => post(API + "/state", { action: "set-default-l2", name: p.name }, "已把 " + p.name + " 设为默认第二层"),
                      !!busy,
                    )
                : p.name === active
                  ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "全局生效中")
                  : smallBtn(
                      "设为全局生效",
                      () => post(API + "/profiles", { action: "activate", name: p.name }, "已切到 " + p.name),
                      !!busy,
                    ),
              " ",
              p.name === "default"
                ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "内置，不可删")
                : smallBtn(
                    "删除",
                    () => post(API + "/profiles", { action: "delete", name: p.name, level: p.level }, "已删除 " + p.name),
                    !!busy,
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

      // —— 工作区层（v1）——
      // 工作区规则 = 「目录 → 预设名 + 方式」。名字即预设：写正文时先建预设再落文件，
      // 所以不需要第二个"规则库"，同一份正文可以被多个工作区共用。
      const workspaces = st.workspaces || [];
      const inputCss = {
        flex: "1 1 180px",
        minWidth: "140px",
        height: "26px",
        padding: "0 8px",
        fontSize: "12px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
        background: "transparent",
        color: "inherit",
      };
      // 原生下拉的 option 在深色主题下会继承白色文字但套系统浅色背景，整排看不见。
      // 显式定死对比色：浅色/深色主题下都能读。
      const optCss = { color: "#1a1a1a", background: "#ffffff" };
      const areaCss = {
        width: "100%",
        boxSizing: "border-box",
        marginTop: "6px",
        padding: "8px",
        fontSize: "12px",
        lineHeight: 1.55,
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
        background: "transparent",
        color: "inherit",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        resize: "vertical",
      };

      // 概览里加一条工作区规则：只选两个层级的预设，不在这里写正文。
      const addRule = async () => {
        const p = wpPath.trim();
        if (!p) {
          setMsg("❌ 工作目录不能为空");
          return;
        }
        if (!wpL1 && !wpL2) {
          setMsg("❌ 第一级和第二级至少要选一个 —— 两级都空等于没有这条规则");
          return;
        }
        if ((workspaces || []).some((x) => String(x.path || "").toLowerCase() === p.toLowerCase())) {
          setMsg("❌ 这个目录已经有规则了：直接改下面表格里的两个下拉，不用再加一条");
          return;
        }
        const saved = await post(
          API + "/state",
          { action: "path-set", path: p, l1: wpL1, l2: wpL2, mode: wpMode },
          "已添加 " + tailPath(p) + "：第一级 " + (wpL1 || "跟随全局") + " / 第二级 " + (wpL2 || "无"),
        );
        if (saved) {
          setWpPath("");
          setWpL1("");
          setWpL2("");
          setWsOpen(true);
        }
      };

      // 单条两级规则提交：下拉一改就存，避免半截草稿停在页面上。
      const setRule = async (w, patch) => {
        const next = Object.assign({ l1: w.l1 || "", l2: w.l2 || "", mode: w.mode || "append" }, patch);
        if (!next.l1 && !next.l2) {
          setMsg("第一级和第二级至少要留一个预设 —— 两级都空等于没有这条规则");
          return;
        }
        await post(
          API + "/state",
          { action: "path-set", path: w.path, l1: next.l1, l2: next.l2, mode: next.mode },
          "已更新 " + tailPath(w.path) + "：L1 " + (next.l1 || "跟随全局") + " / L2 " + (next.l2 || "无"),
        );
      };
      // —— 两个正文编辑页的读取 ——
      // 第一层：编辑某个预设的正文（预设 = 一份正文文件；default 是覆盖文件，缺省回落包内模板）
      const loadL1 = async (name) => {
        const nm = name || active;
        try {
          const r = await getJson(API + "/inject?level=l1&profile=" + encodeURIComponent(nm));
          setL1Name(nm);
          setL1Text(r && typeof r.text === "string" ? r.text : "");
          setL1Loaded(nm);
          setMsg("");
        } catch (e) {
          setMsg("读取正文失败：" + String((e && e.message) || e));
        }
      };
      // 第二层：把某个预设的正文读进编辑器（预设可能来自规则，也可能是下拉里新选的）
      const loadL2Text = async (name) => {
        if (!name) {
          setL2Text("");
          return;
        }
        try {
          const r = await getJson(API + "/inject?level=l2&profile=" + encodeURIComponent(name));
          setL2Text(r && typeof r.text === "string" ? r.text : "");
        } catch (e) {
          setMsg("❌ 读取正文失败：" + String((e && e.message) || e));
        }
      };
      // 点「编辑」把一条规则整个带进编辑器：目录 / 预设 / 方式 / 正文
      const openL2 = (w) => {
        if (!w) return;
        setL2Path(w.path);
        setL2NewPath(w.path);
        setL2Pick(w.l2 || "");
        setL2Mode(w.mode === "replace" ? "replace" : "append");
        setL2Text("");
        setMsg("");
        if (w.l2) loadL2Text(w.l2);
      };
      const pickRule = (path) => {
        if (!path) {
          setL2Path("");
          return;
        }
        const w = (workspaces || []).find((x) => x.path === path);
        if (w) openL2(w);
      };
      // 第二层页的保存：目录 → 预设的绑定与正文一次做完（不用先回概览建规则）
      const saveL2 = async () => {
        const dir = String(l2NewPath || l2Path || "").trim();
        if (!dir) {
          setMsg("❌ 先填工作目录，例如 E:/dsh测试");
          return;
        }
        if (!l2Pick) {
          setMsg("❌ 先选一个第二级预设；没有的话在右边输入名字点「新建」");
          return;
        }
        const r = await post(
          API + "/state",
          { action: "path-set", path: dir, l1: "", l2: l2Pick, mode: l2Mode },
          "已绑定 " + tailPath(dir) + " → " + l2Pick + "（" + (l2Mode === "replace" ? "替换" : "叠加") + "）",
        );
        if (!r) return;
        setL2Path(dir);
        if (l2Text.trim()) await post(API + "/inject", { profile: l2Pick, text: l2Text, level: "l2" }, "已保存第二层正文 " + l2Pick);
      };
      // 切页：带上可选目标（预设名 / 规则目录），没带就沿用上次的
      const goPage = (p, arg) => {
        setPage(p);
        // 只在"还没加载过正文"时自动拉一次：反复切页不能覆盖正在编辑、还没保存的草稿。
        if (p === "l1") {
          const target = typeof arg === "string" && arg ? arg : "";
          if (target && target !== l1Loaded) loadL1(target);
          else if (!l1Loaded) loadL1(active);
        }
        // 进第二层页时如果还没选预设，自动落到第一份并把正文读进来，
        // 否则下拉一直挂着占位项、编辑框也是空的。（这段必须在普通函数里做：
        // 组件体里 gov 为 null 时会提前 return，那里再多一个 hook 会让 React 抛
        // "Rendered more hooks than during the previous render"，整块设置页变空白。）
        if (p === "l2") {
          const target = typeof arg === "string" && arg ? arg : "";
          if (target) pickRule(target);
          else if (!l2Pick && l2Profiles.length > 0) {
            setL2Pick(l2Profiles[0].name);
            loadL2Text(l2Profiles[0].name);
          }
        }
      };

      // —— 工作区规则表：一行一套配置，点单元格里的下拉即时换，拖动手柄换顺序 ——
      const selCss = Object.assign({}, inputCss, { minWidth: "110px", height: "24px" });
      const dim11 = Object.assign({}, C.dim, { fontSize: "11px" });
      // 下拉选项：本层预设 + 这一行已经在用的那个（防层级标记不一致时把现配置"显示成空"）
      const optsFor = (list, cur) => {
        if (!cur) return list;
        return list.some((p) => p.name === cur) ? list : list.concat([{ name: cur, bytes: 0, level: "" }]);
      };
      const dragFrom = { i: -1 };
      const applyOrder = (from, to) => {
        if (from < 0 || to < 0 || from === to) return;
        const arr = workspaces.map((w) => ({
          path: w.path,
          l1: w.l1 || "",
          l2: w.l2 || "",
          mode: w.mode === "replace" ? "replace" : "append",
        }));
        const moved = arr.splice(from, 1)[0];
        arr.splice(to, 0, moved);
        post(API + "/state", { pathProfiles: arr }, "已调整顺序");
      };
      const wsRows = workspaces.length === 0
        ? [h("div", { key: "ws-empty", style: C.dim }, "还没有工作区规则 —— 所有目录都用当前全局正文")]
        : [
            h("table", { key: "ws-table", style: C.table }, [
              h("thead", null, h("tr", null, [
                h("th", { style: C.th }, ""),
                h("th", { style: C.th }, "工作区"),
                h("th", { style: C.th }, "第一层注入"),
                h("th", { style: C.th }, "第二层注入"),
                h("th", { style: C.th }, "方式"),
                h("th", { style: C.th }, ""),
              ])),
              h(
                "tbody",
                null,
                workspaces.map((w, i) =>
                  h(
                    "tr",
                    {
                      key: w.path,
                      draggable: true,
                      onDragStart: (e) => {
                        dragFrom.i = i;
                        try {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", w.path);
                        } catch {
                          /* 某些浏览器禁止自定义 drag 数据，忽略即可 */
                        }
                      },
                      onDragOver: (e) => e.preventDefault(),
                      onDrop: (e) => {
                        e.preventDefault();
                        applyOrder(dragFrom.i, i);
                        dragFrom.i = -1;
                      },
                      style: { cursor: "grab" },
                    },
                    [
                      h(
                        "td",
                        { style: Object.assign({}, C.td, { cursor: "grab" }), title: "按住这一格拖动可以调顺序" },
                        "⠿",
                      ),
                      h("td", { style: C.td, title: w.path }, [
                        h("span", { style: C.dot(!!w.current) }),
                        " ",
                        h("code", { style: C.mono }, tailPath(w.path)),
                      ]),
                      h("td", { style: C.td }, [
                        h(
                          "select",
                          { style: selCss, value: w.l1 || "", onChange: (e) => setRule(w, { l1: e.target.value }) },
                          [h("option", { value: "", key: "__g", style: optCss }, "跟随全局（" + labelOfProfile(active) + "）")].concat(
                            // 已有引用即使层级标记不符也保留，否则 value 不在 options 里下拉会显示空白、看起来像丢了配置
                            optsFor(l1Profiles, w.l1).map((p) => h("option", { value: p.name, key: p.name, style: optCss }, p.name)),
                          ),
                        ),
                        w.l1 && !w.l1Exists ? h("div", { style: dim11 }, "缺正文 · 回落到包裹模板") : null,
                      ]),
                      h("td", { style: C.td }, [
                        h(
                          "select",
                          { style: selCss, value: w.l2 || "", onChange: (e) => setRule(w, { l2: e.target.value }) },
                          [h("option", { value: "", key: "__n", style: optCss }, defaultL2 ? "（无 · 用默认 " + defaultL2 + "）" : "（无）")].concat(
                            optsFor(l2Profiles, w.l2).map((p) => h("option", { value: p.name, key: p.name, style: optCss }, p.name)),
                          ),
                        ),
                        w.l2 && !w.l2Exists ? h("div", { style: dim11 }, "缺正文 · 这一级会被跳过") : null,
                        l2Profiles.length === 0 ? h("div", { style: dim11 }, "还没有第二层预设 → 去「第二层」页新建") : null,
                      ]),
                      h("td", { style: C.td }, [
                        h(
                          "select",
                          {
                            style: Object.assign({}, selCss, { width: "86px" }),
                            value: w.mode === "replace" ? "replace" : "append",
                            onChange: (e) => setRule(w, { mode: e.target.value }),
                          },
                          [h("option", { value: "append", style: optCss }, "叠加"), h("option", { value: "replace", style: optCss }, "替换")],
                        ),
                      ]),
                      h("td", { style: C.td }, [
                        smallBtn(
                          "删除",
                          () => post(API + "/state", { action: "path-rule-remove", path: w.path }, "已删除：" + tailPath(w.path)),
                          !!busy,
                        ),
                      ]),
                    ],
                  ),
                ),
              ),
            ]),
          ];

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
              h("td", { style: C.td }, [
                h("span", null, "L1 " + (r.l1 || labelOfProfile(r.profile || active))),
                r.l2 ? h("span", null, " / L2 " + r.l2 + (r.mode === "replace" ? "（替）" : "")) : h("span", { style: C.dim }, " / 无 L2"),
              ]),
              h("td", { style: C.td }, String(r.count) + " / " + String(r.applied)),
              h("td", { style: C.td }, shortTime(r.last)),
              h("td", { style: C.td },
                r.listed
                  ? smallBtn("恢复注入", () => post(API + "/state", { action: "session-remove", sessionId: r.id }, "已恢复注入"))
                  : smallBtn("排除此会话", () => post(API + "/state", { action: "session-add", sessionId: r.id }, "已排除")),
              ),
            ]),
          )
        : [h("tr", { key: "none" }, h("td", { style: C.td, colSpan: 7 }, "本进程还没有装配记录（发一条消息就会出现在这里）"))];

      // —— 页面导航 ——
      const tabBtn = (label, target) =>
        h(
          "button",
          {
            key: target,
            style: Object.assign(
              {},
              C.btn,
              page === target
                ? { fontWeight: 600, boxShadow: "inset 0 -2px 0 var(--dsw-alias-brand-primary, #4a90d9)" }
                : { opacity: 0.7 },
            ),
            onClick: () => goPage(target),
          },
          label,
        );
      const navRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } }, [
        tabBtn("概览", "home"),
        tabBtn("第一层", "l1"),
        tabBtn("第二层", "l2"),
        h("span", { style: dim11 }, "生效 " + active + " · 工作区规则 " + String(workspaces.length) + " 条"),
      ]);

      // —— 操作反馈条：成功绿 / 失败红 / 进行中灰。挂在导航下面，
      // 不用滚到页面底部才看得见——这是"点了保存没反应"的直接原因之一。
      const msgBar = msg
        ? h(
            "div",
            {
              style: {
                padding: "6px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: msg.startsWith("❌") ? 600 : 400,
                color: msg.startsWith("❌") ? "#c0392b" : msg.startsWith("✅") ? "#1f8a4c" : "inherit",
                background: msg.startsWith("❌")
                  ? "rgba(214,80,80,.12)"
                  : msg.startsWith("✅")
                    ? "rgba(48,164,108,.12)"
                    : "rgba(128,128,128,.12)",
              },
            },
            msg,
          )
        : null;

      // —— 第一层页：直接写全局正文；预设退化成可选模板 ——
      const l1Target = l1Name || active;
      const l1Page = [
        h("div", { key: "l1-edit", style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "第一层 · 全局提示词"),
          h(
            "div",
            { style: Object.assign({}, dim11, { marginBottom: "6px" }) },
            "所有对话共用的底稿；预设当模板用，也可以直接写一份新的。",
          ),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" } }, [
            h("span", { style: dim11 }, "编辑预设"),
            h(
              "select",
              {
                style: Object.assign({}, inputCss, { flex: "0 1 200px", minWidth: "150px" }),
                value: l1Target,
                onChange: (e) => loadL1(e.target.value),
              },
              l1Profiles.map((p) => h("option", { value: p.name, key: p.name, style: optCss }, p.name + (p.name === active ? "（生效中）" : ""))),
            ),
            l1Target === active
              ? h("span", { style: dim11 }, "当前生效")
              : smallBtn("设为全局生效", () => post(API + "/profiles", { action: "activate", name: l1Target }, "已切到 " + l1Target), !!busy),
            smallBtn("重新读取", () => loadL1(l1Target), !!busy),
          ]),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" } }, [
            h("input", {
              style: Object.assign({}, inputCss, { flex: "0 1 200px", minWidth: "150px" }),
              placeholder: "新预设名（字母数字 . _ -）",
              value: blankName,
              onChange: (e) => setBlankName(e.target.value),
            }),
            smallBtn(
              "新建空白预设",
              async () => {
                const nm = blankName.trim();
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nm)) {
                  setMsg("❌ 预设名要字母或数字开头，可含 . _ -，最长 64 字符");
                  return;
                }
                if (l1Profiles.some((p) => p.name === nm)) {
                  setMsg("❌ 第一层已经有叫 " + nm + " 的预设，直接在上面下拉里选它");
                  return;
                }
                const created = await post(API + "/profiles", { action: "create", name: nm, from: "", level: "l1" }, "已新建空白预设 " + nm);
                if (!created) return;
                setBlankName("");
                setL1Name(nm);
                setL1Text("");
                setL1Loaded(nm);
              },
              !!busy,
            ),
            h("span", { style: dim11 }, "建好自动切到它，正文留空等你写"),
          ]),
          h("textarea", {
            style: Object.assign({}, areaCss, { minHeight: "320px" }),
            rows: 22,
            value: l1Text,
            onChange: (e) => setL1Text(e.target.value),
          }),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" } }, [
            smallBtn(
              "保存第一层正文",
              () => {
                if (!l1Text.trim()) {
                  setMsg("❌ 正文是空的——先写内容，或先用上面的下拉选一个预设把正文带进来");
                  return;
                }
                post(API + "/inject", { profile: l1Target, text: l1Text, level: "l1" }, "已保存 " + l1Target);
              },
              !!busy,
            ),
            h("span", { style: dim11 }, l1Text.length ? l1Text.length + " 字符 · 写向预设 " + l1Target : "正文为空 · 这一级会被跳过"),
          ]),
          h(
            "div",
            { style: Object.assign({}, dim11, { marginTop: "6px" }) },
            "第一层审查：" +
              (l1Target === active ? "正在全局生效" : "未生效（当前生效的是 " + active + "，点上面的「设为全局生效」切过去）") +
              " · 被 " +
              String(workspaces.filter((w) => w.l1 === l1Target).length) +
              " 条工作区规则当作第一级引用",
          ),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "10px" } }, [
            h("input", {
              style: inputCss,
              placeholder: "新预设名（字母数字 . _ -）",
              value: newName,
              onChange: (e) => setNewName(e.target.value),
            }),
            smallBtn(
              "把当前正文另存为新预设",
              async () => {
                const nm = newName.trim();
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nm)) {
                  setMsg("❌ 先在右边输入框里填预设名：字母或数字开头，可含 . _ -，最长 64 字符");
                  return;
                }
                if (!l1Text.trim()) {
                  setMsg("❌ 正文是空的，先写内容再另存");
                  return;
                }
                if (!l1Profiles.some((p) => p.name === nm)) {
                  const created = await post(API + "/profiles", { action: "create", name: nm, from: "", level: "l1" }, "已创建预设 " + nm);
                  if (!created) return;
                }
                const wrote = await post(API + "/inject", { profile: nm, text: l1Text, level: "l1" }, "已另存为 " + nm);
                if (wrote) {
                  setNewName("");
                  setL1Name(nm);
                  setL1Loaded(nm);
                }
              },
              !!busy,
            ),
          ]),
        ]),
        h("div", { key: "l1-list", style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "预设管理"),
          h(
            "div",
            { style: Object.assign({}, dim11, { marginBottom: "6px" }) },
            "只列第一层预设（可与第二层同名）。删掉正在生效的会回落到 default。",
          ),
          h("table", { style: C.table }, [
            h("thead", null, h("tr", null, [
              h("th", { style: C.th }, "预设"),
              h("th", { style: C.th }, "体积"),
              h("th", { style: C.th }, "行数"),
              h("th", { style: C.th }, "操作"),
            ])),
            h("tbody", null, profileRowsFor(l1Profiles, "l1")),
          ]),
        ]),
      ];

      // —— 第二层页：这一层的编写与审查都在本页完成 ——
      // —— 第二层页：只写第二层正文。这一页不认识"工作区"，目录绑定在概览页的下拉里做 ——
      const l2Users = (name) => workspaces.filter((w) => w.l2 === name).map((w) => tailPath(w.path));
      const l2Page = [
        h("div", { key: "l2-write", style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "第二层 · 工作区提示词（编写）"),
          h(
            "div",
            { style: Object.assign({}, dim11, { marginBottom: "6px" }) },
            "叠在第一层之后的工作区层；哪个目录用它，去概览页选。",
          ),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" } }, [
            h("span", { style: dim11 }, "编辑预设"),
            h(
              "select",
              {
                style: Object.assign({}, inputCss, { flex: "0 1 220px", minWidth: "160px" }),
                value: l2Pick || (l2Profiles.length ? l2Profiles[0].name : ""),
                onChange: (e) => {
                  const v = e.target.value;
                  setL2Pick(v);
                  if (v) loadL2Text(v);
                  else setL2Text("");
                },
              },
              [h("option", { value: "", key: "__x", style: optCss }, l2Profiles.length ? "（选择第二层预设）" : "（还没有第二层预设，先在下面新建）")].concat(
                optsFor(l2Profiles, l2Pick).map((p) => h("option", { value: p.name, key: p.path || p.name, style: optCss }, p.name)),
              ),
            ),
            smallBtn(
              "重新读取",
              () => {
                if (!l2Pick) {
                  setMsg("❌ 先选一个第二层预设");
                  return;
                }
                loadL2Text(l2Pick);
              },
              !!busy,
            ),
          ]),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" } }, [
            h("input", {
              style: Object.assign({}, inputCss, { flex: "0 1 200px", minWidth: "150px" }),
              placeholder: "新第二层预设名（字母数字 . _ -）",
              value: blankName,
              onChange: (e) => setBlankName(e.target.value),
            }),
            smallBtn(
              "新建空白预设",
              async () => {
                const nm = blankName.trim();
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nm)) {
                  setMsg("❌ 预设名要字母或数字开头，可含 . _ -，最长 64 字符");
                  return;
                }
                if (l2Profiles.some((p) => p.name === nm)) {
                  setMsg("❌ 第二层已有叫 " + nm + " 的预设，直接在上面的下拉里选它");
                  return;
                }
                const created = await post(
                  API + "/profiles",
                  { action: "create", name: nm, from: "", level: "l2" },
                  "已新建第二层预设 " + nm,
                );
                if (!created) return;
                setBlankName("");
                setL2Pick(nm);
                setL2Text("");
              },
              !!busy,
            ),
            h("span", { style: dim11 }, "建好自动切到它，正文留空等你写"),
          ]),
          h("textarea", {
            style: Object.assign({}, areaCss, { minHeight: "260px" }),
            rows: 18,
            value: l2Text,
            placeholder: l2Pick ? "" : "先在上面选一个第二层预设，或新建一个",
            onChange: (e) => setL2Text(e.target.value),
          }),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" } }, [
            smallBtn(
              "保存第二层正文",
              () => {
                if (!l2Pick) {
                  setMsg("❌ 先选一个第二层预设再保存");
                  return;
                }
                if (!l2Text.trim()) {
                  setMsg("❌ 正文是空的——这样这一级会被跳过；真要清空就直接删预设");
                  return;
                }
                post(API + "/inject", { profile: l2Pick, text: l2Text, level: "l2" }, "已保存 " + l2Pick);
              },
              !!busy,
            ),
            h("span", { style: dim11 }, !l2Pick ? "还没选预设" : l2Text.length ? l2Text.length + " 字符 · 写向预设 " + l2Pick : "正文为空 · 这一级会被跳过"),
          ]),
          h(
            "div",
            { style: Object.assign({}, dim11, { marginTop: "6px" }) },
            !l2Pick
              ? "第二层审查：还没选预设"
              : l2Users(l2Pick).length === 0
                ? "第二层审查：目前没有任何工作区引用「" + l2Pick + "」—— 去概览页给它挂一个目录才会生效"
                : "第二层审查：「" + l2Pick + "」被 " + String(l2Users(l2Pick).length) + " 条工作区规则引用（" + l2Users(l2Pick).join("、") + "）",
          ),
        ]),
        h("div", { key: "l2-list", style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "第二层预设管理"),
          h(
            "div",
            { style: Object.assign({}, dim11, { marginBottom: "6px" }) },
            "默认那份会挂到所有没单配规则的对话上；可以先建空槽位、之后再填正文。",
          ),
          l2Profiles.length === 0
            ? h("div", { style: C.dim }, "还没有第二层预设 —— 上面「新建空白预设」建一个就行")
            : h("table", { style: C.table }, [
                h("thead", null, h("tr", null, [
                  h("th", { style: C.th }, "预设"),
                  h("th", { style: C.th }, "体积"),
                  h("th", { style: C.th }, "操作"),
                ])),
                h("tbody", null, profileRowsFor(l2Profiles, "l2")),
              ]),
        ]),
      ];

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
          line(
            "两级注入",
            h(
              "span",
              null,
              "第一级 " + labelOfProfile(active) + " · 第二级 " + String(workspaces.length) + " 条目录规则" +
                (defaultL2 ? " · 默认 " + defaultL2 : "") +
                (l2Profiles.length ? "" : " · 还没有第二层预设"),
            ),
          ),
        ]),
        navRow,
        msgBar,

        ...(page === "home" ? [
        // 工作区规则：一行 = 工作区 + 第一级预设 + 第二级预设，两级都只选不写；正文在「第一层」「第二层」页写
        h("div", { style: C.card }, [
          h(
            "div",
            {
              style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" },
              onClick: () => setWsOpen(!wsOpen),
            },
            [
              h("span", { style: { fontWeight: 600 } }, "两级注入规则（按工作目录）"),
              h(
                "span",
                { style: Object.assign({}, C.dim, { fontSize: "11px" }) },
                String(workspaces.length) + " 条 · " + (wsOpen ? "点击折叠" : "点击展开"),
              ),
              h("span", { style: { marginLeft: "auto", fontSize: "12px" } }, wsOpen ? "▾" : "▸"),
            ],
          ),
          h(
            "div",
            { style: Object.assign({}, C.dim, { fontSize: "11px", marginBottom: "6px" }) },
            "第一级＝这个目录用的全局正文（留空跟随全局），第二级＝叠加/替换它的工作区层；这里只选预设，正文到「第一层」「第二层」页写。",
          ),
          ...(wsOpen
            ? [
                ...wsRows,
                h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "10px" } }, [
                  h("input", {
                    style: inputCss,
                    placeholder: "工作目录，如 E:/dsh测试",
                    value: wpPath,
                    onChange: (e) => setWpPath(e.target.value),
                  }),
                  h(
                    "select",
                    { style: selCss, value: wpL1, onChange: (e) => setWpL1(e.target.value) },
                    [h("option", { value: "", key: "__g", style: optCss }, "第一级：跟随全局（" + labelOfProfile(active) + "）")].concat(
                      l1Profiles.map((x) => h("option", { value: x.name, key: x.name, style: optCss }, "第一级：" + x.name)),
                    ),
                  ),
                  h(
                    "select",
                    { style: selCss, value: wpL2, onChange: (e) => setWpL2(e.target.value) },
                    [h("option", { value: "", key: "__n", style: optCss }, defaultL2 ? "第二级：（用默认 " + defaultL2 + "）" : "第二级：（无）")].concat(
                      l2Profiles.map((x) => h("option", { value: x.name, key: x.name, style: optCss }, "第二级：" + x.name)),
                    ),
                  ),
                  h(
                    "select",
                    { style: Object.assign({}, selCss, { minWidth: "86px" }), value: wpMode, onChange: (e) => setWpMode(e.target.value) },
                    [h("option", { value: "append", style: optCss }, "叠加"), h("option", { value: "replace", style: optCss }, "替换")],
                  ),
                  smallBtn("添加", addRule, !!busy || !wpPath.trim()),
                  l2Profiles.length === 0
                    ? h("span", { style: Object.assign({}, C.dim, { fontSize: "11px" }) }, "（第二级预设去「第二层」页新建）")
                    : null,
                ]),
              ]
            : []),
        ]),

        // 生效范围：默认全部注入，只维护「不注入」的名单
        h("div", { style: C.card }, [
          h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "生效范围（默认全部注入）"),
          h(
            "div",
            { style: Object.assign({}, C.dim, { fontSize: "11px", marginBottom: "6px" }) },
            "这里只维护「不注入」的地方——目录排除对目录下所有会话（含以后新开的）生效。",
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
            "只影响单个对话；新对话 id 会变，日常用上面的目录排除。",
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
                h("th", { style: C.th }, "生效层级"),
                h("th", { style: C.th }, "装配/注入"),
                h("th", { style: C.th }, "最近"),
                h("th", { style: C.th }, "操作"),
              ])),
              h("tbody", null, recentRows),
            ]),
          ]),
        ]),

        ] : []),
        ...(page === "l1" ? l1Page : []),
        ...(page === "l2" ? l2Page : []),
      ]);
    }

    /** 设置页分区容器：只负责渲染自己的子槽（范式同 dsh-undo-savepoint）。 */
    function FrameSettingsSection(props) {
      const renderSlot = props && typeof props.renderSlot === "function" ? props.renderSlot : null;
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
        h(
          "div",
          { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" } },
          "默认对所有工作区注入。只对需要原生提示词的工作区做排除。",
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
