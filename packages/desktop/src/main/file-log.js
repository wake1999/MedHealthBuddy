/**
 * The app's log file: `<userData>/logs/main.log`, one line per event,
 * timestamped and tagged with the connection it concerns.
 *
 * Every connection's diagnostic lines are mirrored here as they are recorded
 * (already redacted by @dsh-ssh/core's LogRing, so no token or link secret
 * reaches the file), plus the app's own start, exit and warnings. The in-app
 * log only holds the current run; this file survives it, for a bug report.
 *
 * Bounded: past 1 MB the file rotates to `main.old.log`, so at most two files
 * of about 1 MB each are kept.
 *
 * @module medhealthbuddy-desktop/file-log
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { redact } from '@dsh-ssh/core'

const MAX_BYTES = 1024 * 1024

export class FileLog {
  /** @param {string} dir the logs directory; created on first write. */
  constructor(dir) {
    this.dir = dir
    this.path = join(dir, 'main.log')
    this.broken = false
  }

  /**
   * @param {string} tag   who the line is about ('app' or a connection name).
   * @param {string} line
   */
  write(tag, line) {
    if (this.broken) return
    try {
      mkdirSync(this.dir, { recursive: true })
      if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) {
        const old = join(this.dir, 'main.old.log')
        rmSync(old, { force: true })
        renameSync(this.path, old)
      }
      appendFileSync(this.path, `${new Date().toISOString()} [${tag}] ${redact(line)}\n`, 'utf8')
    } catch {
      // A read-only or full disk: stop trying rather than fail every write.
      this.broken = true
    }
  }
}
