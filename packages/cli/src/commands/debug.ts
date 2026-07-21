import { Command } from 'commander'
import { join } from 'path'
import { getConfigDir } from '../config'
import { launchHeadless, closeBrowser } from '../playwright/browser'

const NOTEBOOKLM_URL = 'https://notebooklm.google.com'

export function registerDebugCommand(program: Command): void {
  program
    .command('debug')
    .description('Inspect NotebookLM DOM to diagnose sync issues')
    .requiredOption('--notebook <id>', 'Notebook ID to inspect')
    .action(async (opts: { notebook: string }) => {
      const handle = await launchHeadless()
      const page = await handle.context.newPage()
      page.setDefaultTimeout(10000)

      try {
        const url = `${NOTEBOOKLM_URL}/notebook/${opts.notebook}`
        console.log(`Navigating to ${url} ...`)
        await page.goto(url, { waitUntil: 'load', timeout: 30000 })
        await page.waitForTimeout(3000)

        const shot1 = join(getConfigDir(), 'debug-1-initial.png')
        await page.screenshot({ path: shot1, fullPage: true })
        console.log(`Screenshot 1 (initial): ${shot1}`)

        const buttons = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"]')).map(el => ({
            text: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? '',
            aria: el.getAttribute('aria-label') ?? '',
          })).filter(b => b.text || b.aria)
        )
        console.log('\n=== BUTTONS ===')
        buttons.slice(0, 30).forEach((b, i) =>
          console.log(`  [${i}] text="${b.text}" aria="${b.aria}"`)
        )

        // Dismiss CDK overlays before interacting
        const backdrop = page.locator('.cdk-overlay-backdrop-showing')
        if (await backdrop.count() > 0) {
          console.log('\n=== DISMISSING CDK OVERLAY ===')
          for (let attempt = 0; attempt < 3; attempt++) {
            if (await backdrop.count() === 0) break
            const closeBtn = page.locator('[aria-label="バナーを閉じる"], [aria-label="閉じる"]').first()
            if (await closeBtn.count() > 0) {
              await closeBtn.click({ force: true }).catch(() => {})
              console.log(`  Attempt ${attempt + 1}: clicked close button`)
            } else {
              await page.keyboard.press('Escape')
              console.log(`  Attempt ${attempt + 1}: pressed Escape`)
            }
            await backdrop.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
          }
          if (await backdrop.count() > 0) {
            console.log('  Forcing backdrop removal via JS')
            await page.evaluate(() => {
              document.querySelectorAll('.cdk-overlay-backdrop-showing').forEach(el => {
                el.classList.remove('cdk-overlay-backdrop-showing')
                ;(el as HTMLElement).style.pointerEvents = 'none'
              })
            })
            await page.waitForTimeout(300)
          }
          console.log(`  Backdrop now: ${await backdrop.count() > 0 ? 'STILL PRESENT' : 'gone'}`)
        }

        // Phase 2: listen for filechooser BEFORE clicking, then click
        console.log('\n=== CLICKING "ソースを追加" (listening for filechooser) ===')
        let fileChooserOpened = false
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 })
          .then(fc => { fileChooserOpened = true; fc.setFiles([]); return fc })
          .catch(() => null)

        await page.locator('[aria-label="ソースを追加"]').click()
        await chooserPromise

        if (fileChooserOpened) {
          console.log('  → File chooser opened DIRECTLY on "ソースを追加" click!')
          console.log('    (registerFile should use waitForEvent filechooser + click)')
        } else {
          console.log('  → No file chooser — a dialog appeared instead')
        }

        await page.waitForTimeout(2000)
        const shot2 = join(getConfigDir(), 'debug-2-after-click.png')
        await page.screenshot({ path: shot2, fullPage: true })
        console.log(`Screenshot 2 (after click): ${shot2}`)

        // Capture dialog contents
        const dialogItems = await page.evaluate(() =>
          Array.from(document.querySelectorAll([
            '[role="dialog"] button',
            '[role="menu"] [role="menuitem"]',
            'mat-bottom-sheet-container button',
            'mat-bottom-sheet-container mat-list-item',
            '[cdkdialog] button',
            '.cdk-overlay-container button',
            '.cdk-overlay-container [role="option"]',
            '.cdk-overlay-container [role="menuitem"]',
            '.cdk-overlay-container mat-list-item',
          ].join(', '))).map(el => ({
            tag: el.tagName,
            text: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '',
            aria: el.getAttribute('aria-label') ?? '',
          }))
        )
        console.log('\n=== DIALOG / OVERLAY ITEMS ===')
        if (dialogItems.length === 0) {
          console.log('  (none found via dialog selectors)')
          // Fallback: show all new buttons not in initial list
          const allButtons2 = await page.evaluate(() =>
            Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], mat-list-item')).map(el => ({
              text: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '',
              aria: el.getAttribute('aria-label') ?? '',
            })).filter(b => b.text || b.aria)
          )
          console.log('  All interactive elements after click:')
          allButtons2.slice(0, 40).forEach((b, i) =>
            console.log(`    [${i}] text="${b.text}" aria="${b.aria}"`)
          )
        } else {
          dialogItems.forEach((b, i) =>
            console.log(`  [${i}] ${b.tag}: text="${b.text}" aria="${b.aria}"`)
          )
        }

        const fileInputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
            accept: el.getAttribute('accept') ?? '',
            id: el.id,
          }))
        )
        console.log('\n=== FILE INPUTS (after click) ===')
        if (fileInputs.length === 0) {
          console.log('  (none — need to click an option in the dialog)')
        } else {
          fileInputs.forEach((fi, i) => console.log(`  [${i}] accept="${fi.accept}" id="${fi.id}"`))
        }

        // Phase 3: dump existing source list in the left panel
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(1000)

        const sources = await page.evaluate(() => {
          // 幅広い候補セレクタでソースらしき要素を収集し、
          // aria-label / text / class / role を出力する
          const candidates = Array.from(
            document.querySelectorAll(
              [
                '[role="listitem"]',
                'mat-list-item',
                '[class*="source"]',
                '[data-testid*="source"]',
                '[aria-label*="ソース"]',
              ].join(', ')
            )
          )
          return candidates.map(el => ({
            tag: el.tagName,
            role: el.getAttribute('role') ?? '',
            aria: el.getAttribute('aria-label') ?? '',
            testid: el.getAttribute('data-testid') ?? '',
            cls: el.className?.toString().slice(0, 80) ?? '',
            text: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '',
          }))
        })
        console.log('\n=== SOURCE LIST CANDIDATES ===')
        if (sources.length === 0) {
          console.log('  (none found)')
        } else {
          sources.slice(0, 40).forEach((s, i) =>
            console.log(
              `  [${i}] <${s.tag}> role="${s.role}" aria="${s.aria}" testid="${s.testid}" cls="${s.cls}" text="${s.text}"`
            )
          )
        }

        const shot3 = join(getConfigDir(), 'debug-3-sources.png')
        await page.screenshot({ path: shot3, fullPage: true })
        console.log(`Screenshot 3 (sources): ${shot3}`)
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : err)
      } finally {
        await page.close()
        await closeBrowser(handle)
      }
    })
}
