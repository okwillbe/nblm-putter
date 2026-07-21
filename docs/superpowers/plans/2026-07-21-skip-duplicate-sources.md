# 同名ソースの重複追加スキップ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nblm-putter sync` 実行時、NotebookLM に既に同名ソースが存在するファイルは NotebookLM への追加をスキップし、同一名ソースの重複を防ぐ。

**Architecture:** sync の Phase 2（NotebookLM への追加）の直前に NotebookLM の既存ソース名一覧を取得し、`newlyUploaded` から既存ソースと同名のものを除外してから Drive ピッカーに渡す。Phase 1（Drive アップロード）の挙動は変更しない。ソース名抽出は Playwright、除外ロジックは純粋関数に切り出してユニットテストする。

**Tech Stack:** TypeScript, Playwright (Chromium), commander, vitest, pnpm (monorepo)

## Global Constraints

- パッケージルート: `packages/cli`（テスト・ビルドはこのディレクトリで実行）
- テスト実行: `pnpm --filter nblm-putter test`（内部的に `vitest run`）／ 単体は `packages/cli` 内で `pnpm test`
- テストファイル配置: `packages/cli/tests/**/*.test.ts`
- 開発実行（ビルド不要）: `packages/cli` 内で `pnpm dev -- <args>`（= `tsx src/index.ts`）
- ターミナル出力の色コードは `sync.ts` 内の `c` オブジェクト（`c.yellow` 等）に合わせる
- コメント・ログ文言は既存コードに合わせ日本語可（既存 `sync.ts`/`drive-picker.ts` の慣習に従う）
- 名前突き合わせは basename の完全一致（DOM 調査で表示名の加工が判明した場合は Task 3 で正規化を追加）

---

### Task 1: debug コマンドにソース一覧ダンプを追加し、DOM を調査する

**目的:** `listSources`（Task 3）で使うソース要素のセレクタを実 DOM から確定する。このタスクの成果物は「確定したセレクタ」であり、Task 3 に引き渡す。

**Files:**
- Modify: `packages/cli/src/commands/debug.ts`（既存 action の末尾、`finally` の直前にダンプ処理を追加）

**Interfaces:**
- Consumes: なし
- Produces: ソース一覧要素の確定セレクタ（Task 3 の `SOURCE_ITEM_SELECTOR` / 名前抽出方法として使用）

- [ ] **Step 1: ソース一覧ダンプ処理を追加**

`packages/cli/src/commands/debug.ts` の `try` ブロック内、既存の FILE INPUTS ダンプ（`console.log('\n=== FILE INPUTS (after click) ===')` のブロック）の後に、以下を追加する。既存のソース一覧を調べるため、まず Escape でダイアログを閉じてからソースパネルを走査する。

```typescript
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
```

- [ ] **Step 2: 型チェックが通ることを確認**

Run: `packages/cli` 内で `pnpm build`
Expected: エラーなくコンパイル成功（`join` と `getConfigDir` は既に import 済み）

- [ ] **Step 3: debug コマンドを実行して DOM を確認**

Run: `packages/cli` 内で `pnpm dev -- debug --notebook <既存ソースが複数あるノートブックID>`
Expected: `=== SOURCE LIST CANDIDATES ===` の下に各ソース要素の候補が出力される。少なくとも1つのセレクタパターンで、各ソースの「ファイル名」がテキストまたは aria-label として取得できることを確認する。

- [ ] **Step 4: 確定セレクタを記録**

出力を見て、ソース1件を一意に指す要素セレクタと、そこからファイル名を取り出す方法（`textContent` か `aria-label` か、加工の有無）を決める。この2点を本タスクのコメントとして次のように控えておく（Task 3 で使用）:
- ソース要素セレクタ: `______`
- 名前抽出: `textContent` / `aria-label`（該当する方）、正規化の要否: `______`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/debug.ts
git commit -m "feat: debug コマンドにソース一覧ダンプを追加"
```

---

### Task 2: 既存ソース除外の純粋関数を実装（TDD）

**Files:**
- Create: `packages/cli/src/sync/dedup.ts`
- Test: `packages/cli/tests/sync/dedup.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `export function filterNewSources(uploaded: string[], existing: string[]): string[]` — `uploaded` のうち `existing` に**含まれない**名前だけを、元の順序を保って返す純粋関数。突き合わせは完全一致。

