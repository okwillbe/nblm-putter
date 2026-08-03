import { Page } from 'playwright'
import type { FrameLocator } from 'playwright'
import * as fs from 'fs'

const PICKER_FRAME_SELECTORS = [
  'iframe[src*="drive.google.com"]',
  'iframe[src*="docs.google.com/picker"]',
  'iframe[src*="accounts.google.com"][src*="picker"]',
]

// ピッカー iframe 内で「最もスクロール量の大きいスクロール可能要素」をスクロールする。
// direction='down' で約8割ぶん下へ、'top' で先頭へ戻す。仮想化グリッドの未描画アイテム読み込み用。
// 戻り値: 実際にスクロール位置が動いたか（false = 最下端に到達済み等で動かなかった）。
async function scrollPickerGrid(page: Page, direction: 'down' | 'top' = 'down'): Promise<boolean> {
  const frame = page.frames().find(
    f => f.url().includes('docs.google.com') || f.url().includes('drive.google.com')
  )
  if (!frame) return false
  const moved = await frame.evaluate((dir) => {
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(el => {
      const style = getComputedStyle(el)
      return el.scrollHeight > el.clientHeight + 50 &&
        (style.overflowY === 'auto' || style.overflowY === 'scroll')
    })
    const target = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    if (!target) return false
    const before = target.scrollTop
    target.scrollTop = dir === 'top'
      ? 0
      : Math.min(target.scrollTop + target.clientHeight * 0.8, target.scrollHeight)
    return target.scrollTop !== before
  }, direction).catch(() => false)
  await page.waitForTimeout(600)
  return moved
}

// CSS 属性セレクタ値用に " と \ をエスケープする。
function escapeAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// 対象ファイル名に対応するピッカー内タイルのロケータ。
// 部分一致（[aria-label*=...]）だと別ファイル名の部分文字列に誤マッチするため、
// 「完全一致」または「<name> <種別>」形式（name の直後が空白）に限定する。
function fileTile(pickerFrame: FrameLocator, name: string) {
  const n = escapeAttr(name)
  return pickerFrame.locator(`[aria-label="${n}"], [aria-label^="${n} "]`).first()
}

// filesToAdd のうちピッカー内にマッチする件数を数える。
async function countPresent(pickerFrame: FrameLocator, names: string[]): Promise<number> {
  let n = 0
  for (const name of names) {
    if (await fileTile(pickerFrame, name).count() > 0) n++
  }
  return n
}

