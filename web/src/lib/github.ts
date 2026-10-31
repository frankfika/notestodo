import type { AppSettings } from '../types'
import type { db } from '../db/db'
import { uid, now } from './id'

interface GithubIssue {
  number: number
  title: string
  html_url: string
  pull_request?: unknown
}

/** GitHub open issues → 任务（按 notes_md = issue URL 幂等去重）。 */
export async function importGithubIssues(
  settings: AppSettings,
  dbi: typeof db,
): Promise<{ imported: number; skipped: number }> {
  const repo = settings.github_repo.trim()
  if (!repo) throw new Error('请先填写仓库（owner/name）')
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (settings.github_token.trim()) headers.Authorization = `Bearer ${settings.github_token.trim()}`
  const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=50`, { headers })
  if (!res.ok) throw new Error(`GitHub API ${res.status}：${await res.text().then((t) => t.slice(0, 120))}`)
  const issues = (await res.json()) as GithubIssue[]

  const existing = new Set(
    (await dbi.todos.toArray()).map((t) => t.notes_md).filter(Boolean),
  )
  const ts = now()
  let imported = 0
  let skipped = 0
  for (const [i, issue] of issues.entries()) {
    if (issue.pull_request) continue // PR 不当任务
    if (existing.has(issue.html_url)) { skipped++; continue }
    await dbi.todos.add({
      id: uid(), kind: 'task', scope: null, parent_id: null,
      title: `#${issue.number} ${issue.title}`,
      status: 'open', source: 'manual',
      sort_order: Date.now() + i,
      notes_md: issue.html_url,
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
    imported++
  }
  return { imported, skipped }
}
