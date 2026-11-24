import { Database } from "bun:sqlite";
import { type BigIntStats, closeSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256 } from "../redaction";
import { forgottenPath, spoolPath } from "./spool";

export class ExpiredDelivery extends Error {}

function forgetVersion(spool: string): string {
  // forget appends one fixed-width generation. A failed forget rolls that
  // append back; comparing contents lets an in-flight delivery still finish.
  let fd: number;
  try {
    fd = openSync(forgottenPath(spool), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    const tail = Buffer.alloc(Math.min(size, 65));
    if (readSync(fd, tail, 0, tail.length, size - tail.length) !== tail.length) throw new Error("short forget marker read");
    return size + "/" + tail.toString("hex");
  } finally {
    closeSync(fd);
  }
}

// The dispatching client owns one ticket until all attempts for its invocation
// have ended. Only its opaque name crosses the worker boundary. The caller
// creates a fresh ticket for every independent invocation, even identical input.
export function createHookDelivery(spoolDir: string, sessionId: string) {
  const spool = spoolPath(spoolDir, sessionId);
  if (!spool) throw new Error("empty session id");
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(spoolDir, ".delivery-"));
  try {
    writeFileSync(join(dir, "owner"), JSON.stringify({ id: crypto.randomUUID(), session: sha256(sessionId), forget: forgetVersion(spool) }), { mode: 0o600, flag: "wx" });
    new Database(join(dir, "gate"), { create: true }).close();
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    ticket: basename(dir),
    close() {
      const owner = statSync(join(dir, "owner"), { bigint: true, throwIfNoEntry: false });
      if (!owner) return;
      releaseOwnedLock(spool + ".lock", owner);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

type Receipt = {
  session: string;
  file: string;
  offset: number;
  length: number;
  digest: string;
  seq: number;
  hash: string;
  truncated: boolean;
};

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs].join("/");
}

export class Delivery {
  constructor(readonly directory: string, readonly session: string, readonly id: string) {}

  prior(path: string): Pick<Receipt, "seq" | "hash" | "truncated"> | undefined {
    let receipt: Receipt;
    try {
      receipt = JSON.parse(readFileSync(join(this.directory, "receipt"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (receipt.session !== this.session) throw new Error("delivery belongs to a different session");
    // Opening without O_CREAT matters: a retry after forget must never resurrect
    // the removed spool. New invocations have their own ticket.
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExpiredDelivery("delivery spool was removed");
      throw error;
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (identity(stat) !== receipt.file || stat.size < receipt.offset) throw new ExpiredDelivery("delivery spool was replaced");
      // JSONL readers accept a complete final record without its newline.
      // A short write can leave exactly those bytes on disk.
      const available = stat.size - BigInt(receipt.offset);
      if (available < BigInt(receipt.length - 1)) return;
      const needsNewline = available === BigInt(receipt.length - 1);
      const bytes = Buffer.alloc(receipt.length - Number(needsNewline));
      const count = readSync(fd, bytes, 0, bytes.length, receipt.offset);
      if (count !== bytes.length) throw new Error("short delivery receipt read");
      if (sha256(bytes.toString("utf8") + (needsNewline ? "\n" : "")) === receipt.digest) return receipt;
      // A worker died before completing its write and another hook advanced the tail.
      return;
    } finally {
      closeSync(fd);
    }
  }

  prepare(fd: number, bytes: string, seq: number, hash: string, truncated: boolean): void {
    const stat = fstatSync(fd, { bigint: true });
    const receipt: Receipt = { session: this.session, file: identity(stat), offset: Number(stat.size), length: Buffer.byteLength(bytes), digest: sha256(bytes), seq, hash, truncated };
    const pending = join(this.directory, "pending");
    writeFileSync(pending, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(pending, join(this.directory, "receipt"));
  }
}

function releaseOwnedLock(lock: string, mine: BigIntStats): void {
  const held = statSync(lock, { bigint: true, throwIfNoEntry: false });
  if (held?.dev === mine.dev && held.ino === mine.ino) unlinkSync(lock);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

// SQLite serializes attempts for this one ticket and releases the transaction
// on process exit. The existing spool lock still serializes separate tickets,
// ordinary hooks, audits, and forget. A hard link identifies our own abandoned
// lock atomically, including a death immediately after acquisition.
export function withDelivery<T>(spoolDir: string, spoolFile: string, ticket: string, sessionId: string, timeout: number, fn: (delivery: Delivery) => T): T {
  if (!/^\.delivery-[A-Za-z0-9]{6}$/.test(ticket)) throw new Error("invalid delivery ticket");
  const dir = join(spoolDir, ticket);
  const owner = join(dir, "owner");
  const lock = spoolFile + ".lock";
  const deadline = performance.now() + timeout;
  const db = new Database(join(dir, "gate"), { readwrite: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.round(timeout))}`);
    db.exec("BEGIN IMMEDIATE");
    const mine = statSync(owner, { bigint: true });
    // Refresh the legacy lease just before trying to publish the owner inode.
    utimesSync(owner, new Date(), new Date());
    for (;;) {
      try {
        linkSync(owner, lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        const held = statSync(lock, { bigint: true });
        if (held.dev === mine.dev && held.ino === mine.ino) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (performance.now() >= deadline) throw new Error("delivery spool lock timed out");
      Atomics.wait(sleeper, 0, 0, 2);
    }
    try {
      const binding = JSON.parse(readFileSync(owner, "utf8"));
      if (binding.session !== sha256(sessionId)) throw new Error("delivery belongs to a different session");
      if (binding.forget !== forgetVersion(spoolFile)) throw new ExpiredDelivery("session was forgotten during delivery");
      return fn(new Delivery(dir, binding.session, binding.id));
    } finally {
      releaseOwnedLock(lock, mine);
    }
  } finally {
    db.close();
  }
}
