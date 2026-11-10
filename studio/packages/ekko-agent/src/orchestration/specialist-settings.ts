import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface SpecialistSettings {
  disabled: string[]
}

function stateDirectory(): string {
  return String(
    process.env.HERMES_WEBUI_STATE_DIR
      || process.env.HERMES_WEB_UI_HOME
      || join(process.cwd(), 'data', 'hermes-web-ui'),
  ).trim()
}

function settingsFile(): string {
  return join(stateDirectory(), 'agent-specialist-settings.json')
}

function readSettings(): SpecialistSettings {
  const path = settingsFile()
  if (!existsSync(path)) return { disabled: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SpecialistSettings>
    return {
      disabled: Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((item): item is string => typeof item === 'string')
        : [],
    }
  } catch {
    return { disabled: [] }
  }
}

function writeSettings(settings: SpecialistSettings): void {
  const path = settingsFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

export function isSpecialistEnabled(id: string): boolean {
  return !readSettings().disabled.includes(id)
}

export function getDisabledSpecialists(): string[] {
  return readSettings().disabled
}

export function setSpecialistEnabled(id: string, enabled: boolean): boolean {
  const settings = readSettings()
  const disabled = new Set(settings.disabled)
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  writeSettings({ disabled: [...disabled] })
  return enabled
}
