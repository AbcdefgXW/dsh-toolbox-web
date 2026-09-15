/**
 * zstd.js — 会话文件压缩/解压（后端）
 *
 * dsh 会话文件 = 多帧 zstd 拼接（header 帧 + 每批次一个事件帧），用 Node 内置
 * node:zlib（Node 22.13+）。注意：
 * - zstdDecompressSync 只解第一个完整帧 → 必须逐帧解压（官方 scanZstdFrames 算法）。
 * - 压缩参数与官方一致：带 checksum（constants.ZSTD_c_checksumFlag: 1）。
 */
import fs from "node:fs";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE
/** 与 dsh-session-persistence-jsonl 一致的压缩参数。 */
export const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** 扫描完整帧边界（复刻官方 scanZstdFrames）。 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    const start = offset;
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      offset += blockType === 1 ? 1 : blockHeader >>> 3;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 解压会话文件全部帧 → UTF-8 文本。 */
export function decompressSessionFile(file) {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) {
    // 单帧场景（如我们自己写回的）：直接整体解
    return zstdDecompressSync(buf).toString("utf-8");
  }
  const pieces = [];
  for (const fr of frames) pieces.push(zstdDecompressSync(buf.subarray(fr.start, fr.end)));
  return Buffer.concat(pieces).toString("utf-8");
}

/** 只解第一帧（读 header 用）。
 * 【性能】第一帧是「恰好一行 header」的压缩块（见 compressSessionText），体积很小；
 * 原先 readFileSync 读入整个会话文件（最大 16MB）再扫描全部帧，只为取头部数据——
 * 217 个会话实测累计约 9s（会话列表 / 子目录计数都走这里）。现改为只读文件头 64KB。
 * 只有在头部窗口内拿不到完整帧（异常情况）才回退为完整读取。 */
export function decompressFirstFrame(file) {
  const HEAD_BYTES = 64 * 1024;
  let buf = null;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(HEAD_BYTES, size);
      buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, 0);
      if (read < len) buf = buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    buf = null;
  }
  if (buf && buf.length) {
    const frames = scanZstdFrames(buf);
    if (frames.length > 0) {
      try {
        return zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf-8");
      } catch {
        /* 落到下面的完整读取兜底 */
      }
    }
  }
  // 兜底：头部窗口不足以解出第一帧（或读取失败）时读整个文件
  const full = fs.readFileSync(file);
  const frames = scanZstdFrames(full);
  if (frames.length === 0) return zstdDecompressSync(full).toString("utf-8");
  return zstdDecompressSync(full.subarray(frames[0].start, frames[0].end)).toString("utf-8");
}

/** 压缩为官方格式：第一帧 = 恰好一行 header，后续每 500 行一个事件批次帧。
 * 注意：官方加载器要求第一帧解出恰好一行（assertZstdHeaderFrame），
 * 单帧全压会导致 dsh 扫描崩溃（会话列表全消失）。 */
export function compressSessionText(text) {
  const lines = text.split("\n");
  const header = lines[0] || "";
  const rest = lines.slice(1);
  const frames = [zstdCompressSync(header + "\n", CHECKSUM_OPTIONS)];
  for (let i = 0; i < rest.length; i += 500) {
    const chunk = rest.slice(i, i + 500).join("\n");
    frames.push(zstdCompressSync(chunk + (chunk ? "\n" : ""), CHECKSUM_OPTIONS));
  }
  return Buffer.concat(frames);
}
