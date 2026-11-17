import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHandler } from "../lib/core-logic.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-e2e-"));
const home = path.join(root, "dsh");
fs.mkdirSync(path.join(home, "dsh-prompt-frame", "profiles"), { recursive: true });
process.env.DSH_HOME = home;

fs.writeFileSync(path.join(home, "prompt-inject.md"), "L1GLOBALMARK 全局协议正文", "utf8");
fs.writeFileSync(path.join(home, "dsh-prompt-frame", "profiles", "comfy.md"), "L2COMFYMARK 绘画区协议正文", "utf8");
fs.writeFileSync(
  path.join(home, "dsh-prompt-frame-state.json"),
  JSON.stringify({ activeProfile: "default", pathProfiles: [{ path: "D:\\demo\\comfyarea", profile: "comfy", mode: "append" }] }),
  "utf8",
);

const logFile = path.join(root, "log.jsonl");
const handler = createHandler(
  { injectFile: path.join(home, "prompt-inject.md"), logFile, stagesDir: path.join(root, "stages") },
  {},
);

const mkAssembly = () => ({
  sections: [
    { name: "harness:identity", text: "You are an AI agent powered by DeepSeek Harness. 你是一个有帮助的软件工程师助手。" },
    { name: "workspace:baseline", text: "AGENTS BASELINE MARK" },
    { name: "tool:shell", text: "SHELLTOOLMARK" },
  ],
});
const ctx = (cwd) => ({ agent: { id: "s1", session: { id: "s1", cwd } } });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) pass += 1;
  else { fail += 1; console.log("FAIL " + name + " " + extra); }
};

const run = async (cwd) => {
  const out = await handler(mkAssembly(), ctx(cwd), async () => mkAssembly());
  return JSON.stringify(out);
};

// 1) 命中工作区层：全局与工作区正文都在，且工作区层在后
const hit = await run("D:\\demo\\comfyarea\\proj");
ok("e2e 命中含 L1", hit.includes("L1GLOBALMARK"), hit.slice(0, 200));
ok("e2e 命中含 L2", hit.includes("L2COMFYMARK"));
ok("e2e L2 在 L1 之后", hit.indexOf("L2COMFYMARK") > hit.indexOf("L1GLOBALMARK"));
ok("e2e 官方人格被剥", !hit.includes("powered by DeepSeek Harness"));
ok("e2e 基线被剥", !hit.includes("AGENTS BASELINE MARK"));
ok("e2e 其他段保留", hit.includes("SHELLTOOLMARK"));

// 2) 不命中：只有 L1
const miss = await run("D:\\demo\\otherplace");
ok("e2e 未命中无 L2", !miss.includes("L2COMFYMARK"));
ok("e2e 未命中仍有 L1", miss.includes("L1GLOBALMARK"));

// 3) 排除优先：同目录写进 excludePaths，连 L1 都没有
fs.writeFileSync(
  path.join(home, "dsh-prompt-frame-state.json"),
  JSON.stringify({
    activeProfile: "default",
    excludePaths: ["D:\\demo\\comfyarea"],
    pathProfiles: [{ path: "D:\\demo\\comfyarea", profile: "comfy", mode: "append" }],
  }),
  "utf8",
);
const excluded = await run("D:\\demo\\comfyarea\\proj");
ok("e2e 排除优先", !excluded.includes("L1GLOBALMARK") && !excluded.includes("L2COMFYMARK"));

// 4) replace 模式：只剩 L2
fs.writeFileSync(
  path.join(home, "dsh-prompt-frame-state.json"),
  JSON.stringify({ activeProfile: "default", pathProfiles: [{ path: "D:\\demo\\comfyarea", profile: "comfy", mode: "replace" }] }),
  "utf8",
);
const replaced = await run("D:\\demo\\comfyarea");
ok("e2e replace 有 L2", replaced.includes("L2COMFYMARK"));
ok("e2e replace 无 L1", !replaced.includes("L1GLOBALMARK"));

// 日志核对：最近一条应带 workspaceProfile
const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((x) => JSON.parse(x));
const last = lines[lines.length - 1];
ok("e2e 日志 workspaceL2", last.workspaceL2 === "comfy", JSON.stringify(last));
ok("e2e 日志 workspaceMode", last.workspaceMode === "replace");
ok("e2e 日志 applied", last.applied === true);

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "ALL PASS (" + pass + ")" : "PASS " + pass + " / FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);
