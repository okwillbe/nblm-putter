# Drive ピッカーのスクロール選択修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sync Phase 2 の Drive ピッカーで、新規ファイルが多くてもビューポート外までスクロールして全件選択し、Drive 反映遅延を待ち、実際に追加できた数を正確に報告する。

**Architecture:** `addSourcesFromDrive` の選択ロジックを「`isVisible()` でスキップ」から「`scrollIntoViewIfNeeded` ＋グリッド段階スクロールで確実に選択」へ変更。追加前に Drive 反映待ちポーリングを行い、戻り値を `{ added, missing }` に変更して sync.ts が実追加数・未追加を正確に表示する。ブラウザ自動操作は暫定策で、NotebookLM 公式 API が出たら `addSourcesFromDrive` の中身を差し替える前提（インターフェースを安定化）。

**Tech Stack:** TypeScript, Playwright (Chromium, frameLocator/iframe), commander, vitest, pnpm

## Global Constraints

- パッケージルート: `packages/cli`（ビルド・テストはこの中で実行）
- ビルド: `packages/cli` 内で `pnpm build`（= `tsc`）／テスト: `pnpm test`（= `vitest run`）
- 開発実行: `packages/cli` 内で `npx tsx src/index.ts <args>`（`pnpm dev -- <args>` は `--` が誤って引数化されるため使わない）
- 既存の Windows 限定 storage テスト失敗（`tests/storage/index.test.ts` の temp-dir EPERM）は既存・無関係。これ以外は全パス必須
- ターミナル出力の色は `sync.ts` の `c` オブジェクト（`c.yellow`/`c.red`/`c.green`/`c.cyan`/`c.dim`/`c.reset`）を使用
- コメント・ログ文言は既存コードに合わせ日本語可
- ピッカー操作は `addSourcesFromDrive` に閉じ込め、呼び出し側（sync.ts）は戻り値契約のみに依存させる（将来の API 差し替えを容易に保つ）
- 検証済み事実: ピッカーのファイルアイテムは `[aria-label*="<ファイル名>"]` でマッチする。追加対象フォルダ `jichitai-news/data/articles` は 159 件中、ノートブック `0c15f229-b5ca-47da-b7e9-e3d37548adbc` に 23 件が未ソース

---

### Task 1: `addSourcesFromDrive` をスクロール選択＋反映待ち＋戻り値変更に改修

**Files:**
- Modify: `packages/cli/src/playwright/drive-picker.ts`

**Interfaces:**
- Consumes: なし（既存の import: `Page` from 'playwright', `fs`）
- Produces: `export async function addSourcesFromDrive(page: Page, notebookId: string, filesToAdd?: string[]): Promise<{ added: string[]; missing: string[] }>` — `filesToAdd` 指定時、実際に選択・挿入できたファイル名を `added`、ピッカーに出現しなかった／選択できなかったものを `missing` で返す。`filesToAdd` 未指定時（全件選択モード）は `{ added: [], missing: [] }` を返す（呼び出し側 sync.ts は常に `filesToAdd` を渡すため集計対象外）。

- [ ] **Step 1: ヘルパー関数（グリッドスクロール）をファイル先頭付近に追加**

`packages/cli/src/playwright/drive-picker.ts` の `PICKER_FRAME_SELECTORS` 定義の直後に、ピッカー iframe 内の最大スクロール要素を下方向へスクロールするヘルパーを追加する。

```typescript
// ピッカー iframe 内で「最もスクロール量の大きいスクロール可能要素」を下方向へ約8割ぶんスクロールする。
// 仮想化されたグリッドで未描画のアイテムを読み込ませるために使う。
async function scrollPickerGrid(page: Page): Promise<void> {
  const frame = page.frames().find(
    f => f.url().includes('docs.google.com') || f.url().includes('drive.google.com')
  )
  if (!frame) return
  await frame.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(el => {
      const style = getComputedStyle(el)
      return el.scrollHeight > el.clientHeight + 50 &&
        (style.overflowY === 'auto' || style.overflowY === 'scroll')
    })
    const target = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    if (target) {
      target.scrollTop = Math.min(target.scrollTop + target.clientHeight * 0.8, target.scrollHeight)
    }
  }).catch(() => {})
  await page.waitForTimeout(600)
}
```

- [ ] **Step 2: 反映待ちヘルパー（propagation wait）を追加**

同じくヘルパーとして、`filesToAdd` が全件ピッカー内に出現するまで、フォルダを再入場しながら待つ関数を追加する。`pickerFrame` は `page.frameLocator(sel)` の戻り値型。

```typescript
import type { FrameLocator } from 'playwright'

// filesToAdd のうちピッカー内に aria-label でマッチする件数を数える。
async function countPresent(pickerFrame: FrameLocator, names: string[]): Promise<number> {
  let n = 0
  for (const name of names) {
    if (await pickerFrame.locator(`[aria-label*="${name}"]`).count() > 0) n++
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
```

