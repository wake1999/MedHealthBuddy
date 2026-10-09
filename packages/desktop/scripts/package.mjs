/**
 * Build the Windows installer (NSIS, per user, unsigned).
 *
 *   pnpm --filter medhealthbuddy-desktop run package
 *
 * Steps:
 *  1. Make sure the server plugin tarball for the current dsh-desktop-link
 *     version exists in dist/ (packs it if not): the installer ships it, and
 *     "安装与升级" uploads it to servers.
 *  2. Stage the app in packages/desktop/.stage: src/, assets/, a package.json
 *     with no dependencies, and @dsh-ssh/core copied into node_modules as
 *     plain files. electron-builder then never walks pnpm's symlinked store.
 *  3. Run electron-builder on the stage, with the Electron already installed
 *     here (no second download of the runtime).
 *
 * Output: dist/installer/MedHealthBuddy-Setup-<version>.exe
 *         dist/installer/MedHealthBuddy-<version>-portable.zip (unpack and run)
 *
 * electron-builder downloads its NSIS and resource-editing tools once, into
 * ELECTRON_BUILDER_CACHE (default: .cache/electron-builder in this repo, so a
 * confined build that cannot write %LOCALAPPDATA% still works).
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..', '..')
const stage = join(desktop, '.stage')
const dist = join(repo, 'dist')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const manifest = readJson(join(desktop, 'package.json'))
const core = join(repo, 'packages', 'core')
const plugin = readJson(join(repo, 'packages', 'server-plugin', 'package.json'))

process.env.ELECTRON_BUILDER_CACHE ??= join(repo, '.cache', 'electron-builder')
// makensis writes its temporary files to %TEMP%. A process started from this
// workspace can run at Low integrity (see setup-electron-runtime.cmd), which
// cannot write there ("!tempfile: Unable to create temporary file"), so the
// build keeps its temporary files under .cache/ too.
const temp = join(repo, '.cache', 'tmp')
mkdirSync(temp, { recursive: true })
process.env.TEMP = temp
process.env.TMP = temp

// ------------------------------------------------------------ 1. the plugin
const pluginFile = join(dist, `dsh-desktop-link-${String(plugin.version)}.tgz`)
if (!existsSync(pluginFile)) {
  const pnpm = process.env.npm_execpath
  if (pnpm === undefined) throw new Error(`${pluginFile} is missing; run this through pnpm, or pnpm pack packages/server-plugin into dist/`)
  console.log(`packing dsh-desktop-link ${String(plugin.version)}`)
  const packed = spawnSync(process.execPath, [pnpm, 'pack', '--pack-destination', dist], {
    cwd: join(repo, 'packages', 'server-plugin'),
    stdio: 'inherit',
  })
  if (packed.status !== 0 || !existsSync(pluginFile)) throw new Error('packing the server plugin failed')
}

// --------------------------------------------------------------- 2. stage
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(join(desktop, 'src'), join(stage, 'src'), { recursive: true })
mkdirSync(join(stage, 'assets'))
for (const file of ['app.ico', 'icon.png', 'icon-256.png', 'tray.png', 'installer.nsh']) cpSync(join(desktop, 'assets', file), join(stage, 'assets', file))
const coreTarget = join(stage, 'node_modules', '@dsh-ssh', 'core')
mkdirSync(coreTarget, { recursive: true })
cpSync(join(core, 'lib'), join(coreTarget, 'lib'), { recursive: true })
cpSync(join(core, 'package.json'), join(coreTarget, 'package.json'))
writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
  name: manifest.name,
  productName: 'MedHealthBuddy',
  version: manifest.version,
  description: manifest.description,
  type: 'module',
  main: manifest.main,
  license: manifest.license,
  author: 'MedHealthBuddy',
  dependencies: { '@dsh-ssh/core': readJson(join(core, 'package.json')).version },
  // A plain folder, not a pnpm project: electron-builder must read its
  // node_modules as they lie, not ask a package manager (pnpm's `list` fails
  // on the stage, and the Node used here ships no npm).
  packageManager: 'traversal@1.0.0',
}, null, 2)}\n`)

// ----------------------------------------------------------- 3. the build
const electronPackage = dirname(require.resolve('electron/package.json'))
const electronVersion = readJson(join(electronPackage, 'package.json')).version
const { build, Platform } = require('electron-builder')

// PACKAGE_TARGETS picks the artifact kinds (default: installer and portable
// zip). On a machine where the NSIS tools cannot be downloaded or extracted,
// `PACKAGE_TARGETS=zip` still gives the portable build.
const targets = (process.env.PACKAGE_TARGETS ?? 'nsis,zip').split(',')

const result = await build({
  targets: Platform.WINDOWS.createTarget(targets, 1 /* x64 */),
  projectDir: stage,
  config: {
    appId: 'medhealthbuddy-desktop',
    productName: 'MedHealthBuddy',
    executableName: 'MedHealthBuddy',
    copyright: 'MedHealthBuddy',
    electronVersion,
    electronDist: realpathSync(join(electronPackage, 'dist')),
    directories: { output: join(dist, 'installer'), buildResources: 'assets' },
    files: ['src/**/*', 'assets/**/*', '!assets/installer.nsh', 'node_modules/**/*', 'package.json'],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    extraResources: [
      // The installer ships the server plugin; the app finds it by this name.
      { from: pluginFile, to: `dsh-desktop-link-${String(plugin.version)}.tgz` },
      // Toasts need an icon Windows can read, not a path inside app.asar.
      { from: join(desktop, 'assets', 'icon-256.png'), to: 'icon-256.png' },
    ],
    // Copied along with the local Electron: its sample app, which this one replaces.
    afterPack: async (context) => {
      rmSync(join(context.appOutDir, 'resources', 'default_app.asar'), { force: true })
    },
    publish: null,
    win: {
      icon: 'assets/app.ico',
      artifactName: 'MedHealthBuddy-Setup-${version}.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'MedHealthBuddy',
      installerIcon: 'assets/app.ico',
      uninstallerIcon: 'assets/app.ico',
      // Names the updater folder after the product (see the file).
      include: 'assets/installer.nsh',
      installerLanguages: ['zh_CN'],
      language: '2052',
      // Saved connections and login cookies stay unless the user deletes them.
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
    },
  },
})

console.log('\nbuilt:')
for (const file of result) console.log(`  ${file}`)

// The zip rides on the installer's artifact name; give the portable copy its own.
const zipArtifact = result.find((file) => file.endsWith('.zip'))
if (zipArtifact !== undefined) {
  const portable = join(dirname(zipArtifact), `MedHealthBuddy-${manifest.version}-portable.zip`)
  renameSync(zipArtifact, portable)
  console.log(`  ${portable} (renamed from ${basename(zipArtifact)})`)
}