- [ ] **Step 1: Write the failing test**

`packages/cli/tests/sync/dedup.test.ts` を作成:

```typescript
import { describe, it, expect } from 'vitest'
import { filterNewSources } from '../../src/sync/dedup'

describe('filterNewSources', () => {
  it('returns all uploaded when existing is empty', () => {
    expect(filterNewSources(['a.pdf', 'b.pdf'], [])).toEqual(['a.pdf', 'b.pdf'])
  })

  it('excludes names already present in existing', () => {
    expect(filterNewSources(['a.pdf', 'b.pdf', 'c.pdf'], ['b.pdf'])).toEqual(['a.pdf', 'c.pdf'])
  })

  it('returns empty when all uploaded already exist', () => {
    expect(filterNewSources(['a.pdf', 'b.pdf'], ['a.pdf', 'b.pdf'])).toEqual([])
  })

  it('preserves original order of uploaded', () => {
    expect(filterNewSources(['c.pdf', 'a.pdf', 'b.pdf'], ['a.pdf'])).toEqual(['c.pdf', 'b.pdf'])
  })

  it('matches names exactly (no partial match)', () => {
    expect(filterNewSources(['report.pdf', 'report.pdf.bak'], ['report.pdf'])).toEqual(['report.pdf.bak'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `packages/cli` 内で `pnpm test -- dedup`
Expected: FAIL（`Cannot find module '../../src/sync/dedup'` または `filterNewSources is not a function`）

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/sync/dedup.ts` を作成:

```typescript
// NotebookLM に既に存在するソース名を除外し、新規に追加すべき名前だけを返す。
// 突き合わせは完全一致。uploaded の順序を保つ。
export function filterNewSources(uploaded: string[], existing: string[]): string[] {
  const existingSet = new Set(existing)
  return uploaded.filter(name => !existingSet.has(name))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `packages/cli` 内で `pnpm test -- dedup`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/dedup.ts packages/cli/tests/sync/dedup.test.ts
git commit -m "feat: 既存ソース除外の純粋関数 filterNewSources を追加"
```

---

### Task 3: listSources 関数を実装（notebooklm.ts）

**Files:**
- Modify: `packages/cli/src/playwright/notebooklm.ts`（末尾に関数追加）

**Interfaces:**
- Consumes: Task 1 で確定したソース要素セレクタと名前抽出方法
- Produces: `export async function listSources(page: Page): Promise<string[]>` — `openNotebookPage` で開いた既存 `Page` を受け取り、現在の NotebookLM 既存ソース名の配列を返す。ソースパネルが空・未描画なら空配列を返す。

- [ ] **Step 1: listSources を実装**

`packages/cli/src/playwright/notebooklm.ts` の末尾に追加する。以下は Task 1 の調査結果を反映するテンプレート。`SOURCE_ITEM_SELECTOR` を Task 1 で確定したセレクタに、名前抽出部を確定した方法（`textContent` または `aria-label`）に置き換える。

```typescript
// NotebookLM の指定ノートブックページから、現在の既存ソース名一覧を取得する。
// page は openNotebookPage で開いた状態のものを渡す（再ナビゲーションしない）。
// ソースパネルが空・未描画の場合は空配列を返す。
export async function listSources(page: Page): Promise<string[]> {
  // Task 1 の調査で確定したセレクタに置き換える
  const SOURCE_ITEM_SELECTOR = '[role="listitem"]'

  // ソースパネルが描画されるまで待つ（無ければ 0 件）
  await page
    .waitForSelector(SOURCE_ITEM_SELECTOR, { timeout: 8000 })
    .catch(() => {})

  const names = await page.evaluate((selector) => {
    return Array.from(document.querySelectorAll(selector))
      .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0)
  }, SOURCE_ITEM_SELECTOR)

  return names
}
```

> **注:** Task 1 の調査で名前が `aria-label` 側にある、または表示名が basename と一致しない（拡張子省略・truncate 等）と判明した場合は、`page.evaluate` 内の抽出を `getAttribute('aria-label')` に変え、必要な正規化（例: 末尾 `…` の除去）を加える。`filterNewSources`（Task 2）は完全一致なので、ここで返す名前が Drive にアップロードした basename と一致するように整えること。

