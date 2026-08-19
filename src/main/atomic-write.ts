/**
 * Writing a file whole or not at all.
 *
 * Every store in the trusted process keeps state that is worthless in fragments:
 * a half-written credential file decrypts to nothing and reads as "no key was
 * ever stored", a half-written bookmark set leaves a user unable to tell what
 * they have, and a half-written session drops tabs. `writeFileSync` straight to
 * the destination truncates first and writes second, so a crash, a power loss,
 * or a full disk between those two steps destroys the previous contents without
 * producing new ones.
 *
 * Writing to a temporary file and renaming makes the replacement a single
 * filesystem operation: either the old contents are there or the new ones are.
 *
 * The temporary name carries a random component because the destination is the
 * only thing two writers would agree on, and reusing one fixed `.tmp` path is
 * how concurrent writes corrupt each other. It keeps the `.tmp` suffix so a
 * leftover file is recognisable as this module's.
 */
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Owner-only where the platform honours it; a no-op where it does not.
 *
 * Applied to the temporary file, which is created fresh on every write. That is
 * what makes the mode actually take effect: `writeFileSync` applies `mode` only
 * when it creates a file, so writing in place would leave an existing file's
 * permissions alone however they came to be loosened.
 */
export const PRIVATE_FILE_MODE = 0o600;

export function writeFileAtomically(
  path: string,
  contents: string | Uint8Array,
  mode: number = PRIVATE_FILE_MODE
): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    writeFileSync(temporary, contents, { mode });
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing further to try; the destination is untouched either way.
    }
    throw error;
  }
}
