/**
 * messages.js — 对话管理（后端）
 *
 * 安全模型（只支持两种操作）：
 * - truncate：删除目标消息及其后所有事件（seq 连续，结构完整，相当于"重来"）
 * - edit：修改目标消息文本 + 删除其后所有事件（避免新旧上下文矛盾）
 * 绝不支持"删中间留后面"（seq 断裂会损坏会话）。
 * 重写用官方多帧格式（header 帧恰好一行 + 事件批次帧）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressSessionText, decompressSessionFile, scanZstdFrames } from "./zstd.js";
import { resolveSessionLog } from "./sessions.js";
import { zstdDecompressSync } from "node:zlib";

const BACKUP_ROOT = path.join(fileURLToPath(new URL("../", import.meta.url)), "state", "backups");

/** 操作前备份原会话文件（保留最近 20 份）。 */
function backupFile(file) {
  try {
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    const name = path.basename(path.dirname(file)) + "-" + Date.now() + ".zstd";
    fs.copyFileSync(file, path.join(BACKUP_ROOT, name));
    // 清理：只保留最近 20 个
    const all = fs.readdirSync(BACKUP_ROOT).sort();
    while (all.length > 20) {
      fs.rmSync(path.join(BACKUP_ROOT, all.shift()), { force: true });
    }
    return name;
  } catch {
    return null;
  }
}

/** 提取事件的消息文本（兼容三种结构：data.message.content / data.content / 字符串）。 */
function messageText(data) {
  const raw = data && (data.message && data.message.content !== undefined ? data.message.content : data.content);
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** 列出最近 N 条消息（含 seq/角色/时间/内容）。 */
export function listMessages(sessionPath, limit = 20) {
  const file = path.join(sessionPath, "session.jsonl.zstd");
  if (!fs.existsSync(file)) return { ok: false, error: "会话文件不存在" };
  let text;
  try {
    text = decompressSessionFile(file);
  } catch (e) {
    return { ok: false, error: "读取失败：" + e.message };
  }
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "user/message" && ev.type !== "assistant/message") continue;
    const content = messageText(ev.data);
    if (!content) continue;
    messages.push({
      seq: ev.seq,
      role: ev.type === "user/message" ? "user" : "assistant",
      time: ev.time,
      content,
    });
  }
  // 从后往前取 limit 条（返回正序）
  const tail = messages.slice(-limit);
  return { ok: true, messages: tail, total: messages.length, path: sessionPath };
}

/**
 * 列出最近 N 条消息（倒序逐帧解压，内存峰值 = 单帧；超大文件不整体解压）。
 * 适合索引构建/消息列表等大会话场景；total 无法廉价获得（返回 -1）。
 */
export function listMessagesTail(sessionPath, limit = 20) {
  // 【修正】官方加载器只认「最高代」日志（v0 = session.jsonl.zstd；vN = session.v<N>.jsonl.zstd）。
  // 旧实现硬编码 session.jsonl.zstd，导致迁移到 v3 代之后的会话取不到最新消息预览（返回"会话文件不存在"）。
  const log = resolveSessionLog(sessionPath);
  const file = log ? log.file : path.join(sessionPath, "session.jsonl.zstd");
  if (!fs.existsSync(file)) return { ok: false, error: "会话文件不存在" };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, error: "读取失败：" + e.message };
  }
  const frames = scanZstdFrames(buf);
  const messages = [];
  const collectTail = (text) => {
    const lines = text.split("\n");
    for (let j = lines.length - 1; j >= 0 && messages.length < limit; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type !== "user/message" && ev.type !== "assistant/message") continue;
      const content = messageText(ev.data);
      if (!content) continue;
      messages.push({ seq: ev.seq, role: ev.type === "user/message" ? "user" : "assistant", time: ev.time, content });
    }
  };
  if (frames.length === 0) {
    try {
      collectTail(zstdDecompressSync(buf).toString("utf-8"));
    } catch (e) {
      return { ok: false, error: "解压失败：" + e.message };
    }
    messages.reverse();
    return { ok: true, messages, total: -1, path: sessionPath };
  }
  // 倒序遍历帧：最新消息在尾部
  for (let i = frames.length - 1; i >= 0 && messages.length < limit; i--) {
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString("utf-8");
    } catch {
      continue;
    }
    collectTail(text);
  }
  messages.reverse();
  return { ok: true, messages, total: -1, path: sessionPath };
}

/** 截断：保留 seq < atSeq 的所有事件（删除目标消息及其后全部）。 */
export function truncateSessionAt(sessionPath, atSeq) {
  const file = path.join(sessionPath, "session.jsonl.zstd");
  if (!fs.existsSync(file)) return { ok: false, error: "会话文件不存在" };
  const backup = backupFile(file);
  const text = decompressSessionFile(file);
  const lines = text.split("\n");
  const keep = [];
  let header = null;
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (header === null) {
      header = ev; // 首行 header 保留
      keep.push(line);
      continue;
    }
    if (typeof ev.seq === "number" && ev.seq >= atSeq) {
      removed += 1;
      continue;
    }
    keep.push(line);
  }
  if (header === null) return { ok: false, error: "文件结构异常" };
  const out = compressSessionText(keep.join("\n"));
  fs.writeFileSync(file, out);
  return { ok: true, removed, kept: keep.length, backup };
}

/** 编辑：替换目标消息文本 + 删除其后所有事件（该消息保留）。 */
export function editMessageAt(sessionPath, atSeq, content) {
  const file = path.join(sessionPath, "session.jsonl.zstd");
  if (!fs.existsSync(file)) return { ok: false, error: "会话文件不存在" };
  const backup = backupFile(file);
  const text = decompressSessionFile(file);
  const lines = text.split("\n");
  const out = [];
  let header = null;
  let edited = false;
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (header === null) {
      header = ev;
      out.push(line);
      continue;
    }
    if (typeof ev.seq === "number" && ev.seq > atSeq) {
      removed += 1;
      continue; // 目标之后全删
    }
    if (typeof ev.seq === "number" && ev.seq === atSeq) {
      if (ev.type !== "user/message" && ev.type !== "assistant/message") {
        return { ok: false, error: "目标不是消息事件" };
      }
      ev.data = ev.data || {};
      ev.data.message = ev.data.message || {};
      const raw = ev.data.message.content;
      if (Array.isArray(raw)) {
        const textBlocks = raw.filter((b) => b && b.type === "text");
        if (textBlocks.length === 0) raw.push({ type: "text", text: content });
        else {
          textBlocks[0].text = content;
          // 删除多余 text block，保留非 text（如图片）
          ev.data.message.content = [textBlocks[0], ...raw.filter((b) => !b || b.type !== "text")];
        }
      } else {
        ev.data.message.content = [{ type: "text", text: content }];
      }
      out.push(JSON.stringify(ev));
      edited = true;
      continue;
    }
    out.push(line);
  }
  if (header === null) return { ok: false, error: "文件结构异常" };
  if (!edited) return { ok: false, error: "未找到目标消息（seq " + atSeq + "）" };
  const outText = compressSessionText(out.join("\n"));
  fs.writeFileSync(file, outText);
  return { ok: true, edited: true, removed, backup };
}
