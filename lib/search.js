/**
 * search.js — 自研搜索 + 官方搜索开关（后端）
 *
 * 1) customSearch：解压所有会话文件，关键词全文搜索，返回命中片段。
 *    支持中止（AbortSignal）。
 * 2) officialSearch 开关：改写 profile 的 cordis.patch.yml 中
 *    session-query-sqlite 的 config（openAt startup/never），需重启生效。
 */
import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { listAllSessions, resolveSessionLog } from "./sessions.js";
import { listTrash } from "./trash.js";
import { getConfig } from "./config.js";
import { scanZstdFrames } from "./zstd.js";

/**
 * 批量按 seq 读取消息内容（语义搜索命中后按需解压，内存减压与关键词一致：
 * 逐帧流式解压，峰值 = 单帧；全部目标找到即停，不整文件常驻）。
 * @returns {Object<seq, string>} 内容预览（截断 160 字符）；找不到的 seq 不在结果中
 */
export function readMessagesBySeqs(sessionPath, seqs) {
  const want = new Set(seqs);
  const out = {};
  if (want.size === 0) return out;
  const log = resolveSessionLog(sessionPath);
  if (!log) return out;
  let buf;
  try {
    buf = fs.readFileSync(log.file);
  } catch {
    return out;
  }
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) {
    try {
      collectSeqs(zstdDecompressSync(buf).toString("utf-8"), want, out);
    } catch {}
    return out;
  }
  for (const fr of frames) {
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString("utf-8");
    } catch {
      continue;
    }
    collectSeqs(text, want, out);
    if (want.size === 0) break; // 全部找到，提前停止
  }
  return out;
}

/** 在文本中收集目标 seq 的消息内容（兼容三种结构），找到即从 want 移除。 */
function collectSeqs(text, want, out) {
  for (const line of text.split("\n")) {
    if (want.size === 0) break;
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!want.has(ev.seq)) continue;
    const raw = ev.data && (ev.data.message && ev.data.message.content !== undefined ? ev.data.message.content : ev.data.content);
    let content = "";
    if (typeof raw === "string") content = raw;
    else if (Array.isArray(raw)) {
      content = raw.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
    }
    out[ev.seq] = content ? content.slice(0, 160) : "";
    want.delete(ev.seq);
  }
}

const PROFILE_PATCH = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, "profiles", "web", "cordis.patch.yml")
  : "/home/dsh/profiles/web/cordis.patch.yml";

// 搜索 TTL 缓存：同一关键词 60 秒内直接返回，避免重复全量解压（内存友好）。
// 取消的搜索不缓存。
let searchCache = { at: 0, kw: "", hits: null, partial: false };

/** 清空搜索缓存（释放内存按钮用）。 */
export function clearSearchCache() {
  searchCache = { at: 0, kw: "", hits: null, partial: false };
}

/** 搜索时间预算：不再时间截断（会话多时 30 秒分段询问体验差），一次搜完为止，用户可随时取消。 */
const SEARCH_TIME_BUDGET_MS = Infinity;

/**
 * 兜底全量扫描（官方 SQLite 索引不可用时使用；逐帧流式解压，内存峰值 = 单帧）。
 */
