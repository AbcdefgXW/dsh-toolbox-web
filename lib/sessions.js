/**
 * sessions.js — 会话文件操作（后端）
 *
 * dsh 会话存储：/home/dsh/sessions/<projectKey(cwd)>/<encode(id)>/session.jsonl.zstd
 * 项目目录名 = projectKey(cwd)（有损编码，不可逆），cwd 以 header 为准。
 *
 * 支持：列表 / 删除 / 复制 / 重设工作区根（改 header.cwd）/ 移动
 * 注意：store 中 live agent 不受文件操作影响，删除/移动后需重启完整生效。
 */
import fs from "node:fs";
import path from "node:path";
import { compressSessionText, decompressFirstFrame, decompressSessionFile } from "./zstd.js";

const SESSIONS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, "sessions")
  : "/home/dsh/sessions";

/** 当前工作区根（agent 视角）。 */
export const WORKSPACE_ROOT = process.env.DSH_CHANNELS_CWD?.trim() || "/workspace";

/** 与 dsh 一致的 projectKey（复制自 dsh-session-persistence-jsonl）。 */
export function projectKey(cwd) {
  if (!cwd) return "_no-cwd";
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 与 dsh 一致的会话目录名编码。 */
export function encodeSegment(id) {
  let out = "";
  for (const ch of String(id)) {
    const code = ch.charCodeAt(0);
    out += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * 解析会话目录中的「最高代」日志文件。
 * 官方加载器永远选版本号最高的代（resolveGenerationInDirectory）：
 *   v0 = session.jsonl.zstd；vN = session.v<N>.jsonl.zstd（如 v3）。
 * 读写都必须作用在最高代，否则读的是旧快照（内容失真）、写的是废弃代（官方不认）。
 * @returns {{file: string, version: number, name: string}|null}
 */
export function resolveSessionLog(sessionPath) {
  let best = null;
  let bestVer = -1;
  try {
    for (const f of fs.readdirSync(sessionPath)) {
      const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(f);
      if (!m) continue;
      const ver = m[1] ? Number(m[1]) : 0;
      if (ver > bestVer) { bestVer = ver; best = f; }
    }
  } catch {}
  return best ? { file: path.join(sessionPath, best), version: bestVer, name: best } : null;
}

/** 读取会话 header（最高代，只解第一帧，快）。 */
export async function readSessionHeader(sessionPath) {
  const log = resolveSessionLog(sessionPath);
  if (!log) return null;
  try {
    const text = decompressFirstFrame(log.file);
    const firstLine = text.trim().split("\n")[0];
    return JSON.parse(firstLine);
  } catch {
    return null;
  }
}

/** 读取会话标题（取最后一个 session/title 事件；无则返回 null）。 */
export function readSessionTitle(sessionPath) {
  const stats = readSessionStats(sessionPath);
  return stats ? stats.title : null;
}

/**
 * 会话统计：标题（最后一个 session/title 事件）、压缩文件大小（字节）、轮数（turn/start 事件数）。
 * 一趟解压同时扫描；读不到返回 null。
 */
export function readSessionStats(sessionPath) {
  const log = resolveSessionLog(sessionPath);
  if (!log) return null;
  const file = log.file;
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    const text = decompressSessionFile(file);
    let title = null;
    let turns = 0;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        if (m.type === "session/title" && m.data && m.data.title) title = String(m.data.title);
        else if (m.type === "turn/start") turns += 1;
      } catch {}
    }
    return { title, size, turns };
  } catch {
    return null;
  }
}

// ── 轻量统计（零解压）：大小 stat + 轮数/标题读 dsh 官方缓存 ──
// dsh 在 $DSH_HOME/storages/session_projcache.json 维护会话统计缓存（turns/title 实时更新），
// 直接读它避免全量解压（打开工具箱解压 20+ 会话是内存飙高的根因）。
const PROJCACHE_PATH = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, "storages", "session_projcache.json")
  : "/home/dsh/storages/session_projcache.json";
let projCache = { at: 0, sessions: null }; // TTL 缓存：10 秒内不重读

function projCacheSessions() {
  const now = Date.now();
  if (projCache.sessions && now - projCache.at < 10_000) return projCache.sessions;
  try {
    const j = JSON.parse(fs.readFileSync(PROJCACHE_PATH, "utf-8"));
    projCache = { at: now, sessions: j?.tables?.sessions || {} };
  } catch {
    projCache = { at: now, sessions: {} };
  }
  return projCache.sessions;
}

/** 清空统计缓存（释放内存按钮用）。 */
export function clearProjCache() {
  projCache = { at: 0, sessions: null };
}

/**
 * 轻量会话统计：大小（stat）+ 轮数/标题（官方 projcache，零解压）。
 * sessionId 用原始 ID（header.id），磁盘目录名是编码后的（@/:/~ 等会被转义）。
 * 读不到缓存时轮数为 0、标题为 null。
 */
