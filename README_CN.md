# nblm-putter

将本地文件夹中的文件递归自动注册到 [NotebookLM](https://notebooklm.google.com) 的 CLI 工具。附带本地 Web UI。

---

## 运行环境

- Node.js 20 以上
- pnpm 8 以上
- macOS（推荐）/ Linux / Windows (PowerShell)
- 已安装 Google Chrome（`auth` 命令需要使用）
- （可选）AWS 账户 — 使用 Secrets Manager 可在多台机器间共享配置

---

## 安装

### 克隆仓库并构建

```bash
git clone https://github.com/shinchit/nblm-putter.git
cd nblm-putter
pnpm install
pnpm build
```

> `pnpm build` 会同时构建 Web UI 和 CLI。构建完成后，`nblm-putter ui` 命令才能正常启动 Web UI。

### 安装 Playwright 的 Chromium（仅首次）

`sync` 命令使用无头 Chromium 上传文件，因此需要 Playwright 的浏览器。

```bash
npx playwright install chromium
```

### 全局安装（作为 `nblm-putter` 命令使用）

```bash
cd packages/cli
npm install -g .
```

安装后可以使用 `nblm-putter --help` 在任何位置运行。

> **注意**：请在构建后执行（需要 `dist/`）。
> 在 Windows 上，只要 npm 的全局 bin (`%APPDATA%\npm`) 在 PATH 中即可自动使用。

---

## 步骤 1：初始设置

```bash
nblm-putter config init
```

通过交互式界面进行以下设置：

| 设置项 | 说明 |
|---|---|
| AWS 区域 | 使用 Secrets Manager 时的区域（默认：`ap-northeast-1`） |
| AWS 配置文件 | `~/.aws/credentials` 中的配置文件名（默认：`default`） |
| 使用 Secrets Manager | 选择 `y` 启用。多台机器间共享配置时需要 |
| 使用代理 | 选择 `y` 启用。Playwright 的浏览器通信将通过代理 |
| 代理服务器 | 代理地址（例：`http://127.0.0.1:7890`） |
| 代理用户名 | 需要认证的代理时输入（无需认证则留空） |
| 代理密码 | 需要认证的代理时输入（无需认证则留空） |

配置文件保存在 `~/.nblm-putter/config.json`。

> **关于代理**
> 代理同时适用于 `auth` 命令（Chrome 启动）和 `sync` 命令（无头 Chromium）。使用无需认证的代理时，用户名和密码直接按 Enter 跳过即可。

> **不使用 Secrets Manager 的情况**
> 选择 `n` 将以本地模式运行。工具启动时会显示警告，但所有功能均可正常使用（仅禁用机器间的配置共享）。

---

## 步骤 2：Google 认证

```bash
nblm-putter auth
```

系统 Google Chrome 会打开浏览器，请使用已访问 NotebookLM 的 Google 账户登录。登录完成后，会话会自动保存。

- 会话保存在 `~/.nblm-putter/session.json`（或 Secrets Manager）
- 会话过期时，请再次执行 `nblm-putter auth`
- 执行 sync 时会自动更新会话，延长有效期

> **注意**：`auth` 命令使用系统的 Google Chrome。如果未安装 Chrome，将无法通过 Google 的机器人检测而无法登录。浏览 Web UI（`nblm-putter ui`）可以使用 Edge、Firefox 等任何浏览器。

---

## 步骤 2.5：Google Drive 关联（仅首次）

文件通过 Google Drive 批量注册到 NotebookLM。需要事先设置 Google Cloud 项目。

### Google Cloud 项目准备

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建项目
2. "API和服务" → "库" → 启用 **Google Drive API**
3. "凭据" → 创建 "OAuth 2.0 客户端 ID"
   - 应用类型：**桌面应用**
   - 重定向 URI：`http://localhost:3001/callback`
4. 获取 `client_id` 和 `client_secret`

### 设置与认证

```bash
nblm-putter config init   # 输入 client_id / client_secret
nblm-putter auth          # NotebookLM 登录后也会执行 Drive 认证
```

Drive 认证完成后会生成 `~/.nblm-putter/drive-token.json`。

---

## 步骤 3：同步文件（CLI）

```bash
nblm-putter notebooks list
```

显示 NotebookLM 中已创建的笔记本列表和 ID。

```
1: My Research Notes  (id: abc123)
2: Project Docs       (id: def456)
```

```bash
nblm-putter sync /path/to/folder --notebook <笔记本ID>
```

递归扫描指定文件夹下的文件，先上传到 Google Drive 的 `nblm-putter/{notebook-id}/` 文件夹，然后通过 NotebookLM 的 Drive 选择器仅添加新文件。终端会显示进度条和正在处理的文件名。

```bash
# 示例
nblm-putter sync ~/Documents/research --notebook abc123

# 强制覆盖同名文件并重新注册
nblm-putter sync ~/Documents/research --notebook abc123 --force-overwrite
```

### 跳过重复文件

默认情况下，如果 Google Drive 的同一文件夹中 **已存在同名文件，则跳过**（不上传，也不添加到 NotebookLM）。在终端中显示为 `SKIP`。

```
  SKIP  已注册的文件.pdf
  SKIP  另一个已存在的文件.docx
  → 新文件.pdf
```

如果新文件为 0 个，则跳过整个 Phase 2（添加到 NotebookLM），不启动浏览器。

指定 `--force-overwrite` 会覆盖上传现有文件，并重新添加到 NotebookLM。

### sync 的注意事项

- **Phase 1** 将本地文件上传到 Google Drive，**Phase 2** 使用 NotebookLM 的 Drive 选择器仅添加新文件。
- 如果 Drive 侧的认证令牌过期，请重新执行 `nblm-putter auth`。
- 如果 Drive 选择器的 UI 发生变化，选择器操作可能会失败。此时请查看 `/tmp/nblm-drive-picker-debug.png`。

---

## ignore 模式设置

可以使用 glob 模式指定要从注册中排除的文件。

```bash
# 添加模式
nblm-putter ignore add "*.log"
nblm-putter ignore add "node_modules/"
nblm-putter ignore add ".git/"
nblm-putter ignore add "*.tmp"

# 查看当前模式列表
nblm-putter ignore list

# 删除模式
nblm-putter ignore remove "*.tmp"
```

模式使用 [minimatch](https://github.com/isaacs/minimatch) 格式（兼容 gitignore）。设置将在下次 `sync` 执行时生效。

---

## 使用 Web UI

```bash
nblm-putter ui
```

浏览器会打开 `http://localhost:3000`。

| 页面 | 功能 |
|---|---|
| **Sync** | 选择笔记本并指定文件夹，实时显示进度执行同步 |
| **History** | 历史任务列表（日期时间、注册数量、错误数量） |
| **Ignore** | 添加/删除排除模式 |
| **Session** | 上传 `session.json` 更新会话 |

**Sync 页面功能：**
- 打开页面时自动加载现有笔记本，默认选中第一个笔记本
- **+ 新建** 按钮可创建新笔记本并自动选中
- **浏览...** 按钮可通过对话框选择文件夹（也可手动输入路径）
- 执行时实时显示每个文件的结果（✓ / ✗）和处理阶段（等待按钮/上传中）
- **中止** 按钮可停止正在执行的 sync（在当前文件处理完成后停止）
- 每个文件的处理时间（等待按钮时间、上传时间）也会记录在日志中

如需更改端口：

```bash
nblm-putter ui --port 8080
```

---

## 更新会话（从其他机器或 Web UI）

在其他机器上执行 `nblm-putter auth` 获取会话后，将生成的 `~/.nblm-putter/session.json` 通过 Web UI 的 **Session** 页面上传，即可更新会话。

如果启用了 Secrets Manager，执行 `nblm-putter auth` 的机器会自动同步到云端。

---

## 使用 Secrets Manager 实现多机器支持（可选）

启用 AWS Secrets Manager 后，以下内容将在机器间自动同步：

- NotebookLM 会话 (`nblm-putter/session`)
- ignore 模式 (`nblm-putter/settings`)

### 所需 IAM 权限

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

## 数据存储位置

| 数据 | 存储位置 |
|---|---|
| 配置文件 | `~/.nblm-putter/config.json` |
| 会话（本地） | `~/.nblm-putter/session.json` |
| 任务历史 | `~/.nblm-putter/db.sqlite` |
| ignore 模式（本地） | `~/.nblm-putter/db.sqlite`（settings 表） |
| Drive 认证令牌 | `~/.nblm-putter/drive-token.json` |
| 会话（云端） | AWS Secrets Manager: `nblm-putter/session` |
| ignore 模式（云端） | AWS Secrets Manager: `nblm-putter/settings` |

---

## 命令参考

```
nblm-putter config init              初次设置
nblm-putter auth                     Google 认证、保存会话（需要 Chrome）
nblm-putter notebooks list           显示笔记本列表
nblm-putter sync <folder>            将文件夹同步到笔记本
  --notebook <id>                      目标笔记本 ID（必填）
  --force-overwrite                    覆盖上传同名文件（默认跳过）
nblm-putter ignore list              显示排除模式列表
nblm-putter ignore add <pattern>     添加排除模式
nblm-putter ignore remove <pattern>  删除排除模式
nblm-putter ui                       启动 Web UI
  --port <port>                        端口号（默认：3000）
```

---

## 开发

```bash
# 安装依赖包
pnpm install

# 安装 Playwright 的 Chromium（仅首次）
npx playwright install chromium

# 构建（按 UI → CLI 顺序构建）
pnpm build

# UI 开发服务器（Vite，支持热重载）
pnpm dev:ui
```

---

## 免责声明

- 本工具为非官方第三方软件，与 Google LLC 及 Google NotebookLM 毫无关系。
- 本工具使用 Playwright 自动操作浏览器。由于 NotebookLM 的 UI 变更，可能会在不预先通知的情况下停止工作。
- 请遵守 Google 服务条款（[Google Terms of Service](https://policies.google.com/terms)）以及 NotebookLM 的服务条款使用本工具。请注意，自动化工具的使用可能会违反服务条款，请在理解此风险的基础上自行承担责任使用。
- 对于因使用本工具而产生的任何损害（数据丢失、账户停用及其他损害），作者概不负责。
- Google 账户的认证信息及会话信息仅保存在本地机器（或设置的 AWS Secrets Manager）。作者不会收集或发送这些信息。

## 许可证

[MIT License](./LICENSE) © 2026 Shinchi Takahiro