export async function searchSessionsFull(keyword, signal, limit = 100, fromIndex = 0, dateFrom = 0, dateTo = 0, archivedIds = []) {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return { hits: [], partial: false, scanned: 0, total: 0 };
  const now = Date.now();
  const ttlSec = Number(getConfig().searchCacheSeconds);
  const ttlMs = (Number.isFinite(ttlSec) && ttlSec >= 0 ? ttlSec : 120) * 1000; // 0 = 不缓存
  const continuing = fromIndex > 0;
  if (!continuing && ttlMs > 0 && searchCache.kw === kw && searchCache.hits && now - searchCache.at < ttlMs) {
    return {
      hits: searchCache.hits,
      partial: searchCache.partial,
      scanned: searchCache.scanned,
      total: searchCache.total,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cache: { cached: true, ttlSeconds: ttlSec, expiresInMs: Math.max(0, ttlMs - (now - searchCache.at)) },
    };
  }
  const hits = [];
  // 一次搜全部分组：主会话（visible/archived 按归档状态分）+ 子代理（subagent）+ 回收站（trash）
  const archived = new Set(archivedIds);
  const sessions = (await listAllSessions()).map((s) => {
    let b = "visible";
    if (s.header && s.header.parentSession) b = "subagent"; // 子代理会话（左侧嵌套不可见）
    else if (archived.has(s.sessionId)) b = "archived";
    return { ...s, _bucket: b };
  });
  for (const t of listTrash()) {
    if (t.type !== "session") continue;
    sessions.push({ sessionId: t.name, cwd: "", path: path.join(t.entryDir, "data"), _bucket: "trash", header: null });
  }
  const startAt = Date.now();
  let partial = false;
  let scanned = 0;
  // 每桶独立上限：visible/archived/trash/subagent 各最多 limit 条，全部桶满才停（避免先扫的组占满全局上限导致后面组扫不到）
  const BUCKETS = ["visible", "archived", "trash", "subagent"];
  const bucketCounts = { visible: 0, archived: 0, trash: 0, subagent: 0 };
  const bucketFull = (b) => (bucketCounts[b] || 0) >= limit;

  for (let i = Math.min(fromIndex, sessions.length); i < sessions.length; i++) {
    if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
    if (Date.now() - startAt > SEARCH_TIME_BUDGET_MS) { partial = true; break; }
    if (BUCKETS.every(bucketFull)) break; // 全部组满
    const s = sessions[i];
    scanned = i + 1;
    const log = resolveSessionLog(s.path);
    if (!log) continue;
    const file = log.file;
    if (bucketFull(s._bucket)) continue; // 该组已满，跳过此会话
    try {
      const buf = fs.readFileSync(file);
      const frames = scanZstdFrames(buf);
      if (frames.length === 0) {
        // 单帧场景（如插件写回的小文件）：整体解
        const before = bucketCounts[s._bucket] || 0;
        const added = searchText(zstdDecompressSync(buf).toString("utf-8"), kw, s, 1, before, limit - before, dateFrom, dateTo, s._bucket);
        hits.push(...added);
        bucketCounts[s._bucket] = before + added.length;
        if (hits.length >= limit) break;
        continue;
      }
      let lineNo = 0;
      for (const fr of frames) {
        if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
        const text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString("utf-8");
        const before = bucketCounts[s._bucket] || 0;
        const added = searchText(text, kw, s, lineNo, before, limit - before, dateFrom, dateTo, s._bucket);
        hits.push(...added);
        bucketCounts[s._bucket] = before + added.length;
        lineNo += text.split("\n").length;
        if (bucketFull(s._bucket)) break;
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      // 单个会话读取失败跳过
    }
  }
  // 完整扫描（非断点、非超时）才写缓存；断点/超时结果不缓存（避免污染下一次普通搜索）
  if (!partial && !continuing) {
    searchCache = { at: Date.now(), kw, hits, partial, scanned, total: sessions.length };
  }
  return {
    hits,
    partial,
    scanned,
    total: sessions.length,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cache: { cached: false, ttlSeconds: ttlSec, expiresInMs: ttlMs },
  };
}

/** 在一段文本中逐行搜索并收集命中（baseLineNo 为该段起始行号，0-based；dateFrom/dateTo 为毫秒时间戳，0=不限）。 */
function searchText(text, kw, s, baseLineNo, hitStart, limit, dateFrom = 0, dateTo = 0, bucket = "visible") {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.toLowerCase().includes(kw)) continue;
    // 提取文本内容
    let content = "";
    let seq;
    let time;
    try {
      const ev = JSON.parse(line);
      seq = ev.seq;
      time = typeof ev.time === "number" ? ev.time : (ev.time ? Date.parse(ev.time) : 0);
      const blocks = ev.data?.message?.content ?? ev.data?.content ?? [];
      content = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    } catch {
      content = line;
    }
    if (!content) continue;
    // 时间范围过滤（消息无时间戳时放行）
    if (time && dateFrom > 0 && time < dateFrom) continue;
    if (time && dateTo > 0 && time > dateTo) continue;
    // 关键词上下文窗口：命中位置前后截取（前端高亮用）
    const ci = content.toLowerCase().indexOf(kw);
    const cs = Math.max(0, ci - 60);
    const ce = Math.min(content.length, ci + kw.length + 120);
    out.push({
      sessionId: s.sessionId,
      bucket,
      cwd: s.cwd,
      seq,
      time: time || undefined,
      line: baseLineNo + i + 1,
      snippet: (cs > 0 ? "…" : "") + content.slice(cs, ce) + (ce < content.length ? "…" : ""),
    });
    if (hitStart + out.length >= limit) break;
  }
  return out;
}

