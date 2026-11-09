import fs from "node:fs";
import path from "node:path";

/**
 * Read complete lines appended to `file` since byte `offset`, at most ~`maxBytes` per call
 * (callers loop while `more` is true). Resets to 0 if the file shrank (rewritten).
 */
export function readAppended(
  file: string,
  offset: number,
  maxBytes = 16 * 1024 * 1024,
): { lines: string[]; newOffset: number; reset: boolean; more: boolean } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], newOffset: offset, reset: false, more: false };
  }
  let reset = false;
  if (size < offset) {
    offset = 0;
    reset = true;
  }
  if (size === offset) return { lines: [], newOffset: offset, reset, more: false };
  const fd = fs.openSync(file, "r");
  try {
    let want = Math.min(size - offset, maxBytes);
    while (true) {
      const buf = Buffer.alloc(want);
      let read = 0;
      while (read < want) {
        const n = fs.readSync(fd, buf, read, want - read, offset + read);
        if (n <= 0) break;
        read += n;
      }
      const lastNl = read > 0 ? buf.lastIndexOf(0x0a, read - 1) : -1;
      if (lastNl < 0) {
        // a single line longer than the window: grow the window, or wait for the line to complete
        if (offset + want < size) {
          want = Math.min(size - offset, want * 2);
          continue;
        }
        return { lines: [], newOffset: offset, reset, more: false };
      }
      const text = buf.subarray(0, lastNl).toString("utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const newOffset = offset + lastNl + 1;
      return { lines, newOffset, reset, more: newOffset < size };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the last `maxLines` complete lines of a file without loading it entirely. */
export function readTailLines(file: string, maxLines: number, chunk = 1024 * 1024): string[] {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return [];
  }
  if (!size) return [];
  const fd = fs.openSync(file, "r");
  try {
    let pos = size;
    let acc = Buffer.alloc(0);
    let count = 0;
    while (pos > 0 && count <= maxLines) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      acc = Buffer.concat([buf, acc]);
      count = 0;
      for (let i = 0; i < acc.length; i++) if (acc[i] === 0x0a) count++;
    }
    const lines = acc.toString("utf8").split("\n").filter((l) => l.trim());
    if (pos > 0) lines.shift(); // first line may be partial
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

export function parseJsonLine<T = any>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/** Read the first line of a file efficiently (up to maxBytes). */
export function readFirstLine(file: string, maxBytes = 1 << 20): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (n <= 0) break;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, nl)));
        break;
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(parts).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Atomically write a file (tmp + rename). */
export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.amux-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

export function appendLines(file: string, lines: string[]): void {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.join("\n") + "\n");
}