- [ ] **Step 2: 型チェックが通ることを確認**

Run: `packages/cli` 内で `pnpm build`
Expected: エラーなくコンパイル成功

- [ ] **Step 3: listSources の実挙動を確認**

Task 1 と同じノートブックに対して、一時的に確認する。`packages/cli` 内で以下のワンライナーを実行（または debug コマンドに一時的に `listSources` 呼び出しを足して確認してもよい）:

Run: `pnpm dev -- debug --notebook <既存ソースが複数あるノートブックID>` の出力と、Task 1 で得たソース名が `listSources` の想定抽出方法で正しく取れることを目視確認。
Expected: 既存ソースのファイル名がすべて配列として取得できる想定であること。取得できない場合はセレクタ／抽出方法を修正して再確認。

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/playwright/notebooklm.ts
git commit -m "feat: NotebookLM の既存ソース名を取得する listSources を追加"
```

---

### Task 4: sync フローに重複スキップを組み込む（sync.ts）

**Files:**
- Modify: `packages/cli/src/commands/sync.ts`

**Interfaces:**
- Consumes:
  - `filterNewSources(uploaded: string[], existing: string[]): string[]`（Task 2）
  - `listSources(page: Page): Promise<string[]>`（Task 3）
- Produces: なし（コマンドの最終挙動）

- [ ] **Step 1: import を追加**

`packages/cli/src/commands/sync.ts` の import 群に追加:

```typescript
import { openNotebookPage, listSources } from '../playwright/notebooklm'
import { filterNewSources } from '../sync/dedup'
```

（既存の `import { openNotebookPage } from '../playwright/notebooklm'` を上の形に統合する。`addSourcesFromDrive` の import 行はそのまま残す。）

- [ ] **Step 2: Phase 2 に既存ソース取得と除外を組み込む**

現在の Phase 2 ブロック（`const browser = await launchHeadlessBrowser()` から `finally { await browser.close()... }` まで）を、以下に置き換える。ページを開いた直後に `listSources` を呼び、失敗時は sync を中断する。

```typescript
      process.stdout.write(
        `\n${c.bold}Phase 2${c.reset}  Checking existing sources & adding new source(s) to NotebookLM...\n\n`
      )

      const browser = await launchHeadlessBrowser()
      try {
        const ctx = await createHeadlessContext(browser)
        const page = await openNotebookPage(ctx, opts.notebook)

        // NotebookLM の既存ソース名を取得。取得できない場合は重複を生む恐れがあるため中断する。
        let existingSources: string[]
        try {
          existingSources = await listSources(page)
        } catch (err) {
          process.stdout.write(
            `  ${c.red}✗${c.reset}  既存ソース一覧の取得に失敗したため中断しました: ${err instanceof Error ? err.message : err}\n` +
            `  ${c.dim}Drive へのアップロードは完了しています。再実行すると Phase 2 のみリトライされます。${c.reset}\n`
          )
          await page.close()
          await ctx.close().catch(() => {})
          updateJob(jobId, { status: 'failed' })
          process.exit(1)
        }

        const sourcesToAdd = filterNewSources(newlyUploaded, existingSources)
        const alreadySources = newlyUploaded.filter(n => !sourcesToAdd.includes(n))
        for (const name of alreadySources) {
          skipped++
          process.stdout.write(`  ${c.yellow}SKIP${c.reset}  ${pad(name, 50)} ${c.dim}(already a source)${c.reset}\n`)
        }

        if (sourcesToAdd.length === 0) {
          await page.close()
          await ctx.close().catch(() => {})
          updateJob(jobId, { status: 'done' })
          process.stdout.write(
            `\n${c.green}✓ Done.${c.reset}  ` +
            `追加対象の新規ソースはありませんでした（全て既存ソース）。` +
            `${c.dim}  skipped: ${skipped}  Job ID: ${jobId}${c.reset}\n\n`
          )
          return
        }

        process.stdout.write(
          `\n  Adding ${c.cyan}${sourcesToAdd.length}${c.reset} new source(s) via Drive picker...\n\n`
        )
        await addSourcesFromDrive(page, opts.notebook, sourcesToAdd)
        await page.close()
        await ctx.close().catch(() => {})
      } catch (err) {
        process.stdout.write(`  ${c.red}✗${c.reset}  Drive picker failed: ${err instanceof Error ? err.message : err}\n`)
        updateJob(jobId, { status: 'failed' })
        process.exit(1)
      } finally {
        await browser.close().catch(() => {})
      }

      updateJob(jobId, { status: errors.length === total ? 'failed' : 'done' })
      process.stdout.write(
        `${c.green}✓ Done.${c.reset}  ` +
        `${sourcesToAdd.length} file(s) uploaded and added to NotebookLM.` +
        `${c.dim}  skipped: ${skipped}  Job ID: ${jobId}${c.reset}\n\n`
      )