/**
 * 官方搜索开关：改写 cordis.patch.yml 中 session-query-sqlite 的 openAt。
 * @param {boolean} enabled true=startup（持久索引），false=never（官方默认）
 * @returns {{ok: boolean, needRestart: true, error?: string}}
 */
export function setOfficialSearch(enabled) {
  try {
    if (!fs.existsSync(PROFILE_PATCH)) return { ok: false, error: `找不到 ${PROFILE_PATCH}` };
    let text = fs.readFileSync(PROFILE_PATCH, "utf-8");

    const blockOn = `
# dsh-tools：官方搜索开关（openAt: startup，持久索引）⚠️ 由插件管理
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /home/dsh/session-query.sqlite
    openAt: startup
`;
    const marker = "id: session-query-sqlite";

    if (enabled && !text.includes(marker)) {
      // 有 - insert: 锚点时插在其前；否则（bundles 统一后无 insert 行）追加到文件末尾
      if (text.includes("- insert:")) text = text.replace(/\n- insert:/, "\n" + blockOn + "\n- insert:");
      else text = text.replace(/\s*$/, "\n\n" + blockOn + "\n");
      fs.writeFileSync(PROFILE_PATCH, text, "utf-8");
      return { ok: true, needRestart: true };
    }
    if (!enabled && text.includes(marker)) {
      // 移除整个 block（从注释行到 config 块结束）
      const lines = text.split("\n");
      const out = [];
      let skipping = false;
      for (const line of lines) {
        if (line.includes("# dsh-tools：官方搜索开关") || line.trim() === "- id: session-query-sqlite") skipping = true;
        if (skipping) {
          if (line.trim().startsWith("- id:")) continue; // 本块开头
          if (line.trim() === "" || line.trim().startsWith("-")) { skipping = false; }
          continue;
        }
        out.push(line);
      }
      fs.writeFileSync(PROFILE_PATCH, out.join("\n"), "utf-8");
      return { ok: true, needRestart: true };
    }
    return { ok: true, needRestart: false, unchanged: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** 读取当前官方搜索状态。 */
export function getOfficialSearchState() {
  try {
    if (!fs.existsSync(PROFILE_PATCH)) return { enabled: false };
    const text = fs.readFileSync(PROFILE_PATCH, "utf-8");
    const m = text.match(/id: session-query-sqlite[\s\S]*?openAt:\s*(\w+)/);
    return { enabled: m ? m[1] === "startup" : false };
  } catch {
    return { enabled: false, error: "读取失败" };
  }
}


/** 命中分组：子代理/归档/可见（官方结果 header 判定）。 */
function bucketOf(header, archivedIds) {
  if (header && header.parentSession) return "subagent";
  if (header && archivedIds.includes(header.id)) return "archived";
  return "visible";
}

/**
 * 只扫回收站（官方 SQLite 索引不含回收站；回收站会话少，自研逐帧轻扫）。
 */
export async function searchTrashOnly(keyword, signal, limit = 100, dateFrom = 0, dateTo = 0) {
  const kw = keyword.trim().toLowerCase();
  const hits = [];
  if (!kw) return hits;
  const sessions = listTrash()
    .filter((t) => t.type === "session")
    .map((t) => ({ sessionId: t.name, cwd: "", path: path.join(t.entryDir, "data"), _bucket: "trash", header: null }));
  for (const s of sessions) {
    if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
    const log = resolveSessionLog(s.path);
    if (!log) continue;
    const file = log.file;
    try {
      const buf = fs.readFileSync(file);
      const frames = scanZstdFrames(buf);
      const pushText = (text, baseLineNo) => {
        const before = hits.filter((h) => h.bucket === "trash").length;
        const added = searchText(text, kw, s, baseLineNo, before, limit - before, dateFrom, dateTo, "trash");
        hits.push(...added);
      };
      if (frames.length === 0) {
        pushText(zstdDecompressSync(buf).toString("utf-8"), 1);
        continue;
      }
      let lineNo = 0;
      for (const fr of frames) {
        if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
        const text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString("utf-8");
        pushText(text, lineNo);
        lineNo += text.split("\n").length;
        if (hits.filter((h) => h.bucket === "trash").length >= limit) break;
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }
    if (hits.filter((h) => h.bucket === "trash").length >= limit) break;
  }
  return hits;
}

/**
 * 组装搜索：官方 SQLite 索引优先（省内存），不可用时兜底全量扫描；
 * 回收站始终自研轻扫；统一分组（visible/archived/subagent/trash 每组最多 limit 条）与时间过滤，并走 TTL 缓存。
 * @param {(kw: string, signal: AbortSignal) => Promise<Array>} officialSearch 官方搜索调用（返回原始命中数组）
 */
export async function searchAll(keyword, signal, dateFrom = 0, dateTo = 0, archivedIds = [], officialSearch) {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return { hits: [], partial: false, scanned: 0, total: 0, usedOfficial: false, cache: null };
  const now = Date.now();
  const ttlSec = Number(getConfig().searchCacheSeconds);
  const ttlMs = (Number.isFinite(ttlSec) && ttlSec >= 0 ? ttlSec : 120) * 1000; // 0 = 不缓存
  if (ttlMs > 0 && searchCache.kw === kw && searchCache.hits && now - searchCache.at < ttlMs) {
    return {
      hits: searchCache.hits,
      partial: searchCache.partial,
      scanned: searchCache.scanned,
      total: searchCache.total,
      usedOfficial: searchCache.usedOfficial,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cache: { cached: true, ttlSeconds: ttlSec, expiresInMs: Math.max(0, ttlMs - (now - searchCache.at)) },
    };
  }
  let hits = [];
  let usedOfficial = false;
  if (typeof officialSearch === "function") {
    try {
      const items = await officialSearch(kw, signal);
      if (Array.isArray(items)) {
        hits = items.map((hit) => ({
          sessionId: (hit.bestMatch && hit.bestMatch.sessionId) || (hit.header && hit.header.id),
          seq: hit.bestMatch && hit.bestMatch.seq,
          time: hit.bestMatch && hit.bestMatch.time,
          snippet: hit.bestMatch && hit.bestMatch.snippet,
          bucket: bucketOf(hit.header, archivedIds),
        })).filter((h) => h.sessionId);
        usedOfficial = true;
      }
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      usedOfficial = false; // 官方不可用（未启用/未建索引）→ 兜底
    }
  }
  if (!usedOfficial) {
    const r = await searchSessionsFull(keyword, signal, 100, 0, 0, 0, archivedIds);
    hits = r.hits;
  }
  // 回收站组（官方不含）
  const trashHits = await searchTrashOnly(keyword, signal, 100, 0, 0);
  hits = hits.concat(trashHits);
  // 时间范围过滤
  if (dateFrom > 0 || dateTo > 0) {
    hits = hits.filter((h) => {
      if (!h.time) return true;
      if (dateFrom > 0 && h.time < dateFrom) return false;
      if (dateTo > 0 && h.time > dateTo) return false;
      return true;
    });
  }
  // 分组截断：每组最多 100 条
  const perBucket = new Map();
  const keep = [];
  for (const h of hits) {
    const n = perBucket.get(h.bucket) || 0;
    if (n >= 100) continue;
    perBucket.set(h.bucket, n + 1);
    keep.push(h);
  }
  searchCache = { at: Date.now(), kw, hits: keep, partial: false, scanned: 0, total: 0, usedOfficial };
  return {
    hits: keep,
    partial: false,
    scanned: 0,
    total: 0,
    usedOfficial,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cache: { cached: false, ttlSeconds: ttlSec, expiresInMs: ttlMs },
  };
}
