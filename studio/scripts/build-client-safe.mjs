import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const studioRoot = resolve(import.meta.dirname, '..')
const dist = join(studioRoot, 'dist')
const target = join(dist, 'client')
const staging = join(dist, 'client.next')
const viteBin = join(studioRoot, 'node_modules', 'vite', 'bin', 'vite.js')

const built = spawnSync(process.execPath, [viteBin, 'build', '--outDir', '../../dist/client.next', '--emptyOutDir'], {
  cwd: studioRoot,
  stdio: 'inherit',
  env: process.env,
})
if (built.status !== 0) {
  console.error('[build-client-safe] build failed; existing dist/client was left untouched')
  process.exit(built.status || 1)
}
if (!existsSync(join(staging, 'index.html'))) {
  console.error('[build-client-safe] staging index.html is missing; existing dist/client was left untouched')
  process.exit(1)
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(destination, name)
    if (statSync(from).isDirectory()) {
      copyTree(from, to)
    } else {
      copyFileSync(from, to)
    }
  }
}

// Keep the old index.html until every new asset is in place, then replace it
// last. The Electron window can keep loading during the build without seeing
// a half-built directory.
if (!existsSync(target)) {
  copyTree(staging, target)
} else {
  for (const name of readdirSync(staging)) {
    if (name === 'index.html') continue
    const from = join(staging, name)
    const to = join(target, name)
    if (statSync(from).isDirectory()) {
      copyTree(from, to)
    } else {
      copyFileSync(from, to)
    }
  }
  copyFileSync(join(staging, 'index.html'), join(target, 'index.html'))
}

try {
  rmSync(staging, { recursive: true, force: true })
} catch {
  // A guarded delete may refuse a large staging tree. It is safe to leave it:
  // the next Vite build clears this directory before writing.
  console.warn('[build-client-safe] staging retained; next build will clear it')
}
console.log('[build-client-safe] dist/client updated without removing index.html')
