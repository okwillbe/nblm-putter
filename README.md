# nblm-putter

ローカルフォルダのファイルを [NotebookLM](https://notebooklm.google.com) へ再帰的に自動登録する CLI ツール。ローカル Web UI も付属。

---

## 動作環境

- Node.js 20 以上
- pnpm 8 以上
- macOS（推奨）/ Linux / Windows (PowerShell)
- Google Chrome がインストール済みであること（`auth` コマンドで使用）
- （オプション）AWS アカウント — Secrets Manager を使うと複数マシンで設定を共有できる

---

## インストール

### リポジトリをクローンしてビルド

```bash
git clone https://github.com/shinchit/nblm-putter.git
cd nblm-putter
pnpm install
pnpm build
```

> `pnpm build` で Web UI と CLI の両方がビルドされます。ビルド後、`nblm-putter ui` コマンドで Web UI が正常に起動します。

### Playwright の Chromium をインストール（初回のみ）

`sync` コマンドはヘッドレス Chromium でファイルをアップロードするため、Playwright のブラウザが必要。

```bash
npx playwright install chromium
```

### グローバルにインストール（`nblm-putter` コマンドとして使えるようにする）

```bash
cd packages/cli
npm install -g .
```

インストール後は `nblm-putter --help` でどこからでも実行できる。

> **注意**: ビルド後に実行すること（`dist/` が必要）。  
> Windows では npm のグローバル bin (`%APPDATA%\npm`) が PATH に入っていれば自動で使えるようになる。

---

## ステップ 1: 初期設定

```bash
nblm-putter config init
```

対話形式で以下を設定する。

| 設定項目 | 説明 |
|---|---|
| AWS リージョン | Secrets Manager を使う場合のリージョン（デフォルト: `ap-northeast-1`） |
| AWS プロファイル | `~/.aws/credentials` のプロファイル名（デフォルト: `default`） |
| Secrets Manager 使用 | `y` で有効化。複数マシンでの設定共有に必要 |
| プロキシ使用 | `y` で有効化。Playwright のブラウザ通信をプロキシ経由にする |
| プロキシサーバー | プロキシのアドレス（例: `http://127.0.0.1:7890`） |
| プロキシユーザー名 | 認証が必要なプロキシの場合に入力（不要なら空欄） |
| プロキシパスワード | 認証が必要なプロキシの場合に入力（不要なら空欄） |

設定ファイルは `~/.nblm-putter/config.json` に保存される。

> **プロキシについて**
> プロキシは `auth` コマンド（Chrome 起動）と `sync` コマンド（ヘッドレス Chromium）の両方に適用される。認証なしのプロキシの場合、ユーザー名とパスワードは空欄のまま Enter でスキップできる。

> **Secrets Manager を使わない場合**  
> `n` を選ぶとローカルモードで動作する。ツール起動時に警告が表示されるが、すべての機能は正常に使える（マシン間の設定共有のみ無効）。

---

## ステップ 2: Google 認証

```bash
nblm-putter auth
```

システムの Google Chrome でブラウザが開くので、NotebookLM にアクセスしている Google アカウントでログインする。ログイン完了後、セッションが自動保存される。

- セッションは `~/.nblm-putter/session.json`（または Secrets Manager）に保存される
- セッションが切れたら再度 `nblm-putter auth` を実行する
- sync 実行時にセッションが自動更新され、有効期限が延長される

> **注意**: `auth` コマンドはシステムの Google Chrome を使用する。Chrome がインストールされていないと Google のボット検出に引っかかりログインできない。Web UI（`nblm-putter ui`）を閲覧するブラウザは Edge・Firefox など何でもよい。

---

## ステップ 2.5: Google Drive 連携（初回のみ）

ファイルは Google Drive 経由で NotebookLM に一括登録されます。事前に Google Cloud プロジェクトのセットアップが必要です。

### Google Cloud プロジェクトの準備

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「APIとサービス」→「ライブラリ」→ **Google Drive API** を有効化
3. 「認証情報」→「OAuth 2.0 クライアント ID」を作成
   - アプリケーションの種類: **デスクトップアプリ**
   - リダイレクト URI: `http://localhost:3001/callback`
4. `client_id` と `client_secret` を取得

### 設定と認証

```bash
nblm-putter config init   # client_id / client_secret を入力
nblm-putter auth          # NotebookLM ログイン後に Drive 認証も実施
```

Drive の認証が完了すると `~/.nblm-putter/drive-token.json` が生成される。

---

## ステップ 3: ファイルを同期（CLI）

```bash
nblm-putter notebooks list
```

NotebookLM に作成済みのノートブック一覧と ID が表示される。

```
1: My Research Notes  (id: abc123)
2: Project Docs       (id: def456)
```

```bash
nblm-putter sync /path/to/folder --notebook <ノートブックID>
```

指定したフォルダ以下のファイルを再帰的に走査し、まず Google Drive の `nblm-putter/{notebook-id}/` フォルダにアップロードする。その後 NotebookLM の Drive ピッカーで新規ファイルのみを追加する。ターミナルにプログレスバーと処理中ファイル名が表示される。

```bash
# 例
nblm-putter sync ~/Documents/research --notebook abc123

# 同名ファイルを上書きして強制再登録する場合
nblm-putter sync ~/Documents/research --notebook abc123 --force-overwrite
```

### 重複ファイルのスキップ

デフォルトでは、Google Drive の同じフォルダに **同名ファイルが既に存在する場合はスキップ**（アップロード・NotebookLM への追加ともに行わない）。ターミナルに `SKIP` として表示される。

```
  SKIP  すでに登録済みのファイル.pdf
  SKIP  別の既存ファイル.docx
  → 新しいファイル.pdf
```

新規ファイルが 0 件の場合は Phase 2（NotebookLM への追加）全体をスキップし、ブラウザも起動しない。

`--force-overwrite` を指定すると既存ファイルを上書きアップロードし、NotebookLM にも再追加する。

### sync の注意事項

- **Phase 1** でローカルファイルを Google Drive にアップロードし、**Phase 2** で NotebookLM の Drive ピッカーを使って新規ファイルのみ追加する。
- Drive 側の認証トークンが期限切れの場合は `nblm-putter auth` を再実行する。
- Drive ピッカーの UI が変更された場合、ピッカー操作が失敗することがある。その際は `/tmp/nblm-drive-picker-debug.png` を確認する。

---

## ignore パターンの設定

登録対象から除外するファイルを glob パターンで指定できる。

```bash
# パターンを追加
nblm-putter ignore add "*.log"
nblm-putter ignore add "node_modules/"
nblm-putter ignore add ".git/"
nblm-putter ignore add "*.tmp"

# 現在のパターン一覧を確認
nblm-putter ignore list

# パターンを削除
nblm-putter ignore remove "*.tmp"
```

パターンは [minimatch](https://github.com/isaacs/minimatch) 形式（gitignore 互換）。設定は次回の `sync` 実行時から反映される。

---

## Web UI を使う

```bash
nblm-putter ui
```

ブラウザで `http://localhost:3000` が開く。

| ページ | 機能 |
|---|---|
| **Sync** | ノートブックを選んでフォルダを指定し、リアルタイム進捗で同期実行 |
| **History** | 過去のジョブ一覧（日時・登録件数・エラー数） |
| **Ignore** | 除外パターンの追加・削除 |
| **Session** | `session.json` をアップロードしてセッションを更新 |

**Sync ページの機能:**
- ページを開くと既存ノートブックが自動ロードされ、先頭のノートブックが選択された状態になる
- **+ 新規作成** ボタンでノートブックを新規作成し、自動的に選択状態にする
- **Browse...** ボタンでフォルダをダイアログから選択できる（パスの手入力も可）
- 実行中はファイルごとの結果（✓ / ✗）と処理フェーズ（ボタン待ち / アップロード中）をリアルタイムで表示
- **中止** ボタンで実行中の sync を停止できる（現在処理中のファイルが完了した後に停止）
- 各ファイルの所要時間（ボタン待ち時間・アップロード時間）もログに記録される

ポートを変更したい場合:

```bash
nblm-putter ui --port 8080
```

---

## セッションの更新（別マシンや Web UI から）

別のマシンで `nblm-putter auth` を実行してセッションを取得し、生成された `~/.nblm-putter/session.json` を Web UI の **Session** ページからアップロードすることで、セッションを更新できる。

Secrets Manager が有効な場合は、`nblm-putter auth` を実行したマシンで自動的にクラウドへ同期される。

---

## Secrets Manager を使った複数マシン対応（オプション）

AWS Secrets Manager を有効にすると、以下がマシン間で自動同期される。

- NotebookLM のセッション (`nblm-putter/session`)
- ignore パターン (`nblm-putter/settings`)

### 必要な IAM 権限

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue",
    "secretsmanager:PutSecretValue",
    "secretsmanager:CreateSecret"
  ],
  "Resource": [
    "arn:aws:secretsmanager:*:*:secret:nblm-putter/*"
  ]
}
```

---

## データの保存場所

| データ | 保存先 |
|---|---|
| 設定ファイル | `~/.nblm-putter/config.json` |
| セッション（ローカル） | `~/.nblm-putter/session.json` |
| ジョブ履歴 | `~/.nblm-putter/db.sqlite` |
| ignore パターン（ローカル） | `~/.nblm-putter/db.sqlite`（settings テーブル） |
| Drive 認証トークン | `~/.nblm-putter/drive-token.json` |
| セッション（クラウド） | AWS Secrets Manager: `nblm-putter/session` |
| ignore パターン（クラウド） | AWS Secrets Manager: `nblm-putter/settings` |

---

## コマンドリファレンス

```
nblm-putter config init              初回セットアップ
nblm-putter auth                     Google 認証・セッション保存（Chrome が必要）
nblm-putter notebooks list           ノートブック一覧を表示
nblm-putter sync <folder>            フォルダをノートブックへ同期
  --notebook <id>                      登録先ノートブック ID（必須）
  --force-overwrite                    同名ファイルを上書きアップロード（デフォルトはスキップ）
