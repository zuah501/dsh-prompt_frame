/**
 * net-scope-lite.js —— dsh-prompt-frame 的本地垫片。
 *
 * 来源：YuJunZhiXue/dsh-purge v1.1.77（Apache-2.0）。
 *   - ownServerNote()  逐字节取自 dsh-purge/lib/net-scope.js:466（原文 3 行，正文只有 return ""）。
 *   - findDshHome()    精简版，取自 dsh-purge/lib/core.js:1680 的同一套优先级的最外层两步：
 *                      DSH_HOME 环境变量优先，否则 ~/.dsh。
 *
 * 为什么不整段抄 findDshHome：
 *   上游 core.js 的 findDshHome 还做桌面端 surface 探测（adapterFor/detectSurface/
 *   desktopHomeCandidates/homeHasHarnessData/findShimDir/findNpmPrefix/
 *   portableHomeFromLauncher/findWslWindowsDshHome），那些依赖 surface.js、desktop.js
 *   与 npm/wsl 探测；本包只做提示词改写，不碰网络与安装面，故只保留 env 与 ~/.dsh 两级。
 *   实际调用链里 ownServerNote() 是唯一被 identity.js 使用的导出（identity.js:783），
 *   它不调用 findDshHome；findDshHome 仅为 API 对齐与后续扩展保留。
 *
 * 许可：Apache License 2.0，见包根 NOTICE。
 */
import os from "node:os";
import path from "node:path";

/**
 * 返回本机 DSH 主目录。
 * @param {{ env?: Record<string, string|undefined> }} [options] 可注入 env 以便测试。
 * @returns {string} 规范化后的目录路径。
 */
export function findDshHome(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env.DSH_HOME;
  if (fromEnv && String(fromEnv).trim()) return path.normalize(fromEnv.trim());
  return path.normalize(path.join(os.homedir(), ".dsh"));
}

/**
 * 上游把自己的服务器地址补进注入正文；1.1.77 里恒为空串（功能已下线）。
 * 保留同签名，让 vendor/identity.js 的 import 与调用点不需要改动。
 * @returns {string} 恒为空串。
 */
export function ownServerNote() {
  return "";
}