export function readSessionStatsLite(sessionPath, sessionId) {
  const log = resolveSessionLog(sessionPath);
  let size = 0;
  if (log) { try { size = fs.statSync(log.file).size; } catch {} }
  const id = sessionId || path.basename(sessionPath);
  const entry = projCacheSessions()[id];
  const st = entry?.rows?.sessionStats?.val;
  const t = entry?.rows?.title?.val;
  return {
    title: typeof t === "string" && t ? t : null,
    size,
    turns: st && typeof st.turns === "number" ? st.turns : 0,
  };
}

/** 列出所有会话（cwd 从 header 读取，读不到则用项目目录名兜底）。 */
export async function listAllSessions() {
  const result = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return result;
  for (const projectDir of fs.readdirSync(SESSIONS_ROOT)) {
    const projectPath = path.join(SESSIONS_ROOT, projectDir);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    for (const sessionDir of fs.readdirSync(projectPath)) {
      const sessionPath = path.join(projectPath, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;
      const header = await readSessionHeader(sessionPath);
      result.push({
        sessionId: header?.id ?? sessionDir,
        cwd: header?.cwd ?? projectDir,
        projectDir,
        sessionDir,
        path: sessionPath,
        header,
      });
    }
  }
  return result;
}

/** 删除会话目录。 */
export function deleteSession(sessionPath) {
  fs.rmSync(sessionPath, { recursive: true, force: true });
}

/**
 * 复制会话到目标 cwd（默认同根）。读写均作用在最高代，写回同名代文件。
 * 注意：官方加载器要求每事件一帧的格式，compressSessionText 满足；
 * 但单文件复制出的会话未经官方 store 注册，仅用于诊断，正常复制走官方 fork。
 * @returns {{ok: boolean, newSessionId?: string, error?: string}}
 */
export async function copySession(sourcePath, targetCwd, newSessionId) {
  const log = resolveSessionLog(sourcePath);
  if (!log) return { ok: false, error: "会话文件不存在" };
  const text = decompressSessionFile(log.file);
  const lines = text.trim().split("\n");
  const header = JSON.parse(lines[0]);
  header.id = newSessionId;
  header.cwd = targetCwd;
  lines[0] = JSON.stringify(header);
  const compressed = compressSessionText(lines.join("\n"));
  const targetDir = path.join(SESSIONS_ROOT, projectKey(targetCwd), encodeSegment(newSessionId));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, log.name), compressed);
  return { ok: true, newSessionId };
}

/**
 * 重设会话 cwd（最高代感知，零数据丢失）：
 *   1) 读最高代日志 → 改 header.cwd → 写回「同一代」文件（保持官方选代结果）
 *   2) 整目录搬迁到目标项目目录（保留全部代文件 / 锁文件 / 附件，不再"写单文件+删原目录"）
 * 旧实现只搬 v0 旧代内容并删除原目录，会把 v3 新内容整段丢掉（数据回退事故）。
 */
export async function resetSessionCwd(sessionPath, newCwd) {
  // 跨平台校验：path.isAbsolute 同时认 Linux(/xxx) 与 Windows(C:\xxx)
  if (!newCwd || typeof newCwd !== "string" || !path.isAbsolute(newCwd)) {
    return { ok: false, error: "目标路径无效：" + String(newCwd) };
  }
  const log = resolveSessionLog(sessionPath);
  if (!log) return { ok: false, error: "会话文件不存在" };
  const text = decompressSessionFile(log.file);
  const lines = text.trim().split("\n");
  const header = JSON.parse(lines[0]);
  if (header.cwd === newCwd) return { ok: true, unchanged: true };
  const targetDir = path.join(SESSIONS_ROOT, projectKey(newCwd), encodeSegment(header.id));
  if (targetDir !== sessionPath && fs.existsSync(targetDir)) {
    return { ok: false, error: "目标位置已存在同名会话目录，未做任何改动：" + targetDir };
  }
  // 先改最高代 header（写回同一代文件），再整目录搬迁
  header.cwd = newCwd;
  lines[0] = JSON.stringify(header);
  fs.writeFileSync(log.file, compressSessionText(lines.join("\n")));
  if (targetDir !== sessionPath) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(sessionPath, targetDir);
  }
  return { ok: true, movedTo: targetDir };
}

/**
 * 用 dsh 官方 fork 复制会话（store 感知，左侧立即可见）。
 * @param sessions SessionStore（ctx.get("sessions")）
 * @param sourceId 源会话 id
 * @param newId 新会话 id（可选）
 * @returns fork 出的 live session
 */
export async function forkSession(sessions, sourceId, newId) {
  const liveSource = sessions.get(sourceId);
  if (!liveSource) {
    // 源不在 store（如重启后）——先尝试从持久化 resume 太复杂，报错让前端提示
    throw new Error(`源会话不在运行中（${sourceId}），请先在左侧打开它再复制`);
  }
  return sessions.fork(liveSource, void 0, newId);
}

/** 计算副本序号：-副本x，x 取最小可用正整数。 */
export function nextCopySuffix(base, existing) {
  let n = 1;
  while (existing.includes(`${base}-副本${n}`)) n += 1;
  return `${base}-副本${n}`;
}