nblm-putter ignore list              除外パターン一覧
nblm-putter ignore add <pattern>     除外パターンを追加
nblm-putter ignore remove <pattern>  除外パターンを削除
nblm-putter ui                       Web UI を起動
  --port <port>                        ポート番号（デフォルト: 3000）
```

---

## 開発

```bash
# 依存パッケージのインストール
pnpm install

# Playwright の Chromium をインストール（初回のみ）
npx playwright install chromium

# ビルド（UI → CLI の順でビルド）
pnpm build

# UI 開発サーバー（Vite、ホットリロード対応）
pnpm dev:ui
```

---

## 免責事項

- 本ツールは非公式のサードパーティ製ソフトウェアです。Google LLC および Google NotebookLM とは一切関係がありません。
- 本ツールは Playwright を使用してブラウザを自動操作します。NotebookLM の UI 変更により、予告なく動作しなくなる場合があります。
- Google の利用規約（[Google Terms of Service](https://policies.google.com/terms)）および NotebookLM の利用規約に従ってご使用ください。自動化ツールの使用が利用規約に抵触する可能性があることをご了承の上、自己責任でご利用ください。
- 本ツールの使用によって生じたいかなる損害（データ損失、アカウント停止、その他の損害）についても、作者は一切の責任を負いません。
- Google アカウントの認証情報およびセッション情報は、ローカルマシン（または設定した AWS Secrets Manager）にのみ保存されます。作者はこれらの情報を収集・送信しません。

## ライセンス

[MIT License](./LICENSE) © 2026 Shinchi Takahiro
