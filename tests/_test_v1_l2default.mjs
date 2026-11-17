// 第二层命名空间、默认第二层兜底、空规则丢弃的单元测试。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeInjectText } from "../lib/core-logic.js";
import { listProfiles, normalizeState, resolveProfileFile, resolveScope, writeProfile } from "../lib/state.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-l2-"));
const profilesDir = path.join(root, "profiles");
fs.mkdirSync(profilesDir, { recursive: true });
const injectFile = path.join(root, "prompt-inject.md");
const write = (file, text) => fs.writeFileSync(file, text, "utf8");

const paths = { home: root, injectFile, profilesDir };
const cfg = () => ({ cacheInjectText: true, extra: "" });

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else { fail += 1; console.log("FAIL " + name + "\n  got : " + JSON.stringify(got) + "\n  want: " + JSON.stringify(want)); }
};

write(injectFile, "L1 base");

// ---- t1/t2 defaultL2 清洗 ----
eq("t1 合法 defaultL2 保留", normalizeState({ defaultL2: "memo" }).defaultL2, "memo");
eq("t2 非法 defaultL2 归零", normalizeState({ defaultL2: "../etc" }).defaultL2, "");
eq("t2b 非字符串归零", normalizeState({ defaultL2: 42 }).defaultL2, "");

// ---- t3 两级都空的规则被丢弃 ----
const st = normalizeState({ pathProfiles: [{ path: "D:/a", l1: "", l2: "", mode: "append" }] });
eq("t3 两级全空规则被丢弃", st.pathProfiles.length, 0);
const st2 = normalizeState({ pathProfiles: [{ path: "D:/a", l2: "x", mode: "append" }] });
eq("t3b 只有 l2 的规则保留", st2.pathProfiles.length, 1);

// ---- t4/t5/t6 两层的文件命名空间 ----
write(path.join(profilesDir, "1.md"), "L1 one");
write(path.join(profilesDir, "l2~1.md"), "L2 one");
eq("t4 l2 优先读 l2~ 前缀", resolveProfileFile("1", paths, "l2"), path.join(profilesDir, "l2~1.md"));
eq("t4b l1 读不带前缀", resolveProfileFile("1", paths, "l1"), path.join(profilesDir, "1.md"));
fs.rmSync(path.join(profilesDir, "l2~1.md"));
eq("t5 没有前缀文件时回落老文件", resolveProfileFile("1", paths, "l2"), path.join(profilesDir, "1.md"));
write(path.join(profilesDir, "l2~2.md"), "L2 two");
eq("t6 l1 解析不受 l2~ 影响", resolveProfileFile("2", paths, "l1"), path.join(profilesDir, "2.md"));

// ---- t7 同名两层并存 ----
write(path.join(profilesDir, "l2~1.md"), "L2 one");
const list = listProfiles(paths);
const ones = list.filter((p) => p.name === "1").map((p) => p.level).sort();
eq("t7 同名 l1/l2 并存", ones, ["l1", "l2"]);

// ---- t8/t9/t10/t11 resolveScope ----
const stNoRule = normalizeState({ defaultL2: "memo" });
eq("t8 无规则用默认第二层", resolveScope(stNoRule, "D:/a"), { l1: "", l2: "memo", mode: "append", rule: "default-l2" });
const stRuleNoL2 = normalizeState({ defaultL2: "memo", pathProfiles: [{ path: "D:/a", l1: "sel", l2: "", mode: "append" }] });
const sc9 = resolveScope(stRuleNoL2, "D:/a");
eq("t9 规则没 l2 时补默认第二层", [sc9.l1, sc9.l2, sc9.mode], ["sel", "memo", "append"]);
const stRuleL2 = normalizeState({ defaultL2: "memo", pathProfiles: [{ path: "D:/a", l2: "own", mode: "replace" }] });
const sc10 = resolveScope(stRuleL2, "D:/a");
eq("t10 规则自带 l2 不被覆盖", [sc10.l1, sc10.l2, sc10.mode], ["", "own", "replace"]);
eq("t11 没默认第二层也没规则", resolveScope(normalizeState({}), "D:/a"), null);

// ---- t12 默认第二层真的叠进正文 ----
write(path.join(profilesDir, "l2~memo.md"), "MEMO");
const sc = resolveScope(stNoRule, "D:/a");
eq("t12 默认第二层参与拼接", composeInjectText(paths, cfg(), "default", sc).text, "L1 base\n\nMEMO");

// ---- t13 writeProfile 按层落不同文件 ----
writeProfile("1", paths, "L2 new", "l2");
eq("t13 l2 写入带前缀文件", fs.readFileSync(path.join(profilesDir, "l2~1.md"), "utf8"), "L2 new");
eq("t13b l1 文件没被动", fs.readFileSync(path.join(profilesDir, "1.md"), "utf8"), "L1 one");

// ---- t14 第一层已有同名预设时，第二层仍能独立建、且不覆盖第一层 ----
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "pf-same-"));
const dir2 = path.join(root2, "profiles");
fs.mkdirSync(dir2, { recursive: true });
const paths2 = { home: root2, injectFile: path.join(root2, "prompt-inject.md"), profilesDir: dir2 };
writeProfile("1", paths2, "L1 OWN", "l1");
writeProfile("1", paths2, "L2 OWN", "l2");
eq("t14 第二层写进带前缀文件", fs.readFileSync(path.join(dir2, "l2~1.md"), "utf8"), "L2 OWN");
eq("t14b 第一层正文没被覆盖", fs.readFileSync(path.join(dir2, "1.md"), "utf8"), "L1 OWN");
eq("t14c 两行同名不同层", listProfiles(paths2).filter((p) => p.name === "1").map((p) => p.level).sort(), ["l1", "l2"]);
fs.rmSync(path.join(dir2, "l2~1.md"));
writeProfile("1", paths2, "L1 OWN 2", "l1");
eq("t14d 写第一层不碰第二层", fs.existsSync(path.join(dir2, "l2~1.md")), false);

// ---- t15 删第二层不能连带删掉同名第一层 ----
writeProfile("1", paths2, "L2 OWN", "l2");
const { deleteProfile } = await import("../lib/state.js");
deleteProfile("1", paths2, "l2");
eq("t15 删第二层后第一层还在", fs.existsSync(path.join(dir2, "1.md")), true);
eq("t15b 第二层文件已删", fs.existsSync(path.join(dir2, "l2~1.md")), false);

fs.rmSync(root2, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log((fail === 0 ? "ALL PASS" : "FAILED " + fail) + " (" + pass + " checks)");
process.exit(fail === 0 ? 0 : 1);