// filesToAdd 全件がピッカーに出現するまで、フォルダを再入場して最大 maxWaitMs 待つ。
// 出現数が増えなくなった／全件揃った／タイムアウトで打ち切る。
async function waitForFilesPresent(
  page: Page,
  pickerFrame: FrameLocator,
  notebookId: string,
  names: string[],
  maxWaitMs = 60000,
): Promise<void> {
  const t0 = Date.now()
  let present = await countPresent(pickerFrame, names)
  while (present < names.length && Date.now() - t0 < maxWaitMs) {
    await page.waitForTimeout(4000)
    // 再クエリするにはフォルダ内にいる状態から一度「マイドライブ」ルートへ戻る必要がある
    // （フォルダ内では nblm-putter タイルが見えず再入場できないため）。
    // 日本語: マイドライブ / 英語: My Drive / 中文: 我的云端硬盘
    const myDriveTab = pickerFrame.getByRole('tab', { name: 'マイドライブ' })
      .or(pickerFrame.getByRole('tab', { name: 'My Drive' }))
      .or(pickerFrame.getByRole('tab', { name: '我的云端硬盘' }))
      .or(pickerFrame.locator('[role="tab"][id="1"]'))
    if (await myDriveTab.first().count() > 0) {
      await myDriveTab.first().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1000)
    }
    // フォルダを再入場して再クエリ（nblm-putter → notebookId）
    const nblmFolder = pickerFrame.locator('[aria-label*="nblm-putter"]').first()
    if (await nblmFolder.count() > 0) {
      await nblmFolder.dblclick({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1000)
      const notebookFolder = pickerFrame.locator(`[aria-label*="${notebookId}"]`).first()
      if (await notebookFolder.count() > 0) {
        await notebookFolder.dblclick({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(1200)
      }
    }
    present = await countPresent(pickerFrame, names)
  }
}

// filesToAdd: 新規アップロードしたファイル名のリスト。指定時はそのファイルのみ選択する。
export async function addSourcesFromDrive(
  page: Page,
  notebookId: string,
  filesToAdd?: string[],
): Promise<{ added: string[]; missing: string[] }> {
  const debugDir = process.env.TMPDIR ?? '/tmp'

  // 1. 「ソースを追加」ボタンをクリック
  //    日本語: ソースを追加 / 英語: Add source / 中文: 添加来源
  await page.locator('[aria-label="ソースを追加"], [aria-label="Add source"], [aria-label="添加来源"]')
    .first()
    .click({ force: true, timeout: 15000 })

  // 2. 「ドライブ」ボタンが出現するまで待ってクリック
  //    getByRole() / getByText() はシャドウ DOM を透過する。
  //    CSS の :has-text() は透過しない。
  //    旧コードの waitForSelector ループが偶然 24秒以上待っていたのを
  //    「ドライブ」ボタン自体の出現待ちに一本化する。
  //    日本語: ドライブ / 英語: Drive / 中文: 云端硬盘
  const driveButton = page.getByRole('button', { name: 'ドライブ', exact: true })
    .or(page.getByRole('button', { name: 'Drive', exact: true }))
    .or(page.getByRole('button', { name: '云端硬盘', exact: true }))
    .or(page.getByRole('menuitem', { name: 'ドライブ' }))
    .or(page.getByRole('menuitem', { name: 'Drive' }))
    .or(page.getByRole('menuitem', { name: '云端硬盘' }))

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

  // 3. Drive ピッカー iframe を待つ
  let pickerFrame = null
  let pickerFrameSel = ''
  for (const sel of PICKER_FRAME_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 12000 })
      pickerFrame = page.frameLocator(sel)
      pickerFrameSel = sel
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
  //    タブは role="tab"、テキスト「マイドライブ」または id="1"
  //    日本語: マイドライブ / 英語: My Drive / 中文: 我的云端硬盘
  const myDriveTab = pickerFrame.getByRole('tab', { name: 'マイドライブ' })
    .or(pickerFrame.getByRole('tab', { name: 'My Drive' }))
    .or(pickerFrame.getByRole('tab', { name: '我的云端硬盘' }))
    .or(pickerFrame.locator('[role="tab"][id="1"]'))
  const myDriveTabVisible = await myDriveTab.first().isVisible({ timeout: 3000 }).catch(() => false)
  if (myDriveTabVisible) {
    await myDriveTab.first().click({ timeout: 5000 })
    await page.waitForTimeout(1500)
  }

  // 5. nblm-putter フォルダを開く
  //    ファイルアイテムは aria-label="<名前> <種別> 選択されていません" の形式
  const nblmFolder = pickerFrame.locator('[aria-label*="nblm-putter"]').first()
  await nblmFolder.waitFor({ state: 'visible', timeout: 10000 })
  await nblmFolder.dblclick({ timeout: 5000 })
  await page.waitForTimeout(1200)

  // 6. ノートブックサブフォルダを開く
  const notebookFolder = pickerFrame.locator(`[aria-label*="${notebookId}"]`).first()
  await notebookFolder.waitFor({ state: 'visible', timeout: 10000 })
  await notebookFolder.dblclick({ timeout: 5000 })
  await page.waitForTimeout(1200)

  // デバッグ用スクリーンショット＆HTML ダンプ（フォルダ内容確認）
  await page.screenshot({ path: `${debugDir}/nblm-picker-folder.png`, fullPage: true }).catch(() => {})
  const pickerHtmlAfter = await page.frames()
    .find(f => f.url().includes('docs.google.com') || f.url().includes('drive.google.com'))
    ?.evaluate(() => document.documentElement.outerHTML)
    .catch(() => '') ?? ''
  fs.writeFileSync(`${debugDir}/nblm-picker-folder.html`, pickerHtmlAfter)

  // 7. ファイルを選択
  const result: { added: string[]; missing: string[] } = { added: [], missing: [] }
  if (filesToAdd && filesToAdd.length > 0) {
    // まず対象ファイルが Drive 反映されるのを待つ（アップロード直後は未出現のことがある）
    await waitForFilesPresent(page, pickerFrame, notebookId, filesToAdd)

    // グリッドを先頭から最下端まで一方向にスイープし、各スクロール位置で
    // 「未選択の対象すべて」を再スキャンして見つかった分をクリックする。
    // ファイルの並び順とスクロール位置に依存せず全件を拾える（上方に取り残さない）。
    const remaining = new Set(filesToAdd)
    const MAX_SCROLLS = 40
    await scrollPickerGrid(page, 'top')

    for (let s = 0; s <= MAX_SCROLLS && remaining.size > 0; s++) {
      for (const name of [...remaining]) {
        const item = fileTile(pickerFrame, name)
        if (await item.count() === 0) continue
        // 先頭は通常クリック、以降は Ctrl+ で追加選択
        await item.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
        const modifiers: ('Control')[] = result.added.length === 0 ? [] : ['Control']
        const clicked = await item.click({ modifiers, timeout: 5000 }).then(() => true).catch(() => false)
        if (clicked) {
          result.added.push(name)
          remaining.delete(name)
        }
      }
      if (remaining.size === 0) break
      // まだ残っていれば下へスクロールして続きを読み込む。最下端で動かなければ終了。
      const moved = await scrollPickerGrid(page, 'down')
      if (!moved) break
    }
    result.missing.push(...remaining)

    if (result.added.length === 0) {
      throw new Error('新規アップロードファイルがピッカー内に見つかりませんでした（反映遅延またはDOM未検出）。')
    }
  } else {
    // filesToAdd 未指定時はフォルダ内全件を Shift+クリックで選択
    const fileItems = pickerFrame.locator('[aria-label*="選択されていません"]')
    const fileCount = await fileItems.count().catch(() => 0)
    if (fileCount > 0) {
      await fileItems.first().click({ timeout: 5000 })
      if (fileCount > 1) {
        await fileItems.last().click({ modifiers: ['Shift'], timeout: 5000 })
      }
    }
  }
  await page.waitForTimeout(800)

  // 挿入前にピッカーの選択数（「N 件選択しました」）を読み取り、想定選択数と照合する。
  // click() が例外を投げなくても実際には選択できていない場合の検出用バックストップ。
  if (filesToAdd && filesToAdd.length > 0) {
    const frame = page.frames().find(
      f => f.url().includes('docs.google.com') || f.url().includes('drive.google.com')
    )
    const picked = frame
      ? await frame.evaluate(() => {
          const m = document.body.innerText.match(/(\d+)\s*件選択/)
          return m ? Number(m[1]) : null
        }).catch(() => null)
      : null
    if (picked !== null && picked !== result.added.length) {
      // 照合できたが不一致 → added の一部が実際には未選択の可能性。added を実選択数に合わせて縮め、
      // 差分を missing に移す（どのファイルかは特定できないため、確実に追加された数だけを added とする）。
      console.warn(
        `⚠ ピッカーの選択数(${picked})が想定(${result.added.length})と一致しません。実選択数を採用します。`
      )
      while (result.added.length > picked) {
        const dropped = result.added.pop()
        if (dropped) result.missing.push(dropped)
      }
    }
  }

  // 選択後のスクリーンショット
  await page.screenshot({ path: `${debugDir}/nblm-picker-selected.png`, fullPage: true }).catch(() => {})

  // 8. 「挿入」ボタンをクリック（ファイル選択後に右下に出現）
  //    実 DOM 確認: 日本語 UI は「挿入」、英語 UI は「Insert」
  const insertBtn = pickerFrame.getByRole('button', { name: '挿入' })
    .or(pickerFrame.getByRole('button', { name: 'Insert' }))
    .or(pickerFrame.locator('[jsname="d1dBrd"]'))
    .or(pickerFrame.locator('[aria-label="挿入"]'))
    .or(pickerFrame.locator('[aria-label="Insert"]'))
  await insertBtn.first().waitFor({ state: 'visible', timeout: 8000 })
  await insertBtn.first().click({ timeout: 5000 })

  // 9. ダイアログが閉じるのを待つ
  await page.waitForTimeout(2000)

  return result
}