```

> **注:** 最終行の `sourcesToAdd` は上の `try` ブロック内で宣言されている。スコープの都合で参照できない場合は、`try` の外側（Phase 2 ブロック開始前）に `let addedCount = 0` を宣言し、`sourcesToAdd.length` を代入して最終メッセージで `addedCount` を使う形にリファクタする。実装時にコンパイルエラーが出たらこの方針で解消すること。

- [ ] **Step 3: 型チェック・既存テストが通ることを確認**

Run: `packages/cli` 内で `pnpm build && pnpm test`
Expected: コンパイル成功。既存テスト（filter/storage/db/config/dedup）すべて PASS。

- [ ] **Step 4: 実挙動を確認（既存ソースありのノートブックで sync）**

Run: `packages/cli` 内で `pnpm dev -- sync <フォルダ> --notebook <既存ソースありID>`
Expected: 既にソースとして存在するファイルが `SKIP (already a source)` と表示され、NotebookLM に重複追加されない。新規ファイルのみピッカーで追加される。全て既存の場合はピッカーを開かず Done。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/sync.ts
git commit -m "feat: sync 時に NotebookLM 既存ソースと同名のファイルの追加をスキップ"
```

---

### Task 5: README を更新

**Files:**
- Modify: `README.md`（「重複ファイルのスキップ」セクション周辺）

**Interfaces:**
- Consumes: なし
- Produces: なし

- [ ] **Step 1: README に NotebookLM 側の重複スキップを追記**

`README.md` の「### 重複ファイルのスキップ」セクション（135行目付近）に、Drive 側スキップの説明に続けて以下の趣旨を追記する。実際の文面は周辺のトーンに合わせて調整してよい:

```markdown
また、NotebookLM 側に既に**同名のソース**が存在するファイルは、Phase 2（NotebookLM への追加）でスキップされ、ターミナルに `SKIP (already a source)` と表示される。これにより `--force-overwrite` 使用時や過去の sync 実行の蓄積による同名ソースの重複を防ぐ。

なお、既存ソース一覧の取得に失敗した場合は、重複を生む恐れがあるため sync を中断する（Drive へのアップロードは完了しているため、再実行すると Phase 2 のみリトライされる）。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: NotebookLM 側の同名ソーススキップ挙動を README に追記"
```

---

## Self-Review

**Spec coverage:**
- 「Phase 2 前に既存ソース名取得」→ Task 3（listSources）+ Task 4（組み込み）✓
- 「newlyUploaded から既存ソースを除外」→ Task 2（filterNewSources）+ Task 4 ✓
- 「除外分を SKIP 表示・skipped に加算」→ Task 4 Step 2 ✓
- 「0 件ならピッカーを開かず Done」→ Task 4 Step 2 ✓
- 「listSources 失敗時は failed + process.exit(1) で中断」→ Task 4 Step 2 ✓
- 「Phase 1 の挙動は変更しない」→ Phase 1 ブロックは未変更 ✓
- 「DOM 調査は debug コマンド拡張」→ Task 1 ✓
- 「フィルタロジックは純粋関数でユニットテスト」→ Task 2 ✓
- 「既存 vitest テストが壊れない」→ Task 4 Step 3 ✓
- README 追記 → Task 5 ✓

**Placeholder scan:** Task 1/3 に実 DOM 依存の空欄（確定セレクタ）があるが、これは調査タスクの成果物であり意図的。コードステップは全て実コードを提示済み。

**Type consistency:** `filterNewSources(uploaded, existing): string[]`（Task 2）と Task 4 の呼び出しが一致。`listSources(page): Promise<string[]>`（Task 3）と Task 4 の呼び出しが一致。✓