> **注:** 再入場のため親フォルダ（nblm-putter）がパンくず等から辿れる前提。もし再入場でエラーになる場合でも `catch` で握りつぶし、待機のみで再カウントする（実装時に実挙動で確認）。

- [ ] **Step 3: 選択ロジック（ステップ7）を置き換える**

`drive-picker.ts` の「7. ファイルを選択」ブロック（現行 `if (filesToAdd && filesToAdd.length > 0) { ... } else { ... }` 全体、行番号は前後するが `await page.waitForTimeout(800)` の直前まで）を、以下に置き換える。`else`（全件選択）ブランチは互換のため残す。

```typescript
  // 7. ファイルを選択
  const result: { added: string[]; missing: string[] } = { added: [], missing: [] }
  if (filesToAdd && filesToAdd.length > 0) {
    // まず対象ファイルが Drive 反映されるのを待つ（アップロード直後は未出現のことがある）
    await waitForFilesPresent(page, pickerFrame, notebookId, filesToAdd)

    const MAX_SCROLLS = 20
    for (const name of filesToAdd) {
      const item = pickerFrame.locator(`[aria-label*="${name}"]`).first()

      // DOM に出るまでグリッドを段階スクロール（仮想化対策）
      let found = await item.count() > 0
      for (let s = 0; s < MAX_SCROLLS && !found; s++) {
        await scrollPickerGrid(page)
        found = await item.count() > 0
      }
      if (!found) {
        result.missing.push(name)
        continue
      }

      // ビューポート内へ入れてからクリック（先頭は通常、以降は Ctrl+ で追加選択）
      await item.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      const modifiers: ('Control')[] = result.added.length === 0 ? [] : ['Control']
      const clicked = await item.click({ modifiers, timeout: 5000 }).then(() => true).catch(() => false)
      if (clicked) result.added.push(name)
      else result.missing.push(name)
    }

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
```

- [ ] **Step 4: 関数シグネチャと `return` を変更**

関数宣言を戻り値型付きに変更する:

```typescript
export async function addSourcesFromDrive(
  page: Page,
  notebookId: string,
  filesToAdd?: string[],
): Promise<{ added: string[]; missing: string[] }> {
```

そして「9. ダイアログが閉じるのを待つ」の `await page.waitForTimeout(2000)` の直後（関数末尾）に追加:

```typescript
  return result
```

- [ ] **Step 5: ビルドで型チェック**

Run: `packages/cli` 内で `pnpm build`
Expected: tsc がエラーなく完了（`FrameLocator` 型 import 追加済み、戻り値型が一致）

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/playwright/drive-picker.ts
git commit -m "feat: Drive ピッカーをスクロール選択＋反映待ちに改修し実追加数を返す"
```

---

### Task 2: sync.ts で実追加数・未追加を正確に表示

**Files:**
- Modify: `packages/cli/src/commands/sync.ts`

**Interfaces:**
- Consumes: `addSourcesFromDrive(...): Promise<{ added: string[]; missing: string[] }>`（Task 1）
- Produces: なし（コマンドの最終挙動）

- [ ] **Step 1: `addSourcesFromDrive` の戻り値を受け取り、実追加数で集計**

`sync.ts` の Phase 2、`await addSourcesFromDrive(page, opts.notebook, sourcesToAdd)` の行（現行152行目付近）を以下に置き換える。`addedCount` を実追加数に更新し、`missing` を保持する。

```typescript
        const addResult = await addSourcesFromDrive(page, opts.notebook, sourcesToAdd)
        addedCount = addResult.added.length
        const notAdded = addResult.missing
        await page.close()
        await ctx.close().catch(() => {})

        if (notAdded.length > 0) {
          process.stdout.write(
            `\n  ${c.yellow}⚠${c.reset}  ${notAdded.length} 件はピッカーに出現せず追加できませんでした:\n`
          )
          for (const name of notAdded) {
            process.stdout.write(`     ${c.dim}- ${name}${c.reset}\n`)
          }
          process.stdout.write(
            `  ${c.dim}Drive 反映待ちの可能性があります。--force-overwrite を付けて再実行すると再追加を試みます。${c.reset}\n`
          )
        }
```

> **注:** 置き換え対象は `await addSourcesFromDrive(...)` と、その直後の `await page.close()` / `await ctx.close().catch(() => {})` の2行（これらは上記ブロックに含めた）。`try` の構造・`catch`・`finally` はそのまま残す。

- [ ] **Step 2: 最終「Done」メッセージを実追加数に更新**

`sync.ts` 末尾の完了メッセージ（現行 `${addedCount} file(s) uploaded and added to NotebookLM.` を含む `process.stdout.write`）はすでに `addedCount` を使用しているため、Task 1/2 で `addedCount = addResult.added.length` に更新済みなら**変更不要**。文言だけ実態に合わせて確認する（`added` が意図数より少ない場合でも正しい数が出る）。該当行を読んで `addedCount` 参照であることを確認するだけでよい。

- [ ] **Step 3: ビルド＋既存テスト**

Run: `packages/cli` 内で `pnpm build && pnpm test`
Expected: コンパイル成功。既存テストは storage の既存失敗1件を除き全パス。

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/sync.ts
git commit -m "feat: sync が実追加数を表示し未追加ファイルを警告"
```

