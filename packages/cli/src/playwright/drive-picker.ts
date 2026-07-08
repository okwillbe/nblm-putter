import { Page } from 'playwright'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const PICKER_FRAME_SELECTORS = [
  'iframe[src*="drive.google.com"]',
  'iframe[src*="docs.google.com/picker"]',
  'iframe[src*="accounts.google.com"][src*="picker"]',
]

function getDebugDir(): string {
  const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP
  if (tmpDir) return tmpDir
  // Windows 默认临时目录
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'Temp')
  }
  return '/tmp'
}

// filesToAdd: 新規アップロードしたファイル名のリスト。指定時はそのファイルのみ選択する。
export async function addSourcesFromDrive(
  page: Page,
  notebookId: string,
  filesToAdd?: string[],
): Promise<void> {
  const debugDir = getDebugDir()

  // ページが完全に読み込まれているか確認
  const pageUrl = page.url()
  console.log(`  [debug] Current page URL: ${pageUrl}`)

  // スクリーンショットを撮って現在の状態を確認
  await page.screenshot({ path: `${debugDir}/nblm-phase2-start.png`, fullPage: true }).catch(() => {})

  // ?addSource=true 只是 URL 参数，实际上对话框并不会自动打开
  // 必须点击 "添加来源" 按钮来打开菜单
  console.log(`  [debug] Clicking "添加来源" button to open menu...`)

  // 1. 「ソースを追加」ボタンをクリック（タイムアウトを 60秒に延長）
  //    日本語: ソースを追加 / 英語: Add source / 中文: 添加来源
  await page.locator('[aria-label="ソースを追加"], [aria-label="Add source"], [aria-label="添加来源"]')
    .first()
    .click({ force: true, timeout: 60000 })

  // 等待菜单弹出
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${debugDir}/nblm-after-click-add-source.png`, fullPage: true }).catch(() => {})

  // 2. 「ドライブ」ボタンが出現するまで待ってクリック
  //    getByRole() / getByText() はシャドウ DOM を透過する。
  //    日本語: ドライブ / 英語: Drive / 中文: 云端硬盘
  const driveButton = page.getByRole('button', { name: 'ドライブ', exact: true })
    .or(page.getByRole('button', { name: 'Drive', exact: true }))
    .or(page.getByRole('button', { name: '云端硬盘', exact: true }))
    .or(page.getByRole('menuitem', { name: 'ドライブ' }))
    .or(page.getByRole('menuitem', { name: 'Drive' }))
    .or(page.getByRole('menuitem', { name: '云端硬盘' }))
    // 追加: テキストで探す（Google ドライブ / Google Drive / Google 云端硬盘）
    .or(page.locator('button:has-text("Google ドライブ"), button:has-text("Google Drive"), button:has-text("Google 云端硬盘")'))

  let driveClicked = false

  // Strategy A: 出現を 15秒待ってクリック
  const appeared = await driveButton.first().waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true).catch(() => false)

  if (appeared) {
    await driveButton.first().click({ timeout: 5000 })
    driveClicked = true
  }

  // Strategy B: JS でシャドウ DOM を再帰探索してクリック
  if (!driveClicked) {
    driveClicked = await page.evaluate(() => {
      const TARGET = ['ドライブ', 'Drive', 'Google ドライブ', 'Google Drive', '云端硬盘', 'Google 云端硬盘']
      const EXCLUDE = ['ソースを追加', 'Add source', '添加来源']

      function tryClick(root: Element | ShadowRoot): boolean {
        for (const el of Array.from(root.querySelectorAll(
          'button, [role="button"], [role="menuitem"], [role="option"]'
        ))) {
          const t = (el.textContent ?? '').trim()
          if (TARGET.some(s => t === s || t.startsWith(s)) && !EXCLUDE.some(s => t.includes(s))) {
            ;(el as HTMLElement).click()
            return true
          }
        }
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const sr = (el as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot
          if (sr && tryClick(sr)) return true
        }
        return false
      }
      return tryClick(document.body)
    }).catch(() => false)
  }

  if (!driveClicked) {
    await page.screenshot({ path: `${debugDir}/nblm-add-source-dialog.png`, fullPage: true }).catch(() => {})
    const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
    fs.writeFileSync(`${debugDir}/nblm-add-source-dialog.html`, html)
    throw new Error(
      'Google Drive の「ドライブ」ボタンが見つかりません（15秒待機後）。\n' +
      `  スクリーンショット: ${debugDir}/nblm-add-source-dialog.png\n` +
      `  HTML ダンプ: ${debugDir}/nblm-add-source-dialog.html`
    )
  }

  console.log(`  [debug] Drive button clicked, waiting for picker iframe...`)

  // 3. Drive ピッカー iframe を待つ
  let pickerFrame = null
  let pickerFrameSel = ''
  for (const sel of PICKER_FRAME_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 12000 })
      pickerFrame = page.frameLocator(sel)
      pickerFrameSel = sel
      console.log(`  [debug] Picker iframe found: ${sel}`)
      break
    } catch { /* 次を試す */ }
  }
  if (!pickerFrame) {
    await page.screenshot({ path: `${debugDir}/nblm-drive-picker-debug.png`, fullPage: true }).catch(() => {})
    throw new Error(`Drive ピッカー iframe が表示されませんでした。スクリーンショット: ${debugDir}/nblm-drive-picker-debug.png`)
  }

  // ピッカーが読み込まれるまで少し待ってからデバッグ情報を保存
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${debugDir}/nblm-picker-opened.png`, fullPage: true }).catch(() => {})
  const pickerHtml = await page.frames()
    .find(f => f.url().includes('docs.google.com') || f.url().includes('drive.google.com'))
    ?.evaluate(() => document.documentElement.outerHTML)
    .catch(() => '') ?? ''
  fs.writeFileSync(`${debugDir}/nblm-picker-frame.html`, pickerHtml)

  // 4. 「マイドライブ」タブをクリック
  //    ピッカーは「最近使用したアイテム」タブで開くので明示的に切り替える
  //    日本語: マイドライブ / 英語: My Drive / 中文: 我的云端硬盘
  const myDriveTab = pickerFrame.getByRole('tab', { name: 'マイドライブ' })
    .or(pickerFrame.getByRole('tab', { name: 'My Drive' }))
    .or(pickerFrame.getByRole('tab', { name: '我的云端硬盘' }))
    .or(pickerFrame.locator('[role="tab"][id="1"]'))
  const myDriveTabVisible = await myDriveTab.first().isVisible({ timeout: 3000 }).catch(() => false)
  if (myDriveTabVisible) {
    console.log(`  [debug] Clicking My Drive tab...`)
    await myDriveTab.first().click({ timeout: 5000 })
    await page.waitForTimeout(1500)
  }

  // 5. nblm-putter フォルダを開く
  console.log(`  [debug] Looking for nblm-putter folder...`)
  //    ファイルアイテムは aria-label="<名前> <種別> 選択されていません" の形式
  const nblmFolder = pickerFrame.locator('[aria-label*="nblm-putter"]').first()
  await nblmFolder.waitFor({ state: 'visible', timeout: 10000 })
  await nblmFolder.dblclick({ timeout: 5000 })
  await page.waitForTimeout(1200)

  // 6. ノートブックサブフォルダを開く
  console.log(`  [debug] Looking for notebook folder: ${notebookId}...`)
  const notebookFolder = pickerFrame.locator(`[aria-label*="${notebookId}"]`).first()
  await notebookFolder.waitFor({ state: 'visible', timeout: 10000 })
  await notebookFolder.dblclick({ timeout: 5000 })
  await page.waitForTimeout(2000)  // フォルダ内容が読み込まれるまで待つ

  // デバッグ用スクリーンショット＆HTML ダンプ（フォルダ内容確認）
  await page.screenshot({ path: `${debugDir}/nblm-picker-folder.png`, fullPage: true }).catch(() => {})
  const pickerHtmlAfter = await page.frames()
    .find(f => f.url().includes('docs.google.com') || f.url().includes('drive.google.com'))
    ?.evaluate(() => document.documentElement.outerHTML)
    .catch(() => '') ?? ''
  fs.writeFileSync(`${debugDir}/nblm-picker-folder.html`, pickerHtmlAfter)

  // 7. ファイルを選択
  //    中文の選択状態: "未选择" (未選択)
  const unselectedLabel = '[aria-label*="選択されていません"], [aria-label*="not selected"], [aria-label*="未选择"]'

  if (filesToAdd && filesToAdd.length > 0) {
    console.log(`  [debug] Files to add: ${filesToAdd.join(', ')}`)

    // ピッカー内のファイル一覧を取得してデバッグ出力
    const allItems = await pickerFrame.locator('[aria-label]').evaluateAll(el =>
      el.map(e => e.getAttribute('aria-label') || '')
    ).catch(() => [])
    console.log(`  [debug] Picker items found: ${allItems.length}`)
    allItems.slice(0, 20).forEach(label => console.log(`    - ${label}`))

    // 新規アップロード分のみ Ctrl+クリックで個別選択
    let firstSelected = false
    for (const name of filesToAdd) {
      console.log(`  [debug] Looking for file: ${name}`)
      const item = pickerFrame.locator(`[aria-label*="${name}"]`).first()
      const visible = await item.isVisible({ timeout: 3000 }).catch(() => false)
      console.log(`  [debug] File "${name}" visible: ${visible}`)
      if (!visible) continue
      if (!firstSelected) {
        await item.click({ timeout: 5000 })
        firstSelected = true
      } else {
        await item.click({ modifiers: ['Control'], timeout: 5000 })
      }
    }
    if (!firstSelected) {
      await page.screenshot({ path: `${debugDir}/nblm-picker-files-not-found.png`, fullPage: true }).catch(() => {})
      throw new Error(
        `新規アップロードファイルがピッカー内に見つかりませんでした。\n` +
        `  探していたファイル: ${filesToAdd.join(', ')}\n` +
        `  ピッカー内のアイテム: ${allItems.slice(0, 20).join(', ')}\n` +
        `  スクリーンショット: ${debugDir}/nblm-picker-files-not-found.png`
      )
    }
  } else {
    // filesToAdd 未指定時はフォルダ内全件を Shift+クリックで選択
    const fileItems = pickerFrame.locator(unselectedLabel)
    const fileCount = await fileItems.count().catch(() => 0)
    if (fileCount > 0) {
      await fileItems.first().click({ timeout: 5000 })
      if (fileCount > 1) {
        await fileItems.last().click({ modifiers: ['Shift'], timeout: 5000 })
      }
    }
  }
  await page.waitForTimeout(800)

  // 選択後のスクリーンショット
  await page.screenshot({ path: `${debugDir}/nblm-picker-selected.png`, fullPage: true }).catch(() => {})

  // 8. 「挿入」ボタンをクリック（ファイル選択後に右下に出現）
  //    日本語: 挿入 / 英語: Insert / 中文: 插入
  const insertBtn = pickerFrame.getByRole('button', { name: '挿入' })
    .or(pickerFrame.getByRole('button', { name: 'Insert' }))
    .or(pickerFrame.getByRole('button', { name: '插入' }))
    .or(pickerFrame.locator('[jsname="d1dBrd"]'))
    .or(pickerFrame.locator('[aria-label="挿入"], [aria-label="Insert"], [aria-label="插入"]'))
  await insertBtn.first().waitFor({ state: 'visible', timeout: 8000 })
  await insertBtn.first().click({ timeout: 5000 })

  // 9. ダイアログが閉じるのを待つ
  await page.waitForTimeout(2000)
}