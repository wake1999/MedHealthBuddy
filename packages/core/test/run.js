/**
 * Run every test file in its own process, in order, and fail if any fails.
 * Separate processes keep one file's module state (a scratch store, a stray
 * timer) from leaking into the next.
 *
 * Run: node test/run.js
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = ['selftest.js', 'listening.js', 'store.js', 'transports.js', 'start-script.js', 'session.js', 'install.js']

let failed = 0
for (const file of files) {
  console.log(`\n== ${file}`)
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}
if (failed > 0) {
  console.error(`\n${String(failed)} test file(s) failed`)
  process.exit(1)
}
console.log('\nall core test files passed')