---

### Task 3: 実 E2E 検証（--force-overwrite で未追加分を再追加）

**Files:**
- なし（検証のみ。コード変更が必要になった場合は Task 1/2 に戻る）

**Interfaces:**
- Consumes: Task 1/2 の実装
- Produces: なし

- [ ] **Step 1: 事前のソース件数を記録**

読み取り専用でノートブックの現ソース数を確認する（前回 E2E で 236要素/141ユニーク、うち新規は3件のみ追加済み）。`packages/cli` 内で一時スクリプトまたは既存 `debug` を使い、`.source-title` の件数を控える。

- [ ] **Step 2: `--force-overwrite` 付きで再 sync**

Run: `packages/cli` 内で
`npx tsx src/index.ts sync "C:\Users\進地崇裕\Develop\jichitai-news\data\articles" --notebook 0c15f229-b5ca-47da-b7e9-e3d37548adbc --force-overwrite`
Expected:
- Phase 1 で全 159 件が上書きアップロード（`--force-overwrite`）→ `newlyUploaded` に載る
- Phase 2 で既存ソース（前回追加済み分＋既存136＋今回3）は `SKIP (already a source)`、未追加だった約20件が `sourcesToAdd` になり、スクロール選択で**全件**追加される
- 「⚠ 未追加」警告が出ないか、出ても大幅に減っていること

- [ ] **Step 3: 事後のソース件数で増加を確認**

Step 1 と同じ方法でソース数を再取得。未追加だった新規ファイルがすべて `.source-title` に出現し、ユニーク数が期待どおり増えている（前回未追加の約20件ぶん）ことを確認する。既存ソースが重複追加されていない（スキップが効いている）ことも確認する。

- [ ] **Step 4: 結果を記録**

検証結果（追加成功数・残 missing・重複の有無）を進捗台帳または報告に記録する。missing が残る場合は反映遅延の待機時間や MAX_SCROLLS の調整を検討（必要なら Task 1 に戻る）。

---

### Task 4: README に未追加時の挙動を追記

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: なし
- Produces: なし

- [ ] **Step 1: 「重複ファイルのスキップ」周辺に追記**

`README.md` の Phase 2 説明付近（「### 重複ファイルのスキップ」または「### sync の注意事項」）に、以下の趣旨を周辺トーンに合わせて追記する。

```markdown
Phase 2 では、新規ファイルが多い場合でも Drive ピッカーをスクロールして全件を選択・追加する。アップロード直後で Drive への反映が間に合わないファイルは追加されず、ターミナルに「⚠ 追加できませんでした」として一覧表示される。その場合は `--force-overwrite` を付けて再実行すると再追加を試みる。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: Phase 2 のスクロール選択と未追加時の再実行手順を追記"
```

---

## Self-Review

**Spec coverage:**
- 「Drive 反映待ち（propagation wait）」→ Task 1 Step 2（`waitForFilesPresent`）✓
- 「スクロール選択（isVisible 廃止・scrollIntoViewIfNeeded・段階スクロール）」→ Task 1 Step 1・3 ✓
- 「戻り値を `{ added, missing }` に変更」→ Task 1 Step 4 ✓
- 「sync.ts が実追加数を表示・未追加を警告・--force-overwrite 案内」→ Task 2 ✓
- 「実 E2E 検証」→ Task 3 ✓
- 「README 追記」→ Task 4 ✓
- 「暫定策・API 差し替え前提でインターフェースを安定化」→ 戻り値契約を addSourcesFromDrive に閉じ、sync.ts はそれのみ依存（Global Constraints + Task 1 Interfaces）✓

**Placeholder scan:** 実コードを各ステップに提示。Task 3 は検証タスクのため件数は実行時に確定（意図的）。

**Type consistency:** `addSourcesFromDrive(...): Promise<{ added: string[]; missing: string[] }>`（Task 1）と Task 2 の `addResult.added` / `addResult.missing` 参照が一致。`scrollPickerGrid(page)`・`waitForFilesPresent(page, pickerFrame, notebookId, names)`・`countPresent(pickerFrame, names)` のシグネチャは Task 1 内で定義・使用が一致。✓

**テスト方針の正直さ:** 本修正の中核はブラウザ操作でユニットテスト不能。切り出せる純粋ロジックが無いため、ビルド＋既存スイート＋実 E2E で担保する（偽のテストは作らない）。
