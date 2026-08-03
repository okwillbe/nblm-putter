import { google } from 'googleapis'
import { createReadStream } from 'fs'
import { basename } from 'path'
import { readConfig } from '../config'
import { loadDriveToken, saveDriveToken, isTokenExpired, DriveToken } from './token'

/**
 * 设置代理环境变量，让 googleapis 底层的 HTTP 请求走代理
 * 注意：只在函数内部显式调用，避免模块导入时的全局副作用
 */
function setupProxyEnv(): void {
  const { proxy } = readConfig()
  if (!proxy?.server) return

  // 解析代理服务器地址
  let proxyUrl = proxy.server
  if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
    proxyUrl = `http://${proxyUrl}`
  }

  // 如果有认证信息，添加到 URL 中
  if (proxy.username && proxy.password) {
    const url = new URL(proxyUrl)
    url.username = proxy.username
    url.password = proxy.password
    proxyUrl = url.toString()
  }

  // 设置环境变量，googleapis (gaxios) 会自动使用
  process.env.HTTPS_PROXY = proxyUrl
  process.env.HTTP_PROXY = proxyUrl
}

function getOAuth2Client() {
  const { drive } = readConfig()
  if (!drive.clientId || !drive.clientSecret) {
    throw new Error('Drive credentials not configured. Run `nblm-putter config init`.')
  }
  const token = loadDriveToken()
  if (!token) {
    throw new Error('Drive token not found. Run `nblm-putter auth` first.')
  }
  const auth = new google.auth.OAuth2(
    drive.clientId,
    drive.clientSecret,
    'http://localhost:3001/callback'
  )
  auth.setCredentials(token)
  auth.on('tokens', (tokens) => {
    saveDriveToken({ ...token, ...tokens } as DriveToken)
  })
  return auth
}

async function refreshIfNeeded(): Promise<void> {
  const token = loadDriveToken()
  if (!token) throw new Error('Drive token not found. Run `nblm-putter auth` first.')
  if (isTokenExpired(token)) {
    const { drive } = readConfig()
    const auth = new google.auth.OAuth2(drive.clientId, drive.clientSecret, 'http://localhost:3001/callback')
    auth.setCredentials(token)
    const { credentials } = await auth.refreshAccessToken()
    saveDriveToken({ ...token, ...credentials } as DriveToken)
  }
}

export async function getOrCreateFolder(parentId: string | null, name: string): Promise<string> {
  setupProxyEnv() // 设置代理（如果有配置）
  await refreshIfNeeded()
  const driveApi = google.drive({ version: 'v3', auth: getOAuth2Client() })
  const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`
  const q = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and ${parentClause}`
  const list = await driveApi.files.list({ q, fields: 'files(id)', pageSize: 1 })
  if (list.data.files?.length) return list.data.files[0].id!

  const folder = await driveApi.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : ['root'],
    },
    fields: 'id',
  })
  return folder.data.id!
}

export type UploadResult = { fileId: string; status: 'uploaded' | 'skipped' }

export async function uploadFile(
  filePath: string,
  folderId: string,
  forceOverwrite = false,
): Promise<UploadResult> {
  setupProxyEnv() // 设置代理（如果有配置）
  await refreshIfNeeded()
  const driveApi = google.drive({ version: 'v3', auth: getOAuth2Client() })
  const name = basename(filePath)
  const existing = await driveApi.files.list({
    q: `name = '${name}' and '${folderId}' in parents and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  })
  if (existing.data.files?.length) {
    if (!forceOverwrite) {
      return { fileId: existing.data.files[0].id!, status: 'skipped' }
    }
    const fileId = existing.data.files[0].id!
    await driveApi.files.update({ fileId, media: { body: createReadStream(filePath) } })
    return { fileId, status: 'uploaded' }
  }
  const res = await driveApi.files.create({
    requestBody: { name, parents: [folderId] },
    media: { body: createReadStream(filePath) },
    fields: 'id',
  })
  return { fileId: res.data.id!, status: 'uploaded' }
}
