/**
 * index.js — dsh-toolbox 后端入口（cordis 插件）
 *
 * 机制（踩坑后定案）：
 * - 实现 = cordis Service（实例挂 typertRemote 绑定，方法名 = 端点名）
 * - 声明 = ctx.typert.register({package, schemas: [], invocations}) → localStore（strict 路径）
 * - invoke 时按 service key 找 ctx 服务 + 直接调方法（不依赖装饰器 marker）
 *
 * 扩展约定：新功能 = lib/ 加模块 + 这里加一个方法 + 一条 invocation。
 */
import { Service } from "@deepseek-ai/cordis";
import { bindTypertRemote } from "@deepseek-ai/dsh-typert-protocol";
import {
  registerToolsSettings,
  TOOL_SWITCHES,
  TOOLS_NAMESPACE,
} from "./lib/settings.js";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import {
  listAllSessions,
  deleteSession,
  copySession,
  resetSessionCwd,
  nextCopySuffix,
  forkSession,
  readSessionTitle,
  readSessionStats,
  readSessionStatsLite,
  clearProjCache,
  WORKSPACE_ROOT,
} from "./lib/sessions.js";
import {
  listSubdirs,
  createSubdir,
  renameSubdir,
  deleteSubdir,
  copySubdir,
  refreshSessionCounts,
} from "./lib/workspace.js";
import {
  searchAll,
  setOfficialSearch,
  getOfficialSearchState,
  clearSearchCache,
  readMessagesBySeqs,
} from "./lib/search.js";
import { buildEmbedIndex, embedQuery, listEmbedModels, testEmbedConnection } from "./lib/embed.js";
import {
  trashItem,
  listTrash,
  restoreTrashEntry,
  emptyTrash,
  startTrashWatcher,
} from "./lib/trash.js";
import { getConfig, setConfigField, resetConfig } from "./lib/config.js";
import { listPresets, readPresetFile, savePresetFile } from "./lib/presets.js";
import { decompressFirstFrame } from "./lib/zstd.js";
import { listTags, setSessionTags, removeTag, renameTag } from "./lib/tags.js";
import { listMessagesTail, truncateSessionAt, editMessageAt } from "./lib/messages.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 插件自身目录（发布到任意位置都能正确找到 state/）
const PLUGIN_STATE_DIR = path.join(fileURLToPath(new URL("./", import.meta.url)), "state");

// 心跳运行状态（tools.debug 端点读取，排查用）
let heartbeatState = { running: false, lastBeatAt: 0, lastResult: "", lastTarget: "", nextIntervalBeatAt: null, nextCronAt: null };

/** 计算定点定时（daily/weekly/monthly）的下一次触发时间戳；无效/关闭返回 null。 */
function nextCronTime(cron, now = new Date()) {
  if (!cron || cron.type === "off" || !cron.time) return null;
  const parts = String(cron.time).split(":").map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  const [h, m] = parts;
  const base = new Date(now);
  base.setSeconds(0, 0);
  if (cron.type === "daily") {
    const t = new Date(base); t.setHours(h, m, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t.getTime();
  }
  if (cron.type === "weekly") {
    const diff = (Number(cron.day) - now.getDay() + 7) % 7;
    const t = new Date(base); t.setHours(h, m, 0, 0);
    t.setDate(t.getDate() + diff);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 7);
    return t.getTime();
  }
  if (cron.type === "monthly") {
    const t = new Date(base); t.setHours(h, m, 0, 0);
    t.setDate(Number(cron.date));
    if (t.getTime() <= now.getTime()) t.setMonth(t.getMonth() + 1);
    return t.getTime();
  }
  return null;
}

