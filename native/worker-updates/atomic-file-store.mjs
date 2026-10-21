import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const BUSY_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_DELAYS = [25, 50, 100, 200, 400, 400, 400, 400];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const exhaustedReplacements = new WeakSet();

export function isRetryableAtomicReplaceError(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && seen.size < 8 && !seen.has(current);) {
    if (exhaustedReplacements.has(current)) return true;
    seen.add(current);
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    current = cause && Object.hasOwn(cause, "value") ? cause.value : null;
  }
  return false;
}

// Windows readers and antivirus scanners can briefly deny a replacement even
// after the temp file is closed. Retrying rename keeps the prior file intact;
// deleting the destination first would create a gap and risk losing it.
export function createAtomicFileWriter({ fileSystem = fs, wait = pause } = {}) {
  const tails = new Map();
  return function atomicWriteFile(destination, contents) {
    const file = path.resolve(destination);
    const operation = (tails.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      // Evaluate the snapshot only after earlier writes have finished so a
      // delayed older call cannot overwrite a newer in-memory state.
      const data = typeof contents === "function" ? contents() : contents;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await fileSystem.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        await fileSystem.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
        for (let attempt = 0; ; attempt++) {
          try { await fileSystem.rename(temporary, file); break; }
          catch (error) {
            if (!BUSY_RENAME_CODES.has(error.code)) throw error;
            if (attempt >= RETRY_DELAYS.length) { exhaustedReplacements.add(error); throw error; }
            await wait(RETRY_DELAYS[attempt]);
          }
        }
      } finally {
        // Preserve the original write/rename error if cleanup also fails.
        await fileSystem.unlink(temporary).catch(() => {});
      }
    });
    const tail = operation.catch(() => {});
    tails.set(file, tail);
    void tail.then(() => { if (tails.get(file) === tail) tails.delete(file); });
    return operation;
  };
}

// All service instances in this worker share the same per-file ordering.
export const atomicWriteFile = createAtomicFileWriter();
