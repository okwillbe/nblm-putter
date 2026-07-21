# Drive ピッカーのスクロール選択修正 設計スペック

**Date:** 2026-07-21
**Status:** Approved

## Overview

`nblm-putter sync` の Phase 2（NotebookLM への追加）で使う Google Drive ピッカー操作 `addSourcesFromDrive` が、**新規ファイルが多いとごく一部しか選択できない**バグを修正する。

E2E で判明した実挙動: 新規23件を追加しようとしたが、実際に NotebookLM に追加されたのは3件のみだった。原因は2段階:

1. **Drive 反映遅延** — アップロード直後の8件がまだ Drive ピッカーのビューに出ていなかった。
2. **ビューポート外の未選択** — `addSourcesFromDrive` の選択ループが `isVisible()` でビューポート内のアイテムのみ対象とし、スクロール外（DOM には存在するが画面外）のアイテムを `continue` でスキップしていた。ピッカーのDOMには約100件描画されていたが、可視は3件だったため、選択は3件で確定した（スクリーンショット「3 件選択しました」で確認）。

## Background / Constraints

- NotebookLM には Drive ソース追加の公式 API が存在しないため、現状はブラウザ自動操作（Playwright + Drive ピッカー iframe）でしか実現できない。本修正はその制約下での暫定策である。
- **将来方針:** NotebookLM に公式 API（ソース追加・一覧・削除）が提供されたら、この複雑なピッカー操作を順次 API 呼び出しへ置き換える。本スペックの実装は「API が来たら差し替える暫定レイヤー」と位置づける。実装時はピッカー操作を `addSourcesFromDrive` に閉じ込め、呼び出し側（sync.ts）が実装詳細に依存しないインターフェース（下記の戻り値契約）を保つことで、将来の差し替えを容易にする。

## Design

### 対象ファイル

- `packages/cli/src/playwright/drive-picker.ts` — `addSourcesFromDrive`（特にファイル選択部）
- `packages/cli/src/commands/sync.ts` — 結果表示（実追加数・未追加の警告）

### 1. Drive 反映待ち（propagation wait）

ノートブックのサブフォルダを開いた後、`filesToAdd` の全ファイルがピッカー DOM に出現するまでポーリングする。

- 最大待機時間の上限（例: 60秒）内で、`filesToAdd` のうちピッカー内に存在する（`[aria-label*="<name>"]` が1件以上マッチする）数を数える。
- 全件揃えば次へ進む。揃わなければフォルダを再入場（親へ戻ってサブフォルダを再度開く）して再クエリし、一定間隔で再チェックする。
- タイムアウト時点で揃った分だけを選択対象とし、出現しなかったファイル名は `missing` として記録する。

### 2. スクロール選択（核心の修正）

`isVisible()` によるスキップを廃止し、各ターゲットを確実に選択する。

- `filesToAdd` の各ファイルについて:
  - `[aria-label*="<name>"]` のロケータを取得。
  - ロケータが0件（仮想化で DOM 未生成）の場合、ピッカーのスクロールコンテナを段階的にスクロールして読み込み、再取得する（下方向へ複数回、最下端に達するか出現するまで）。
  - 見つかったら `scrollIntoViewIfNeeded()` で可視化してから click（最初の1件は通常クリック、以降は `Control` 修飾のクリックで追加選択）。
  - スクロールしても見つからないファイルは `missing` に加える。
- 既存のフォルダナビゲーション（マイドライブ → nblm-putter → notebookId）はそのまま利用する。

### 3. 実選択数の検証と報告（インターフェース変更）

`addSourcesFromDrive` の戻り値を `Promise<void>` から次へ変更する:

```
Promise<{ added: string[]; missing: string[] }>
```

- 「挿入」ボタンを押す前に、選択済み件数を確認する（ピッカーの「N 件選択しました」表示のパース、または選択状態要素のカウント）。
- 実際に選択できたファイル名を `added`、出現しなかった／選択できなかったファイル名を `missing` として返す。
- 選択0件の場合は従来どおりエラー（`新規アップロードファイルがピッカー内に見つかりませんでした。`）とする。

### 4. sync.ts の結果表示

`addSourcesFromDrive` の戻り値を使って表示を正確にする。

- 「Done」メッセージを **実追加数（`added.length`）** に基づく表記へ変更（意図値 `sourcesToAdd.length` による過大表示を解消）。
- `missing.length > 0` の場合、警告を表示し、未追加ファイル名と復旧手順を案内する。
  - 復旧手順: 通常の再 sync は Phase 1 で Drive スキップされ Phase 2 に届かないため、`--force-overwrite` での再実行を促す（再アップロード → `newlyUploaded` → Phase 2 で既存ソースでなければ追加される）。

## Testing

- ピッカー操作は実ブラウザ依存でユニットテストが困難。ビルド（tsc）＋既存 vitest スイートで型安全と回帰を担保する。
- 集計・警告分岐など純粋ロジック（例: `added`/`missing` から表示文言・終了ステータスを決める部分）が切り出せる場合はユニットテストする。
- 実 E2E で検証: 今回のフォルダ（`jichitai-news/data/articles`、未追加分あり）に対し `--force-overwrite` 付きで再 sync し、未追加だった新規ファイルがすべて NotebookLM に追加されること、既存ソースは重複追加されないことを確認する。

## Out of Scope

- NotebookLM 公式 API への移行（API 提供後に別途対応）
- Phase 1（Drive アップロード）と Phase 2 の関係の再設計（Drive にあるが未ソースのファイルを通常 re-run で追加する仕組み）
- 既存重複ソースの掃除（案2 `clean`）
- 同名ソースのスキップ機能自体（実装・検証済み、本スペックの前段）
