import { Command } from 'commander'
import { resolve, basename } from 'path'
import { launchHeadlessBrowser, createHeadlessContext } from '../playwright/browser'
import { openNotebookPage, listSources } from '../playwright/notebooklm'
import { addSourcesFromDrive } from '../playwright/drive-picker'
import { filterNewSources } from '../sync/dedup'
import { loadIgnorePatterns } from '../storage/index'
import { filterFiles } from '../ignore/filter'
import { createJob, updateJob } from '../db/jobs'
import { walkDir } from '../utils/files'
import { getOrCreateFolder, uploadFile } from '../drive/client'

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync <folder>')
    .description('Sync files from a folder to NotebookLM via Google Drive')
    .requiredOption('--notebook <id>', 'Target notebook ID (from `notebooks list`)')
    .option('--force-overwrite', 'Overwrite existing files in Drive instead of skipping them')
    .action(async (folder: string, opts: { notebook: string; forceOverwrite?: boolean }) => {
      const absFolder = resolve(folder)
      const ignorePatterns = await loadIgnorePatterns()
      const files = filterFiles(walkDir(absFolder), absFolder, ignorePatterns)

      if (files.length === 0) {
        console.log('No files to sync.')
        return
      }

      const total = files.length
      process.stdout.write(`\n${c.bold}Phase 1${c.reset}  Uploading ${c.cyan}${total}${c.reset} file(s) to Google Drive...\n\n`)

      const jobId = createJob({ notebookId: opts.notebook, totalFiles: total })
      updateJob(jobId, { status: 'running' })

      let rootFolderId: string
      let notebookFolderId: string
      try {
        rootFolderId = await getOrCreateFolder(null, 'nblm-putter')
        notebookFolderId = await getOrCreateFolder(rootFolderId, opts.notebook)
      } catch (err) {
        process.stdout.write(`  ${c.red}✗${c.reset}  Drive folder setup failed: ${err instanceof Error ? err.message : err}\n`)
        process.exit(1)
      }

      const errors: Array<{ file: string; reason: string }> = []
      const newlyUploaded: string[] = []
      let done = 0
      let skipped = 0

      for (const file of files) {
        const name = basename(file)
        done++
        const counter = `${c.dim}[${done}/${total}]${c.reset}`
        try {
          const result = await uploadFile(file, notebookFolderId, opts.forceOverwrite)
          if (result.status === 'skipped') {
            skipped++
            process.stdout.write(`  ${c.yellow}SKIP${c.reset}  ${pad(name, 50)} ${counter}\n`)
          } else {
            newlyUploaded.push(name)
            process.stdout.write(`  ${c.green}  → ${c.reset} ${pad(name, 50)} ${counter}\n`)
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          errors.push({ file, reason })
          process.stdout.write(`  ${c.red}  ✗ ${c.reset} ${pad(name, 50)} ${counter}  ${c.dim}${reason}${c.reset}\n`)
        }
        updateJob(jobId, { doneFiles: done, errors })
      }

      process.stdout.write('\n')

      if (errors.length > 0) {
        process.stdout.write(`  ${c.yellow}⚠${c.reset}  ${errors.length} file(s) failed to upload.\n`)
      }

      if (newlyUploaded.length === 0) {
        updateJob(jobId, { status: 'done' })
        process.stdout.write(
          `${c.green}✓ Done.${c.reset}  ` +
          `全ファイルが既に Drive に存在するためスキップしました。` +
          `${c.dim}  skipped: ${skipped}  Job ID: ${jobId}${c.reset}\n\n`
        )
        return
      }

      process.stdout.write(
        `\n${c.bold}Phase 2${c.reset}  Checking existing sources & adding new source(s) to NotebookLM...\n\n`
      )

      let addedCount = 0
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
          await browser.close().catch(() => {})
          updateJob(jobId, { status: 'failed' })
          process.exit(1)
        }

        process.stdout.write(`  ${c.dim}Found ${existingSources.length} existing source(s) in NotebookLM.${c.reset}\n`)

        const sourcesToAdd = filterNewSources(newlyUploaded, existingSources)
        addedCount = sourcesToAdd.length
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
        `${addedCount} file(s) uploaded and added to NotebookLM.` +
        `${c.dim}  skipped: ${skipped}  Job ID: ${jobId}${c.reset}\n\n`
      )
    })
}
