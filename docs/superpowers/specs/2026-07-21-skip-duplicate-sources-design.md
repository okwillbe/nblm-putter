# 同名ソースの重複追加スキップ 設計スペック

**Date:** 2026-07-21
**Status:** Approved

## Overview

`nblm-putter sync` 実行時に、NotebookLM 側に既に同名のソースが存在する場合、そのファイルの NotebookLM への追加をスキップする。これにより、`--force-overwrite` 使用時や過去の sync 実行の蓄積によって発生する「同一名ソースの重複」を防ぐ。

3つの検討案（案1: 常にスキップ / 案2: clean コマンド / 案3: sync 時に一括削除→再sync）のうち、**案1: 常にスキップ** を採用する。既存の重複を掃除する機能（案2/3）はスコープ外とし、今後の重複発生防止に絞る。

## Background

現状の重複防止は **Google Drive のファイル名** に対してのみ行われている（`drive/client.ts` の `uploadFile`）。sync フローは2フェーズ:

1. **Phase 1:** 対象ファイルを Google Drive にアップロード（Drive 上で同名ファイルはスキップ、`--force-overwrite` 時は上書き）
2. **Phase 2:** 新規アップロード分（`newlyUploaded`）のみ Drive ピッカー経由で NotebookLM に追加

問題点: NotebookLM 側の「ソース一覧」は一切参照していない。そのため、

- `--force-overwrite` 時は Drive 上のファイルが上書きされ `newlyUploaded` に載るため、NotebookLM に新しいソースが追加され、古い同名ソースが残って重複する。
- 過去の sync で既に NotebookLM にソースが存在していても、Drive 側で新規アップロードと判定されれば再度追加され重複する。

## Design

### 方針

Phase 2 でノートブックページを開いた直後に **NotebookLM の既存ソース名一覧** を取得し、`newlyUploaded` のうち既存ソースと同名のものを除外してからピッカー選択を行う。

**Phase 1（Drive アップロード）の挙動は変更しない。** Drive へのアップロードは従来どおり行い、NotebookLM への追加だけをスキップする。これにより Drive 側はバックアップとして最新状態を保ちつつ、NotebookLM 側の重複だけを防ぐ。

### コンポーネント

#### 1. DOM 調査（`commands/debug.ts` 拡張）

実装に先立ち、NotebookLM のソース一覧 DOM 構造を確認する。

- 既存の `debug` コマンドに、ノートブックを開いた状態でソースパネル内の各ソース要素をダンプする処理を追加する。
- 各ソース要素の `aria-label` / テキスト / class / role などセレクタ候補を出力する。
- 一度実行して実 DOM を確認し、`listSources` で使うセレクタを確定する。

#### 2. `listSources` 関数（`playwright/notebooklm.ts`）

```
export async function listSources(page: Page): Promise<string[]>
```

- 引数: `openNotebookPage` で開いた既存の notebook `Page`（再ナビゲーション不要）。
- 戻り値: 既存ソース名の配列（`string[]`）。
- DOM 調査で確定したセレクタでソースパネルからソース名テキストを抽出する。
- ソースパネルが空・未描画の場合は空配列を返す（失敗ではなく「0件」として扱う）。

**名前の突き合わせ:** NotebookLM のソース名は、アップロードしたファイルの `basename` と一致する想定。突き合わせは完全一致で行う。NotebookLM 側で表示名が加工される（拡張子省略・truncate 等）可能性は DOM 調査で確認し、必要ならトリム/正規化を検討する。

#### 3. sync フローへの組み込み（`commands/sync.ts`）

Phase 2 の変更:

1. `openNotebookPage` でページを開いた直後に `listSources(page)` を呼ぶ。
2. `newlyUploaded` を、既存ソース名に含まれないものだけに絞った `sourcesToAdd` を作る。
3. 除外されたファイルは `SKIP (already a source)` としてターミナルに表示し、`skipped` カウントに含める。
4. `sourcesToAdd` が 0 件なら `addSourcesFromDrive` を呼ばず（ピッカーを開かず）、Done 表示に進む。
5. `sourcesToAdd` が 1 件以上なら、それを `addSourcesFromDrive(page, notebookId, sourcesToAdd)` に渡す。

**エラーハンドリング:** `listSources` が例外を投げた場合は、安全側に倒して sync を中断する。既存ソースを確認できない状態で追加を続けると重複を生む恐れがあるため、`newlyUploaded` の追加は行わず、エラーを表示してジョブを `failed` にして終了する（`process.exit(1)`）。Phase 1 の Drive アップロードは既に完了しているため、ユーザーは再実行すれば Drive 側はスキップされ Phase 2 のみリトライされる。

### データフロー

```
Phase 1: files → Drive upload → newlyUploaded[] (Drive で新規/上書きされたファイル名)

Phase 2:
  openNotebookPage
    → listSources(page) → existingSources[]
    → sourcesToAdd = newlyUploaded.filter(name => !existingSources.includes(name))
    → 除外分を SKIP 表示
    → sourcesToAdd.length === 0 ? Done
                               : addSourcesFromDrive(page, notebook, sourcesToAdd)
```

## Testing

- `listSources` のロジック（DOM からの名前抽出）は、DOM 構造確定後に Playwright の実挙動で確認する（純粋なユニットテストは困難なため、debug コマンドの出力で検証）。
- sync のフィルタリングロジック（`newlyUploaded` から既存ソースを除外する部分）は、可能なら純粋関数に切り出してユニットテスト可能にする。
- 既存の vitest テスト（`ignore/filter`, `storage`, `db` 等）が壊れないことを確認する。

## Out of Scope

- 既存の重複ソースの掃除（案2: clean コマンド）
- sync 時の一括削除→再 sync（案3）
- NotebookLM ソースの削除機能全般
- Drive アップロード（Phase 1）の挙動変更
