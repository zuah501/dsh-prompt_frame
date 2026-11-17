// 指示灯判定（buildStatus.lastDecision）单元测试：预判 / 两级 / 默认第二层 / 排除 / replace
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStatus } from "../lib/console.js";
import { writeState } from "../lib/state.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "badge-"));
const profilesDir = path.join(tmp, "profiles");
fs.mkdirSync(profilesDir, { recursive: true });
const ws = path.join(tmp, "ws");
const other = path.join(tmp, "other");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(other, { recursive: true });
const paths = {
  home: tmp,
  injectFile: path.join(tmp, "inject.md"),
  profilesDir,
  logFile: path.join(tmp, "x.log"),
  offFlag: path.join(tmp, "x.off"),
  assetPath: path.join(tmp, "asset.md"),
};
fs.writeFileSync(paths.injectFile, "DEFAULT BODY\n");
fs.writeFileSync(path.join(profilesDir, "g1.md"), "G1\n");
fs.writeFileSync(path.join(profilesDir, "w1.md"), "W1\n");
fs.writeFileSync(path.join(profilesDir, "l2~w2.md"), "W2\n");
const cfg = { enabled: true, logMaxLines: 200, disabledStages: [] };

let pass = 0;
let fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log("PASS " + name); }
  else { fail += 1; console.log("FAIL " + name + (detail === undefined ? "" : " -> " + JSON.stringify(detail))); }
};
const st = (patch) => writeState(tmp, patch);
const run = (handler) => buildStatus({ cfg, paths, handler, registered: true });

st({ activeProfile: "g1", pathProfiles: [{ path: ws, l1: "w1", l2: "w2", mode: "append" }] });
let s = await run({ stats: {}, procWorkspaceRoot: ws });
t("A1 无装配记录也亮灯", s.state.effective === true, s.state.effective);
t("A2 预判 L1", s.state.lastDecision.l1 === "w1", s.state.lastDecision.l1);
t("A3 预判 L2", s.state.lastDecision.l2 === "w2", s.state.lastDecision.l2);
t("A4 预判标记为 preview", s.state.lastDecision.preview === true, s.state.lastDecision.preview);
t("A5 预判 cwd 取工作区根", s.state.lastDecision.cwd === ws, s.state.lastDecision.cwd);

s = await run({ stats: { lastCwd: ws, lastSessionId: "s1" }, procWorkspaceRoot: other });
t("B1 有装配记录时 preview=false", s.state.lastDecision.preview === false);
t("B2 用装配记录的 cwd，不用工作区根", s.state.lastDecision.cwd === ws);

st({ activeProfile: "g1", pathProfiles: [], defaultL2: "w2" });
s = await run({ stats: {}, procWorkspaceRoot: other });
t("C1 无规则时默认第二层兜底", s.state.lastDecision.l2 === "w2" && s.state.lastDecision.l1 === "g1", s.state.lastDecision);

st({ activeProfile: "g1", excludePaths: [other], defaultL2: "" });
s = await run({ stats: {}, procWorkspaceRoot: other });
t("D1 排除目录 → effective=false", s.state.lastDecision.effective === false, s.state.lastDecision);

st({ activeProfile: "g1", excludePaths: [], pathProfiles: [{ path: ws, l1: "w1", l2: "w2", mode: "replace" }] });
s = await run({ stats: {}, procWorkspaceRoot: ws });
t("E1 replace 模式透传", s.state.lastDecision.mode === "replace", s.state.lastDecision.mode);

st({ enabled: false });
console.log(fail === 0 ? "ALL PASS (" + pass + ")" : "FAILED " + fail + "/" + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
