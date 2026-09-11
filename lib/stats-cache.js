/**
 * stats-cache.js — 会话统计的可靠读取（磁盘缓存版）
 *
 * 背景（2026-09-11 实测）：
 * - dsh 官方 `session_projcache.json` 对「非当前活动项目 / 历史会话」常缺失或过期，
 *   实测 180 个会话里 68 个被误判为 turns=0（其中 61 个实际有 20~108 轮），
 *   前端因此显示成「（空会话）」。
 * - 完整扫描会话日志（解压 + 逐行数 turn/start）准确但昂贵：68 个会话 ≈ 9s / 69MB。
 *
 * 策略：官方 projcache（最快）→ 本地磁盘缓存（按日志文件 mtime 失效）→ 完整扫描并回填缓存。
 * 配合 warmStatsCache() 在后台分批预热，用户实际打开面板时基本都已命中缓存。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionStats, readSessionStatsLite, resolveSessionLog } from "./sessions.js";

const STATE_DIR =
  process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
  path.join(fileURLToPath(new URL("../", import.meta.url)), "state");
const CACHE_FILE = path.join(STATE_DIR, "session-stats-cache.json");
const MAX_ENTRIES = 3000;

let cache = null;
let flushTimer = null;
let flushing = false;

function loadCache() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    cache = j && typeof j === "object" ? j : {};
  } catch {
    cache = {};
  }
  return cache;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, 1200);
  if (flushTimer.unref) flushTimer.unref();
}

/** 立即落盘（退出前/预热结束时调用）。 */
export function flushNow() {
  if (flushing) return;
  flushing = true;
  try {
    const c = loadCache();
    const keys = Object.keys(c);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (c[a]?.at || 0) - (c[b]?.at || 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => delete c[k]);
    }
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(c), "utf-8");
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    /* 缓存写入失败不影响主流程 */
  } finally {
    flushing = false;
  }
}

function logFingerprint(sessionPath) {
  const log = resolveSessionLog(sessionPath);
  if (!log) return null;
  try {
    const st = fs.statSync(log.file);
    return { file: log.file, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * 可靠统计：官方缓存 → 本地缓存 → 完整扫描。
 * @returns {{title: string|null, size: number, turns: number}}
 */
export function sessionStatsReliable(sessionPath, sessionId) {
  const lite = readSessionStatsLite(sessionPath, sessionId);
  // 官方缓存可信：既有标题又有轮数
  if (lite && lite.turns && lite.title) return lite;

  const fp = logFingerprint(sessionPath);
  if (!fp) return lite || { title: null, size: 0, turns: 0 };

  const c = loadCache()[sessionPath];
  if (c && c.mtimeMs === fp.mtimeMs && c.size === fp.size && (c.turns || c.title)) {
    return { title: c.title ?? lite?.title ?? null, size: fp.size, turns: c.turns ?? 0 };
  }

  const full = readSessionStats(sessionPath);
  if (full) {
    loadCache()[sessionPath] = {
      mtimeMs: fp.mtimeMs,
      size: fp.size,
      turns: full.turns ?? 0,
      title: full.title ?? null,
      at: Date.now(),
    };
    scheduleFlush();
    return { title: full.title ?? lite?.title ?? null, size: full.size ?? fp.size, turns: full.turns ?? 0 };
  }
  return lite || { title: null, size: fp.size, turns: 0 };
}

/** 该会话是否已有可靠统计（无需扫描）。 */
export function isStatsCached(sessionPath, sessionId) {
  const lite = readSessionStatsLite(sessionPath, sessionId);
  if (lite && lite.turns && lite.title) return true;
  const fp = logFingerprint(sessionPath);
  if (!fp) return true;
  const c = loadCache()[sessionPath];
  return !!(c && c.mtimeMs === fp.mtimeMs && c.size === fp.size && (c.turns || c.title));
}

/**
 * 后台预热：分批把未命中缓存的会话统计补齐（不阻塞启动、不阻塞请求）。
 * @param {() => Promise<Array<{path:string,sessionId:string}>>} listFn 取会话列表的函数
 */
export async function warmStatsCache(listFn, { delayMs = 12000, batch = 4, gapMs = 250 } = {}) {
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  await sleep(delayMs);
  let all = [];
  try {
    all = await listFn();
  } catch {
    return;
  }
  const todo = [];
  for (const s of all) {
    try {
      if (!isStatsCached(s.path, s.sessionId)) todo.push(s);
    } catch {
      /* 单个会话异常不影响整体 */
    }
  }
  for (let i = 0; i < todo.length; i += batch) {
    for (const s of todo.slice(i, i + batch)) {
      try {
        sessionStatsReliable(s.path, s.sessionId);
      } catch {
        /* 跳过异常会话 */
      }
    }
    flushNow();
    await sleep(gapMs);
  }
  flushNow();
}
