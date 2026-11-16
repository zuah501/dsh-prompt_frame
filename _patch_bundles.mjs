/**
 * _patch_bundles.mjs -- register/unregister dsh-prompt-frame in a DSH profile.
 *
 * What it does to <profile>/package.json:
 *   1. backs the file up once to package.json.before-prompt-frame
 *   2. removes legacy bundle names ("dsh-mini-inject", "dsh-purge") if present
 *   3. appends "dsh-prompt-frame" at the END of dsh.profile.bundles (idempotent)
 *
 * Usage:
 *   node _patch_bundles.mjs              # install
 *   node _patch_bundles.mjs --remove     # uninstall
 *
 * Env:
 *   DSH_PROFILE=<dir|name>  profile directory, or a bare profile name
 *                           (default: $DSH_HOME/profiles/desktop, $DSH_HOME = %USERPROFILE%\.dsh)
 *   DSH_PROFILE_DIR=<dir>   fallback profile directory
 *   DRY_RUN=1               print the plan, write nothing
 *
 * NOTE: the DSH runtime itself exports DSH_PROFILE=<name> (e.g. "desktop").
 * A bare name is therefore accepted and expanded under $DSH_HOME/profiles.
 *
 * install.cmd / uninstall.cmd call this; running it by hand is fine too.
 * Output is ASCII-only on purpose (Windows console codepage).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = "dsh-prompt-frame";
const LEGACY = ["dsh-mini-inject", "dsh-purge"];

const remove = process.argv.includes("--remove");
const dryRun = String(process.env.DRY_RUN || "") === "1";

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Resolve the profile directory: DSH_PROFILE may be a path OR a bare profile name. */
function resolveProfile() {
  const home = process.env.USERPROFILE || os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(home, ".dsh");
  const raw = String(process.env.DSH_PROFILE || "").trim();
  if (raw) {
    // path-ish: contains a separator, or exists as a directory
    if (/[\\/]/.test(raw) || isDir(raw)) return path.resolve(raw);
    const byName = path.join(dshHome, "profiles", raw);
    if (isDir(byName)) return byName;
    const fallback = String(process.env.DSH_PROFILE_DIR || "").trim();
    if (fallback && isDir(fallback)) return path.resolve(fallback);
    return byName; // report the intended path in the error message
  }
  const envDir = String(process.env.DSH_PROFILE_DIR || "").trim();
  if (envDir && isDir(envDir)) return path.resolve(envDir);
  return path.join(dshHome, "profiles", "desktop");
}

const profile = resolveProfile();
const pkgPath = path.join(profile, "package.json");

console.log(`profile : ${profile}`);
console.log(`mode    : ${remove ? "remove" : "install"}${dryRun ? " (DRY_RUN)" : ""}`);

if (!fs.existsSync(pkgPath)) {
  console.error(`FAIL: package.json not found: ${pkgPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(pkgPath, "utf8");
let j;
try {
  j = JSON.parse(raw);
} catch (err) {
  console.error(`FAIL: package.json is not valid JSON: ${String(err && err.message)}`);
  process.exit(1);
}

j.dsh = j.dsh && typeof j.dsh === "object" ? j.dsh : {};
j.dsh.profile = j.dsh.profile && typeof j.dsh.profile === "object" ? j.dsh.profile : {};
if (!Array.isArray(j.dsh.profile.bundles)) j.dsh.profile.bundles = [];

const before = j.dsh.profile.bundles.slice();
const removed = [];
const next = before.filter((x) => {
  if (typeof x !== "string") return true;
  if (LEGACY.includes(x)) {
    removed.push(x);
    return false;
  }
  if (remove && x === NAME) {
    removed.push(x);
    return false;
  }
  return true;
});

if (!remove && !next.includes(NAME)) next.push(NAME);

const changed = before.length !== next.length || before.some((x, i) => x !== next[i]);

console.log(`removed : ${removed.length ? removed.join(", ") : "(none)"}`);
console.log(`bundles : ${before.length} -> ${next.length}`);
const tail = next.slice(-2);
console.log(`last 2  : ${tail.length ? tail.join(", ") : "(empty)"}`);

if (!changed) {
  console.log("result  : nothing to change (already idempotent)");
  process.exit(0);
}

if (dryRun) {
  console.log("result  : DRY_RUN, no file written");
  process.exit(0);
}

const backup = path.join(profile, "package.json.before-prompt-frame");
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, raw, "utf8");
  console.log(`backup  : ${backup}`);
} else {
  console.log(`backup  : kept existing ${backup}`);
}

j.dsh.profile.bundles = next;
fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + "\n", "utf8");

// read back and verify -- "command ok" is not "state changed"
const check = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const written = check.dsh?.profile?.bundles || [];
const good = remove
  ? !written.includes(NAME)
  : written[written.length - 1] === NAME;
console.log(`verify  : ${good ? "OK" : "MISMATCH"} -> ${JSON.stringify(written.slice(-2))}`);
if (!good) process.exit(1);
