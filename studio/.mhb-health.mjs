import { chromium } from 'playwright'

const BASE = process.env.MHB_BASE || 'http://127.0.0.1:8648'
const channel = process.env.PW_CHANNEL || 'msedge'
const browser = await chromium.launch({ channel })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

const failed = []
page.on('requestfailed', r => failed.push(`FAILED ${r.method()} ${r.url().replace(BASE, '')} :: ${r.failure()?.errorText}`))
page.on('response', r => {
  const s = r.status()
  if (s >= 400) failed.push(`${s} ${r.request().method()} ${r.url().replace(BASE, '').slice(0, 90)}`)
})

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(6000)
console.log('URL:', page.url())
console.log('TITLE:', await page.title())
console.log('TEXT:', JSON.stringify(await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 300))))
const loginInputs = await page.locator('input').count()
if (loginInputs >= 2) {
  await page.locator('input').first().fill('admin')
  await page.fill('input[type="password"]', '123456')
  await page.getByRole('button', { name: '登录' }).click().catch(() => {})
  await page.waitForTimeout(8000)
  console.log('after login URL:', page.url())
  console.log('after login TEXT:', JSON.stringify(await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 200))))
}
console.log('FAILED REQUESTS:', JSON.stringify(failed.slice(0, 12), null, 1))
await page.screenshot({ path: 'e:/MedHealthBuddy/.mhb-health.png' })
await browser.close()