/** 从配置解析定点定时对象；无效返回 null。 */
function cronFromCfg(cfg) {
  try {
    const raw = String(cfg?.scheduleCron || "off").trim();
    if (raw === "off") return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从渠道会话 ID 反推 {channel, peerId}（与 dsh-channels 的 SessionId 编码一致）。 */
function parseChannelTarget(id) {
  const s = String(id);
  for (const [prefix, channel] of [["ch-weixin-", "weixin"], ["ch-qq-", "qq"], ["ch-feishu-", "feishu"]]) {
    if (s.startsWith(prefix)) return { channel, peerId: s.slice(prefix.length) };
  }
  return null;
}

export const name = "dsh-toolbox-web";

export const inject = ["settings", "typert", "agents"];

/** 端点实现：一个 Service，方法名 = typert 端点 method。 */
class ToolsApi extends Service {
  constructor(ctx) {
    super(ctx, "dsh-toolbox-api");
    this.typertRemote = bindTypertRemote(this, this.name, { namespace: "dsh-toolbox" });
  }

  // ── 基础 ──
  async info() {
    return {
      workspaceRoot: WORKSPACE_ROOT,
      switches: TOOL_SWITCHES.map(({ key, label, hot, default: def }) => ({ key, label, hot, default: def })),
    };
  }

  // ── 会话管理 ──
  async "sessions.list"() {
    const all = await listAllSessions();
    const out = [];
    for (const s of all) {
      const stats = readSessionStatsLite(s.path, s.sessionId);
      // 最新一条消息预览：只解尾部帧（内存可控），不解压全部
      let latest = null;
      try {
        const r = listMessagesTail(s.path, 1);
        if (r.ok && r.messages && r.messages.length) latest = String(r.messages[r.messages.length - 1].content).slice(0, 80);
      } catch {}
      out.push({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: stats?.title ?? null,
        size: stats?.size ?? 0,
        turns: stats?.turns ?? 0,
        latest,
        parentSession: s.header?.parentSession ?? null, // 子代理会话标记（前端分 tab 管理）
        delegationDepth: s.header?.delegationDepth ?? 0,
      });
    }
    return out;
  }

  /** 释放内存：渠道会话按策略保留最近 N 个、其余卸下（落盘保数据）+ 清插件缓存 + 尽力 GC。 */
  async "tools.gc"() {
    const cleared = [];
    try { clearSearchCache(); cleared.push("搜索缓存"); } catch {}
    try { clearProjCache(); cleared.push("会话统计缓存"); } catch {}
    let released = 0;
    let extraNote = "";
    try {
      // 调 dsh-msg-hub 的渠道会话释放（保留最近 N 个活跃会话，其余 flush+dispose 卸下）
      const pushApi = this.ctx.get?.("dsh-channels-push");
      if (pushApi && typeof pushApi.release === "function") {
        const r = await pushApi.release();
        if (r && r.ok) released = Array.isArray(r.released) ? r.released.length : 0;
        else if (r && r.error) extraNote = "；会话释放：" + r.error;
      } else {
        extraNote = "；渠道插件未加载，跳过会话释放";
      }
    } catch (err) {
      extraNote = "；会话释放失败：" + String(err);
    }
    let gcRan = false;
    try {
      if (typeof global.gc === "function") { global.gc(); gcRan = true; }
    } catch {}
    return {
      ok: true,
      gcRan,
      released,
      cleared,
      note: (released > 0 ? `已释放 ${released} 个常驻渠道会话（保留最近活跃的几个，下次消息自动恢复）` : "没有需要释放的常驻会话")
        + (cleared.length > 0 ? `；已清空插件缓存（${cleared.join("/")}）` : "")
        + (gcRan ? "；已触发 GC" : "；dsh 未开启 --expose-gc，无法强制 GC——彻底释放需重启容器（compose NODE_OPTIONS 建议加 --expose-gc）")
        + extraNote,
    };
  }

  /** 调试信息：心跳运行状态 + live root agents 快照（排查渠道推送问题）。 */
  async "tools.debug"() {
    const agents = this.ctx.get("agents");
    const roots = [];
    try {
      if (agents && typeof agents.roots === "function") {
        for (const a of agents.roots()) {
          roots.push({ id: a.id, cwd: a?.session?.header?.cwd, followup: typeof a.followup === "function" });
        }
      }
    } catch {}
    return { ok: true, heartbeat: { ...heartbeatState }, agents: roots };
  }

  async "sessions.header"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    return s ? s.header : null;
  }

  async "sessions.delete"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    try {
      trashItem({ type: "session", name: s.sessionId, sourcePath: s.path, meta: { cwd: s.cwd } });
    } catch (err) {
      logErr("sessions.delete", err);
      throw err;
    }
    // 官方归档：左侧列表立即隐藏（live 内存残留也看不见）
    let archived = false;
    try {
      const reg = this.ctx.get("workspaceRegistry");
      if (reg && typeof reg.archiveSession === "function") {
        await reg.archiveSession(sessionId);
        archived = true;
      }
    } catch (err) {
      logErr("sessions.delete.archive", err);
    }
    return { ok: true, needRestart: !archived, archived };
  }

  /**
   * 清除所有空会话：官方轮数（turns）为 0 且非子代理会话。
   * 逐个复用 sessions.delete（移入回收站 + 官方归档隐藏）。
   */
  async "sessions.clearEmpty"() {
    const all = await listAllSessions();
    const empty = [];
    for (const s of all) {
      // 子代理会话跟随父会话管理，不作为独立条目清除
      if (s.header?.parentSession) continue;
      const stats = readSessionStatsLite(s.path, s.sessionId);
      if (stats.turns === 0) empty.push(s);
    }
    const items = [];
    let done = 0, failed = 0;
    for (const s of empty) {
      try {
        const r = await this["sessions.delete"](s.sessionId);
        if (r && r.ok === false) { failed += 1; items.push({ sessionId: s.sessionId, ok: false, error: r.error }); }
        else { done += 1; items.push({ sessionId: s.sessionId, ok: true }); }
      } catch (err) {
        failed += 1;
        items.push({ sessionId: s.sessionId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { found: empty.length, removed: done, failed, items };
  }

  async "sessions.copy"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const siblings = all.filter((x) => x.cwd === s.cwd).map((x) => x.sessionId);
    const newId = nextCopySuffix(s.sessionId, siblings);
    const sessions = this.ctx.get("sessions");
    try {
      // 官方 fork：store 感知，左侧立即可见
      await forkSession(sessions, s.sessionId, newId);
      return { ok: true, newSessionId: newId, method: "fork" };
    } catch (forkErr) {
      // 注意：不再文件复制兜底——copySession 单帧格式官方加载器不认（曾致会话列表崩溃）。
      // 前端复制已改走官方 fork API；此端点保留仅用于诊断。
      logErr("sessions.copy(fork)", forkErr);
      return { ok: false, error: "官方分叉失败：" + String(forkErr) };
    }
  }

  async "sessions.resetCwd"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const result = await resetSessionCwd(s.path, WORKSPACE_ROOT);
    if (!result.ok) return result;
    try {
      await syncWorkspaceAfterMove(this.ctx, sessionId, WORKSPACE_ROOT);
    } catch (err) {
      logErr("sessions.resetCwd.sync", err);
    }
    return { ...result, needRestart: true };
  }

  async "sessions.move"(targetCwd, sessionId) {
    // 已禁用（v0.1.20 兼容修复）：DSH 0.1.2-rc.1 中 GUI 打开过的会话由 Host 常驻激活，
    // 跨工作区移动会与 attach 校验冲突导致会话从官方列表消失。跨区移动请使用 dsh-session-xc。
    return { ok: false, error: "已禁用：当前 DSH 不支持跨工作区移动会话（常驻激活会导致会话丢失）。请使用 dsh-session-xc 会话增强插件。" };
  }

  async "sessions.detach"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const reg = this.ctx.get("workspaceRegistry");
    if (reg && reg.entities && typeof reg.entities.values === "function") {
      for (const e of [...reg.entities.values()]) {
        if (typeof e.detachSession !== "function") continue;
        try { await e.detachSession(sessionId); } catch (err) { logErr("sessions.detach", err); }
      }
    }
    return { ok: true, synced: true };
  }

  // ── 子目录管理 ──
  async "workspace.list"() {
    return refreshSessionCounts(listSubdirs());
  }

  async "workspace.create"(name) {
    return createSubdir(name);
  }

  async "workspace.rename"(oldName, newName) {
    const r = renameSubdir(oldName, newName);
    if (!r.ok) return r;
    // 会话 cwd 跟随：cwd 以旧目录为前缀的会话 → 更新为新路径（保持相对结构）
    const from = path.join(WORKSPACE_ROOT, oldName);
    const to = path.join(WORKSPACE_ROOT, newName);
    const all = await listAllSessions();
    let moved = 0;
    for (const s of all) {
      if (!(s.cwd === from || s.cwd.startsWith(from + path.sep))) continue;
      const newCwd = to + s.cwd.slice(from.length);
      const rr = await resetSessionCwd(s.path, newCwd);
      if (rr.ok) moved += 1;
    }
    return { ok: true, movedSessions: moved };
  }

  async "workspace.moveSessions"(name, targetCwd) {
    // 已禁用（v0.1.20 兼容修复）：与 sessions.move 同因（DSH 0.1.2-rc.1 常驻激活冲突）。
    return { ok: false, error: "已禁用：当前 DSH 不支持跨工作区移动会话（常驻激活会导致会话丢失）。请使用 dsh-session-xc 会话增强插件。" };
  }

  async "workspace.delete"(name, sessionsAction) {
    const target = path.join(WORKSPACE_ROOT, name);
    if (!fs.existsSync(target)) return { ok: false, error: "目录不存在" };
    // 关联会话：cwd 以该子目录开头的会话（会话文件在 sessions 区，不在子目录内）
    const all = await listAllSessions();
    const prefix = target;
    const related = all.filter((s) => s.cwd === prefix || s.cwd.startsWith(prefix + path.sep));
    trashItem({ type: "subdir", name, sourcePath: target });
    let moved = 0;
    if (sessionsAction === "trash") {
      // 一并进回收站
      for (const s of related) {
        trashItem({ type: "session", name: s.sessionId, sourcePath: s.path, meta: { cwd: s.cwd } });
        moved += 1;
      }
    } else if (sessionsAction === "reset") {
      // 会话重设到工作区根（避免 cwd 悬空）
      for (const s of related) {
        const r = await resetSessionCwd(s.path, WORKSPACE_ROOT);
        if (r.ok) moved += 1;
      }
    }
    return { ok: true, needRestart: true, relatedSessions: related.length, movedSessions: moved };
  }

  async "workspace.copy"(name) {
    return copySubdir(name);
  }

  // ── 搜索 ──
  async "search.query"(keyword, signal, fromIndex, dateFrom, dateTo) {
    const df = Number(dateFrom) > 0 ? Number(dateFrom) : 0;
    const dt = Number(dateTo) > 0 ? Number(dateTo) : 0;
    const reg = this.ctx.get("workspaceRegistry");
    let archivedIds = [];
    try { archivedIds = (reg && typeof reg.requireState === "function" && reg.requireState().archivedSessionIds) || []; } catch {}
    // 官方 SQLite 索引优先（省内存）；不可用时 searchAll 内部兜底全量扫描
    const sq = this.ctx.get("sessionQuery");
    const officialSearch = sq && typeof sq.searchSessions === "function"
      ? (kw, sig) => sq.searchSessions({ query: kw, limit: 400 }, { signal: sig }).then((p) => (p && p.items) || [])
      : undefined;
    const r = await searchAll(keyword, signal, df, dt, archivedIds, officialSearch);
    return { ok: true, hits: r.hits, partial: r.partial, scanned: r.scanned, total: r.total, usedOfficial: r.usedOfficial, memoryMB: r.memoryMB, cache: r.cache };
  }

  /** 语义搜索：embedding 查询；失败/无索引 → {ok:false, fallback:true}（前端降级关键词搜索）。 */
  async "search.embed"(keyword, signal) {
    const cfg = getConfig();
    if (cfg.embedEnabled === false) return { ok: false, fallback: true, error: "语义搜索已关闭（设置 → 工具箱 → 🧠 语义搜索 开启开关后使用）" };
    if (!String(cfg.embedApiKey || "").trim()) return { ok: false, fallback: true, error: "未配置 embedding API Key（设置 → 工具箱 → 🧠 语义搜索）" };
    try {
      // 命中后按需解压目标会话补内容预览（会话路径映射只建一次；按会话批量取）
      let sessionMap = null;
      const resolveSnippet = async (sessionId, seqs) => {
        if (!sessionMap) {
          sessionMap = new Map((await listAllSessions()).map((s) => [s.sessionId, s])); // 存整个会话对象（path+cwd）
        }
        const s = sessionMap.get(sessionId);
        return s ? readMessagesBySeqs(s.path, seqs) : {};
      };
      const result = await embedQuery(cfg, String(keyword || "").trim(), 20, signal, resolveSnippet);
      // 命中打分组标签：archived（归档）/ visible（主会话非归档）；子代理排除；trash 无索引
      if (result && result.ok && result.hits) {
        const reg = this.ctx.get("workspaceRegistry");
        let archivedIds = [];
        try { archivedIds = (reg && typeof reg.requireState === "function" && reg.requireState().archivedSessionIds) || []; } catch {}
        const archived = new Set(archivedIds);
        for (const h of result.hits) {
          const s = sessionMap && sessionMap.get(h.sessionId);
          if (!s) continue;
          if (s.header && s.header.parentSession) h.bucket = "subagent";
          else h.bucket = archived.has(h.sessionId) ? "archived" : "visible";
        }
        // 字面命中保底：snippet 包含搜索词（字面）→ 提到 0.99（embedding 短查询分数天然偏低，如「你是 dsh」仅 0.66）
        const kwLow = String(keyword || "").trim().toLowerCase();
        for (const h of result.hits) {
          if (h.snippet && kwLow && String(h.snippet).toLowerCase().includes(kwLow)) h.score = Math.max(h.score || 0, 0.99);
        }
        result.hits.sort((a, b) => b.score - a.score);
        // 最终阈值过滤（配置的 embedMinScore）+ 每桶独立 topN
        const finalMin = (Number(cfg.embedMinScore) || 80) / 100;
        const perBucket = new Map();
        const keep = [];
        for (const h of result.hits) {
          if (h.score < finalMin) continue;
          const n = perBucket.get(h.bucket) || 0;
          if (n >= 20) continue;
          perBucket.set(h.bucket, n + 1);
          keep.push(h);
        }
        result.hits = keep;
      }
      // 调试日志：snippet 命中统计（排查"无内容预览"用，稳定后移除）
      try {
        const hits = (result && result.hits) || [];
        fs.appendFileSync(
          path.join(PLUGIN_STATE_DIR, "search-debug.log"),
          new Date().toISOString() + " kw=" + String(keyword || "").slice(0, 24) + " ok=" + (result && result.ok) + " hits=" + hits.length + " withSnippet=" + hits.filter((h) => h && h.snippet).length + "\n",
        );
      } catch {}
      return result;
    } catch (err) {
      try {
        fs.appendFileSync(path.join(PLUGIN_STATE_DIR, "search-debug.log"), new Date().toISOString() + " ERROR " + String(err) + "\n");
      } catch {}
      return { ok: false, fallback: true, error: String(err) };
    }
  }

  /** 构建/增量更新语义索引（异步任务，前端调用后轮询状态）。 */
  async "search.embedBuild"() {
    const cfg = getConfig();
    try {
      const r = await buildEmbedIndex(cfg, listAllSessions, async (sessionPath, limit) => {
        const out = await listMessagesTail(sessionPath, limit); // 倒序逐帧，避免超大文件整体解压（内存飙升根源）
        return (out && out.messages) || [];
      });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** 列出 API 可用模型（供设置页「获取模型」）。 */
  async "search.embedModels"() {
    const cfg = getConfig();
    if (!String(cfg.embedApiKey || "").trim()) return { ok: false, error: "未配置 embedding API Key" };
    try {
      const r = await listEmbedModels(cfg);
      return { ok: true, models: r.ids, current: r.current };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** 测试连接（设置页「测试连接」按钮）。 */
  async "search.embedTest"() {
    const cfg = getConfig();
    if (!String(cfg.embedApiKey || "").trim()) return { ok: false, error: "未配置 embedding API Key" };
    try {
      const r = await testEmbedConnection(cfg);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** 语义索引状态。 */
  async "search.embedStatus"() {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(PLUGIN_STATE_DIR, "embed-index.json"), "utf-8"));
      let total = 0;
      for (const s of Object.values(idx.sessions || {})) total += (s.items || []).length;
      return { ok: true, total, builtAt: idx.builtAt || 0 };
    } catch {
      return { ok: true, total: 0, builtAt: 0 };
    }
  }

  async "officialSearch.get"() {
    return getOfficialSearchState();
  }

  async "officialSearch.set"(enabled) {
    return setOfficialSearch(Boolean(enabled));
  }

  // ── 自定义配置（绕开 dsh settings 白名单） ──
  async "config.get"() {
    return getConfig();
  }

  async "config.set"(key, value) {
    return setConfigField(key, value);
  }

  /** 全部设置恢复默认（设置页「恢复默认」按钮用）。 */
  async "config.reset"() {
    return resetConfig();
  }

  // ── 渠道配置转发（dsh-msg-hub 未安装时返回提示） ──
  async "channels.configGet"(channel, key) {
    try {
      const api = this.ctx.get("dsh-channels-push");
      if (!api || typeof api.getChannelConfig !== "function") return { ok: false, error: "dsh-msg-hub 未安装或未加载" };
      return api.getChannelConfig(channel, key);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async "channels.configSet"(channel, key, value) {
    try {
      const api = this.ctx.get("dsh-channels-push");
      if (!api || typeof api.setChannelConfig !== "function") return { ok: false, error: "dsh-msg-hub 未安装或未加载" };
      return api.setChannelConfig(channel, key, value);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** 渠道会话策略：读取全量（常驻开关/个数 + 继承条数；dsh-msg-hub 未安装时返回提示）。 */
  async "channels.cfgGet"() {
    try {
      const api = this.ctx.get("dsh-channels-push");
      if (!api || typeof api.getChannelCfg !== "function") return { ok: false, error: "dsh-msg-hub 未安装或未加载" };
      return api.getChannelCfg();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async "channels.cfgSet"(patch) {
    try {
      const api = this.ctx.get("dsh-channels-push");
      if (!api || typeof api.updateChannelCfg !== "function") return { ok: false, error: "dsh-msg-hub 未安装或未加载" };
      return api.updateChannelCfg(patch || {});
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // ── Agent 预设编辑 ──
  async "presets.list"() {
    return listPresets();
  }

  async "presets.read"(presetId, fileName) {
    return readPresetFile(presetId, fileName);
  }

  async "presets.save"(presetId, fileName, content) {
    return savePresetFile(presetId, fileName, content);
  }

  // ── 会话标签（插件自管标记，不碰 dsh 本体） ──
  async "tags.list"() {
    return listTags();
  }

  async "tags.set"(sessionId, tags) {
    return setSessionTags(sessionId, tags);
  }

  async "tags.remove"(tag) {
    return removeTag(tag);
  }

  async "tags.rename"(oldTag, newTag) {
    return renameTag(oldTag, newTag);
  }

  // ── 对话管理（截断/编辑，安全模型：只允许删尾或改尾） ──
  async "messages.list"(sessionId, limit) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    return listMessagesTail(s.path, limit || 20);
  }

  async "messages.truncate"(sessionId, seq) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { ok: false, error: "seq 无效" };
    return truncateSessionAt(s.path, seq);
  }

  async "messages.edit"(sessionId, seq, content) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { ok: false, error: "seq 无效" };
    if (typeof content !== "string" || !content.trim()) return { ok: false, error: "内容无效" };
    return editMessageAt(s.path, seq, content);
  }

  // ── 配置文件在线编辑（插件化，替代 dsh-patches 补丁） ──
  async "configfile.read"() {
    try {
      const settings = this.ctx.get("settings");
      if (!settings) return { ok: false, error: "settings 服务不可用" };
      const p = settings.documentPath;
      if (!p || !fs.existsSync(p)) return { ok: false, error: "配置文件不存在：" + String(p) };
      return { ok: true, path: p, content: fs.readFileSync(p, "utf-8") };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async "configfile.save"(content) {
    if (typeof content !== "string") return { ok: false, error: "内容无效" };
    try {
      // YAML 校验（与官方 saveDocument 一致：不可解析/非 map 根则拒绝）
      // js-yaml 为插件自身依赖（package.json dependencies），用 createRequire 解析
      const req = createRequire(import.meta.url);
      const yaml = req("js-yaml");
      const parsed = yaml.load(content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "配置必须是 YAML 映射（map）" };
      }
      const settings = this.ctx.get("settings");
      if (!settings) return { ok: false, error: "settings 服务不可用" };
      const p = settings.documentPath;
      if (!p) return { ok: false, error: "无配置文件路径" };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + ".tmp-" + Date.now();
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, p);
      return { ok: true, path: p, needRestart: true };
    } catch (err) {
      return { ok: false, error: "保存失败：" + String(err) };
    }
  }

  // ── 归档会话（dsh 官方 archivedSessionIds，左侧隐藏但文件还在） ──
  async "archived.list"() {
    const all = await listAllSessions();
    const reg = this.ctx.get("workspaceRegistry");
    const archived = [];
    if (reg && typeof reg.requireState === "function") {
      try {
        const ids = reg.requireState().archivedSessionIds || [];
        for (const id of ids) {
          const s = all.find((x) => x.sessionId === id);
          if (s) {
            const stats = readSessionStatsLite(s.path, s.sessionId);
            archived.push({
              sessionId: id,
              cwd: s.cwd,
              title: stats?.title ?? null,
              size: stats?.size ?? 0,
              turns: stats?.turns ?? 0,
            });
          }
        }
      } catch (err) {
        logErr("archived.list", err);
      }
    }
    return archived;
  }

  /** 归档 Tab 的删除：进回收站 + 从归档列表移除（不留残影）。 */
  async "archived.delete"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    try {
      trashItem({ type: "session", name: s.sessionId, sourcePath: s.path, meta: { cwd: s.cwd } });
    } catch (err) {
      logErr("archived.delete", err);
      throw err;
    }
    const reg = this.ctx.get("workspaceRegistry");
    if (reg && typeof reg.requireState === "function" && typeof reg.setState === "function") {
      try {
        const state = reg.requireState();
        if (Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
          await reg.setState({
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
          });
        }
      } catch (err) {
        logErr("archived.delete.unarchive", err);
      }
    }
    return { ok: true };
  }

  async "archived.restore"(sessionId) {
    const reg = this.ctx.get("workspaceRegistry");
    if (!reg || typeof reg.requireState !== "function" || typeof reg.setState !== "function") {
      return { ok: false, error: "workspace 服务不可用" };
    }
    try {
      const state = reg.requireState();
      if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(sessionId)) {
        return { ok: true, unchanged: true };
      }
      await reg.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      });
      return { ok: true, needRestart: true };
    } catch (err) {
      logErr("archived.restore", err);
      return { ok: false, error: String(err) };
    }
  }

  // ── 回收站 ──
  async "trash.list"() {
    const entries = listTrash();
    return entries.map((e) => {
      if (e.type !== "session" || !e.entryDir) return e;
      const file = path.join(e.entryDir, "data", "session.jsonl.zstd");
      if (!fs.existsSync(file)) return e;
      try {
        // 统计缓存：meta.json 里已存过且文件未变 → 直接复用（避免重复解压）
        const mtime = fs.statSync(file).mtimeMs;
        if (e.statsMtime === mtime && typeof e.stTitle === "string") {
          return { ...e, title: e.stTitle, size: e.stSize, turns: e.stTurns };
        }
        const stats = readSessionStats(path.join(e.entryDir, "data"));
        if (stats) {
          const metaPath = path.join(e.entryDir, "meta.json");
          const meta = { ...e, stTitle: stats.title, stSize: stats.size, stTurns: stats.turns, statsMtime: mtime };
          delete meta.title; delete meta.size; delete meta.turns;
          try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8"); } catch {}
          return { ...e, title: stats.title, size: stats.size, turns: stats.turns };
        }
      } catch {}
      return e;
    });
  }

  /** 查看回收站会话内容（只读，读 data 目录的会话文件）。 */
  async "trash.view"(entryDir, limit = 30) {
    const dataPath = path.join(entryDir, "data");
    if (!fs.existsSync(dataPath)) return { ok: false, error: "回收站条目数据缺失" };
    return listMessagesTail(dataPath, limit);
  }

  async "trash.restore"(entryDir) {
    const r = restoreTrashEntry(entryDir);
    if (r.ok) {
      try {
        const sessionId = sessionIdFromPath(r.restoredTo);
        if (sessionId) {
          const reg = this.ctx.get("workspaceRegistry");
          if (reg && typeof reg.requireState === "function" && typeof reg.setState === "function") {
            const state = reg.requireState();
            if (Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
              await reg.setState({
                ...state,
                archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
              });
            }
          } else {
            unarchiveSessionId(sessionId); // fallback：改 workspace.json（需重启）
          }
        }
      } catch (err) {
        logErr("trash.restore.unarchive", err);
      }
    }
    return r;
  }

  async "trash.empty"() {
    return emptyTrash();
  }

  async "trash.purge"(entryDir) {
    try {
      fs.rmSync(entryDir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

/** 构造 invocation descriptor（strict 路径）。 */
function invocation(method, params = [], cancellation = false) {
  return {
    id: `dsh-toolbox#${method}`,
    service: "dsh-toolbox-api",
    namespace: "dsh-toolbox",
    method,
    invocation: { kind: "direct" },
    parameters: params.map((wire) => ({
      name: wire,
      wire,
      source: "json",
      codec: { mode: "src-json" },
    })),
    ...(cancellation ? { cancellation: { parameter: "signal" } } : {}),
    result: { mode: "src-json" },
  };
}

/** 从恢复路径提取会话 id（路径 → header.id）。 */
function sessionIdFromPath(sessionPathOrId) {
  if (!sessionPathOrId) return null;
  const p = String(sessionPathOrId).replace(/\/$/, "");
  if (fs.existsSync(path.join(p, "session.jsonl.zstd"))) {
    try {
      const text = decompressFirstFrame(path.join(p, "session.jsonl.zstd"));
      const first = JSON.parse(text.trim().split("\n")[0]);
      if (first && first.id) return first.id;
    } catch {}
  }
  return null;
}

/** 从 workspace.json 的 archivedSessionIds 移除指定会话（fallback，重启后生效）。 */
function unarchiveSessionId(sessionId) {
  const file = path.join(process.env.DSH_HOME || "/home/dsh", "storages", "workspace.json");
  if (!fs.existsSync(file)) return;
  const j = JSON.parse(fs.readFileSync(file, "utf-8"));
  const arr = j.global && j.global.archivedSessionIds;
  if (!Array.isArray(arr)) return;
  const idx = arr.indexOf(sessionId);
  if (idx < 0) return;
  arr.splice(idx, 1);
  const tmp = file + ".tmp-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** 移动/重设后同步 workspace 归属：从所有工作区 detach，再 attach 到匹配新 cwd 的工作区。
 * 匹配规则：新 cwd 是注册工作区 → attach 它；是注册工作区的子路径 → attach 父工作区；
 * 否则不 attach（左侧显示"未分组"）。 */
async function syncWorkspaceAfterMove(ctx, sessionId, newCwd) {
  const reg = ctx.get("workspaceRegistry");
  if (!reg) return { ok: true, synced: false };
  let entities = [];
  try {
    entities = reg.entities && typeof reg.entities.values === "function" ? [...reg.entities.values()] : [];
  } catch (e) {
    logErr("sync.detach.list", e);
  }
  // detach 全部（detachSession 幂等，只移除包含它的）
  for (const e of entities) {
    if (typeof e.detachSession !== "function") continue;
    try { await e.detachSession(sessionId); } catch (err) { logErr("sync.detach", err); }
  }
  // attach 匹配工作区：精确匹配或子路径归属
  let attached = false;
  for (const e of entities) {
    const p = e.record && e.record.path;
    if (typeof p !== "string") continue;
    if (newCwd === p || newCwd.startsWith(p + "/")) {
      if (typeof e.attachSession === "function") {
        try { await e.attachSession(sessionId); attached = true; } catch (err) { logErr("sync.attach", err); }
      }
      break;
    }
  }
  return { ok: true, synced: true, attached };
}

/** 错误落盘日志（排查用，写插件 state/err.log）。 */
function logErr(where, err) {
  try {
    fs.appendFileSync(
      path.join(PLUGIN_STATE_DIR, "err.log"),
      new Date().toISOString() + " [" + where + "] " + String(err && (err.stack || err.message) ? (err.stack || err.message) : err) + "\n",
      "utf-8",
    );
  } catch {}
}

export function apply(ctx, config) {
  const log = ctx.logger;

  // ── 0. 启动探针（排查 client 加载） ──
  try {
    fs.mkdirSync(PLUGIN_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_STATE_DIR, "started.log"), new Date().toISOString() + " dsh-toolbox apply 执行\n", "utf-8");
    try {
      const cm = ctx.get("clientModules");
      if (cm) {
        const g = cm.graph();
        fs.writeFileSync(path.join(PLUGIN_STATE_DIR, "graph.log"),
          "entries: " + JSON.stringify((g.entries || []).map((e) => e.id)) + "\n", "utf-8");
      } else {
        fs.appendFileSync(path.join(PLUGIN_STATE_DIR, "graph.log"), "clientModules 服务不可用\n", "utf-8");
      }
    } catch (graphErr) {
      fs.appendFileSync(path.join(PLUGIN_STATE_DIR, "graph.log"), "graph 读取失败: " + String(graphErr) + "\n", "utf-8");
    }
  } catch (probeErr) {
    console.error("dsh-toolbox 探针失败:", String(probeErr));
  }

  // ── 1. 设置项注册 ──
  ctx.inject(["settings"], (settingsCtx) => {
    registerToolsSettings(settingsCtx.settings);
    log.info(`dsh-toolbox: 已注册 ${TOOL_SWITCHES.length} 个功能开关`);
  });

  // ── 2. 服务注册 + 端点声明 ──
  // 注意：Service 构造时已自动注册（provide(name, this)），这里只需实例化
  new ToolsApi(ctx);
  ctx.typert.register({
    package: "dsh-toolbox",
    face: "host",
    schemas: [],
    invocations: [
      invocation("info"),
      invocation("sessions.list"),
      invocation("sessions.header", ["sessionId"]),
      invocation("sessions.delete", ["sessionId"]),
      invocation("sessions.clearEmpty"),
      invocation("sessions.copy", ["sessionId"]),
      invocation("sessions.resetCwd", ["sessionId"]),
      invocation("sessions.move", ["targetCwd", "sessionId"]),
      invocation("sessions.detach", ["sessionId"]),
      invocation("workspace.list"),
      invocation("workspace.create", ["name"]),
      invocation("workspace.rename", ["oldName", "newName"]),
      invocation("workspace.moveSessions", ["name", "targetCwd"]),
      invocation("workspace.delete", ["name", "sessionsAction"]),
      invocation("workspace.copy", ["name"]),
      invocation("search.query", ["keyword", "fromIndex", "dateFrom", "dateTo"], true),
      invocation("search.embed", ["keyword"], true),
      invocation("search.embedBuild"),
      invocation("search.embedStatus"),
      invocation("search.embedModels"),
      invocation("search.embedTest"),
      invocation("officialSearch.get"),
      invocation("officialSearch.set", ["enabled"]),
      invocation("config.get"),
      invocation("config.set", ["key", "value"]),
      invocation("config.reset"),
      invocation("channels.configGet", ["channel", "key"]),
      invocation("channels.configSet", ["channel", "key", "value"]),
      invocation("channels.cfgGet"),
      invocation("channels.cfgSet", ["patch"]),
      invocation("presets.list"),
      invocation("presets.read", ["presetId", "fileName"]),
      invocation("presets.save", ["presetId", "fileName", "content"]),
      invocation("tags.list"),
      invocation("tags.set", ["sessionId", "tags"]),
      invocation("tags.remove", ["tag"]),
      invocation("tags.rename", ["oldTag", "newTag"]),
      invocation("messages.list", ["sessionId", "limit"]),
      invocation("messages.truncate", ["sessionId", "seq"]),
      invocation("messages.edit", ["sessionId", "seq", "content"]),
      invocation("configfile.read"),
      invocation("configfile.save", ["content"]),
      invocation("archived.list"),
      invocation("archived.restore", ["sessionId"]),
      invocation("archived.delete", ["sessionId"]),
      invocation("trash.list"),
      invocation("trash.view", ["entryDir", "limit"]),
      invocation("trash.restore", ["entryDir"]),
      invocation("trash.empty"),
      invocation("trash.purge", ["entryDir"]),
      invocation("tools.gc"),
      invocation("tools.debug"),
    ],
  });
  log.info("dsh-toolbox: API 已注册（19 端点）");

  // ── 3. 回收站自动清除（TTL 读设置，启动一次 + 每 6 小时） ──
  let retentionDays = 30;
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings
      .get(settingsNamespace(TOOLS_NAMESPACE))
      .then((doc) => {
        retentionDays = doc?.trashRetentionDays ?? 30;
      })
      .catch(() => {});
  });
  const stopTrash = startTrashWatcher(() => retentionDays);
  ctx.on("dispose", stopTrash);

  // ── 4. 定时心跳（类似 OpenClaw 心跳模式）：定期向主工作区 live agent 注入用户消息唤醒执行 ──
  // 消息构造与官方 dsh-schedule 一致（role:user + source.plugin），无需依赖 dsh-llm。
  let lastBeatAt = 0;
  let heartbeatTimer = null;
  const HEART_LOG = path.join(PLUGIN_STATE_DIR, "heartbeat.log");
  const logHeart = (msg) => { try { fs.appendFileSync(HEART_LOG, new Date().toISOString() + " " + msg + "\n", "utf-8"); } catch {} };
  const doHeartbeat = async (targetOpt, promptOpt) => {
    try {
      const cfg = getConfig();
      if (!cfg.scheduleTask) return;
      const agents = ctx.agents;
      if (!agents || typeof agents.roots !== "function") return;
      const base = String(promptOpt ?? cfg.schedulePrompt ?? "").trim() ||
        "【定时心跳】请检查当前是否有待办、提醒或需要主动汇报的事项；如有请简要汇报，没有则简短确认即可。";
      const text = base.replace(/\{time\}/g, new Date().toLocaleString("zh-CN", { hour12: false }));
      const message = {
        role: "user",
        id: crypto.randomUUID(),
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-toolbox" },
      };
      let injected = 0;
      // 目标会话：调用方传入（间隔=scheduleTarget / 定点=scheduleCronTarget），空 = 主工作区根
      const target = String(targetOpt ?? "").trim();
      heartbeatState.lastBeatAt = Date.now();
      heartbeatState.lastTarget = target || "(主工作区根)";
      if (target.startsWith("ch-")) {
        // 渠道推送：调 dsh-msg-hub 的 ChannelsPushApi（唤醒渠道 agent 执行，回复回传 IM）
        // 渠道解析优先用服务的适配器注册表（支持第三方注册渠道），静态前缀兜底
        const pushSvc = ctx.get("dsh-channels-push");
        let parsed = null;
        try { parsed = pushSvc && typeof pushSvc.resolveChannel === "function" ? pushSvc.resolveChannel(target) : null; } catch {}
        if (!parsed) parsed = parseChannelTarget(target);
        if (pushSvc && parsed) {
          const r = await pushSvc.task({ channel: parsed.channel, peerId: parsed.peerId, prompt: text });
          heartbeatState.lastResult = r && r.ok ? "已推送渠道 " + target : "渠道推送失败：" + ((r && r.error) || "未知");
          logHeart((r && r.ok ? "渠道推送 OK → " : "渠道推送失败 → ") + target + (r && r.error ? " (" + r.error + ")" : ""));
          injected = r && r.ok ? 1 : 0;
        } else {
          heartbeatState.lastResult = "渠道推送服务不可用或目标无法解析（需 dsh-channels 提供 dsh-channels-push）";
          logHeart("渠道推送不可用：" + target);
        }
      } else if (target) {
        // 查找目标 agent：优先 registry 直查，再 roots 遍历（渠道 agent 可能不在 roots）
        let agent = null;
        try { if (typeof agents.get === "function") agent = agents.get(target); } catch {}
        if (!agent) agent = agents.roots().find((a) => a.id === target) || null;
        if (agent && typeof agent.followup === "function") {
          await agent.followup(message);
          injected = 1;
          heartbeatState.lastResult = "已注入 " + target;
          logHeart("心跳注入 OK → " + target);
        } else {
          const ids = agents.roots().map((a) => a.id).join(" | ");
          heartbeatState.lastResult = "未找到目标（roots: " + ids.slice(0, 300) + "）";
          logHeart("心跳未找到目标 " + target + "；当前 roots: " + ids);
          log.info(`dsh-toolbox: 定时心跳目标会话未找到 ${target}（roots: ${ids}）`);
        }
      } else {
        for (const agent of agents.roots()) {
          try {
            // 只心跳主工作区根的 live agent；渠道（ch-*）与子代理跳过
            const cwd = agent?.session?.header?.cwd;
            if (cwd && cwd !== WORKSPACE_ROOT) continue;
            if (agent.id && String(agent.id).startsWith("ch-")) continue;
            if (typeof agent.followup === "function") {
              await agent.followup(message);
              injected += 1;
            }
          } catch (e) {
            logErr("heartbeat.followup", e);
          }
        }
        heartbeatState.lastResult = "已注入 " + injected + " 个会话（主工作区根）";
      }
      if (injected > 0) log.info(`dsh-toolbox: 定时心跳已注入 ${injected} 个会话`);
    } catch (e) {
      heartbeatState.lastResult = "异常: " + String(e).slice(0, 200);
      logErr("heartbeat", e);
    }
  };
  // 调度器：每 60 秒检查一次设置；开关开且距上次 ≥ 间隔（最小 5 分钟）→ 心跳；
  // 另检查定点定时（每天/每周/每月，分钟级，同分钟不重复触发）
  let lastCronKey = "";
  const checkCron = async () => {
    try {
      const cfg = getConfig();
      if (!cfg.scheduleTask) return;
      let cron = null;
      try {
        const raw = String(cfg.scheduleCron || "off").trim();
        if (raw !== "off") cron = JSON.parse(raw);
      } catch {}
      if (!cron || cron.type === "off" || !cron.time) return;
      const now = new Date();
      const hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
      if (hm !== String(cron.time)) return;
      if (cron.type === "weekly" && now.getDay() !== Number(cron.day)) return;
      if (cron.type === "monthly" && now.getDate() !== Number(cron.date)) return;
      const key = now.toISOString().slice(0, 16);
      if (key === lastCronKey) return;
      lastCronKey = key;
      log.info("dsh-toolbox: 定点定时触发 " + JSON.stringify(cron));
      await doHeartbeat(cfg.scheduleCronTarget, cfg.scheduleCronPrompt);
    } catch (e) {
      logErr("heartbeat.cron", e);
    }
  };
  let prevTaskOn = null; // 开关状态跟踪：刚打开时开始计时，不立即触发
  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      try {
        const cfg = getConfig();
        const taskOn = cfg.scheduleTask === true;
        if (taskOn && prevTaskOn === false) lastBeatAt = Date.now(); // 刚打开：从现在起算
        prevTaskOn = taskOn;
        heartbeatState.running = taskOn;
        if (!taskOn) {
          lastBeatAt = 0;
          heartbeatState.nextIntervalBeatAt = null;
          heartbeatState.nextCronAt = null;
          return;
        }
        const minutes = Math.max(5, Math.floor(Number(cfg.scheduleInterval) || 60));
        // 下次触发时间（tools.debug 读取，前端倒计时用）
        heartbeatState.nextIntervalBeatAt = lastBeatAt ? lastBeatAt + minutes * 60 * 1000 : null;
        heartbeatState.nextCronAt = nextCronTime(cronFromCfg(cfg), new Date());
        if (Date.now() - lastBeatAt >= minutes * 60 * 1000) {
          lastBeatAt = Date.now();
          heartbeatState.nextIntervalBeatAt = lastBeatAt + minutes * 60 * 1000;
          await doHeartbeat(cfg.scheduleTarget);
        }
        await checkCron();
      } catch (e) {
        logErr("heartbeat.scheduler", e);
      }
    }, 60 * 1000);
    heartbeatTimer.unref?.();
  };
  startHeartbeat();
  ctx.on("dispose", () => { if (heartbeatTimer) clearInterval(heartbeatTimer); });
}
