import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeInjectText } from "../lib/core-logic.js";
import { normalizeState, resolveProfileForCwd } from "../lib/state.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-v2-"));
const profilesDir = path.join(root, "profiles");
fs.mkdirSync(profilesDir, { recursive: true });
const injectFile = path.join(root, "prompt-inject.md");
const write = (file, text) => fs.writeFileSync(file, text, "utf8");

const paths = { home: root, injectFile, profilesDir };
const cfg = (extra = "") => ({ cacheInjectText: true, extra });
// 两级 scope 的简写：l1 空 = 跟随 activeProfile
const sc = (l1, l2, mode = "append") => ({ l1, l2, mode, rule: "x" });

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (ok) pass += 1;
  else { fail += 1; console.log("FAIL " + name + "\n  got : " + JSON.stringify(got) + "\n  want: " + JSON.stringify(want)); }
};

// ---- 无工作区层：行为必须与 1.5.x 逐字一致 ----
write(injectFile, "L1 base");
eq("t1 无工作区层", composeInjectText(paths, cfg(), "default", null).text, "L1 base");
eq("t1 source", composeInjectText(paths, cfg(), "default", null).source, "file");

// ---- 只有 L2：append ----
write(path.join(profilesDir, "comfy.md"), "L2 comfy");
const s2 = composeInjectText(paths, cfg(), "default", sc("", "comfy"));
eq("t2 append 拼接", s2.text, "L1 base\n\nL2 comfy");
eq("t2 source", s2.source, "layers");
eq("t2 层数", s2.layers.length, 2);
eq("t2 层顺序", s2.layers.map((l) => l.role).join(","), "global,workspace");

// ---- 只有 L2：replace ----
const s3 = composeInjectText(paths, cfg(), "default", sc("", "comfy", "replace"));
eq("t3 replace 只用工作区层", s3.text, "L2 comfy");
eq("t3 source", s3.source, "workspace");

// ---- replace 但 L2 文件不存在 → 回落 L1，不能变空 ----
const s4 = composeInjectText(paths, cfg(), "default", sc("", "ghost", "replace"));
eq("t4 replace 缺文件回落", s4.text, "L1 base");
eq("t4 source", s4.source, "file");

// ---- L2 与 L1 同名 → 不重复叠加 ----
const s4b = composeInjectText(paths, cfg(), "default", sc("", "default"));
eq("t4b 同名不叠两次", s4b.text, "L1 base");

// ---- extra 只追加一次且在最后 ----
const s5 = composeInjectText(paths, cfg("EXTRA"), "default", sc("", "comfy"));
eq("t5 extra 在最末", s5.text, "L1 base\n\nL2 comfy\n\nEXTRA");
eq("t5 extra 只一次", s5.text.split("EXTRA").length - 1, 1);

// ---- L1 文件不存在时仍走 assets 回落（原有行为） ----
const paths2 = { home: root, injectFile: path.join(root, "nope.md"), profilesDir };
const s6 = composeInjectText(paths2, cfg(), "default", null);
eq("t6 全局层回落 asset", s6.source, "asset");

// ---- v2 两级：L1 可被工作区规则换成另一个预设 ----
write(path.join(profilesDir, "strict.md"), "L1 strict");
const s10 = composeInjectText(paths, cfg(), "default", sc("strict", ""));
eq("t10 l1 覆盖全局层", s10.text, "L1 strict");
eq("t10 只有一层", s10.layers.length, 1);
eq("t10 层名", s10.layers[0].name, "strict");

const s11 = composeInjectText(paths, cfg(), "default", sc("strict", "comfy"));
eq("t11 l1+l2 拼接", s11.text, "L1 strict\n\nL2 comfy");
eq("t11 层顺序", s11.layers.map((l) => l.name).join(","), "strict,comfy");

const s12 = composeInjectText(paths, cfg(), "default", sc("comfy", "comfy"));
eq("t12 两级同名只注入一次", s12.text, "L2 comfy");
eq("t12 单层", s12.layers.length, 1);

const s13 = composeInjectText(paths, cfg(), "default", sc("strict", "comfy", "replace"));
eq("t13 replace 仍只用 l2", s13.text, "L2 comfy");
eq("t13 source", s13.source, "workspace");

// ---- 最长前缀优先 + 老数据兼容 ----
const st = normalizeState({
  activeProfile: "default",
  pathProfiles: [
    { path: "D:\\a", profile: "wide", mode: "append" },
    { path: "D:\\a\\b", profile: "narrow", mode: "replace" },
    { path: "D:\\a\\b\\c", profile: "bad name!", mode: "append" },
    { path: "", profile: "empty", mode: "append" },
    { path: "D:\\a", profile: "wide", mode: "append" },
  ],
});
eq("t7 非法条目被丢弃", st.pathProfiles.length, 2);
eq("t7 老条目折叠为 l2", st.pathProfiles.map((p) => p.l2).join(","), "wide,narrow");
eq("t7 l1 为空表示跟随全局", st.pathProfiles[0].l1, "");
eq("t8 命中父目录", resolveProfileForCwd(st, "D:\\a\\x")?.l2, "wide");
eq("t8 命中子目录（最长优先）", resolveProfileForCwd(st, "D:\\a\\b\\c\\d")?.l2, "narrow");
eq("t8 大小写不敏感", resolveProfileForCwd(st, "d:\\A\\B")?.l2, "narrow");
eq("t8 不命中", resolveProfileForCwd(st, "D:\\other"), null);
eq("t8 cwd 为空", resolveProfileForCwd(st, null), null);

const st2 = normalizeState({
  activeProfile: "default",
  pathProfiles: [
    { path: "D:\\v2", l1: "strict", l2: "comfy", mode: "append" },
    { path: "D:\\l1only", l1: "strict", l2: "", mode: "append" },
    { path: "D:\\none", l1: "", l2: "", mode: "append" },
    { path: "D:\\badl1", l1: "bad name!", l2: "comfy", mode: "append" },
    { path: "D:\\badmode", l1: "", l2: "comfy", mode: "merge" },
  ],
});
eq("t14 新格式保留两级", st2.pathProfiles[0].l1 + "/" + st2.pathProfiles[0].l2, "strict/comfy");
eq("t14 只写 l1 的条目保留", st2.pathProfiles[1].l1 + "|" + st2.pathProfiles[1].l2, "strict|");
eq("t14 两级全空被丢弃", st2.pathProfiles.length, 3);
eq("t15 非法 l1 整条丢弃", st2.pathProfiles.some((p) => p.path === "D:\\badl1"), false);
eq("t15 未知 mode 归一为 append", st2.pathProfiles[2].mode, "append");
eq("t16 resolve 带出 l1", resolveProfileForCwd(st2, "D:\\v2\\x")?.l1, "strict");

// ---- 空正文 + 无层 → 全局层缺失回落模板 ----
const s9 = composeInjectText({ home: root, injectFile: path.join(root, "none.md"), profilesDir: path.join(root, "nodir") }, cfg(), "default", null);
eq("t9 全局缺失回落模板", s9.source, "asset");
eq("t9 模板非空", s9.text.trim().length > 0, true);

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "ALL PASS (" + pass + ")" : "PASS " + pass + " / FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);
