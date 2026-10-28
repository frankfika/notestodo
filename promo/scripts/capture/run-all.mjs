/**
 * 一条命令重跑全部采集：静帧 → 录屏 → 干净版 → MANIFEST → 帧自检。
 *
 *   node promo/scripts/capture/run-all.mjs
 *
 * 前置：vite dev server 在跑（cd web && pnpm dev --port 5173 --strictPort）。
 * 本脚本会先探活，探不到就直接告诉你该敲什么，不会静默失败。
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const PY = process.env.PYTHON ?? '/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3'
const URL = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const only = process.argv.slice(2)

async function alive() {
  try {
    const { stdout } = await exec('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', URL])
    return stdout.trim() === '200'
  } catch { return false }
}

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${c}`))))
  })
}

const node = process.execPath

if (!(await alive())) {
  console.error(`\n✗ dev server 不可达：${URL}`)
  console.error('  请先起： cd web && pnpm dev --port 5173 --strictPort\n')
  process.exit(1)
}

const pass = only.length ? only : null
console.log(`\n── 1/5 静帧${pass ? ' (' + pass.join(' ') + ')' : ''} ──`)
await run(node, [path.join(HERE, 'capture-stills.mjs'), ...(pass ?? [])])

if (!pass || pass.some((n) => ['live-meeting'].includes(n))) {
  console.log('\n── 2/5 静帧 · 干净版（隐藏浏览器能力提示条）──')
  await run(node, [path.join(HERE, 'capture-stills.mjs'), 'live-meeting'],
    { HIDE_CAPTURE_BANNER: '1', CAPTURE_SUFFIX: '-clean' })
}

console.log('\n── 3/5 录屏 ──')
await run(node, [path.join(HERE, 'capture-clips.mjs'), ...(pass ?? [])])

console.log('\n── 4/5 录屏 · 干净版（record-start / live-caption）──')
await run(node, [path.join(HERE, 'capture-clips.mjs'), 'record-start', 'live-caption'],
  { HIDE_CAPTURE_BANNER: '1', CAPTURE_SUFFIX: '-clean' })

console.log('\n── 5/5 MANIFEST（ffprobe 实测）+ 帧自检 ──')
await run(node, [path.join(HERE, 'build-manifest.mjs')])
await run(PY, [path.join(HERE, 'verify-frames.py')])

console.log('\n✓ 全部完成：promo/capture/{stills,clips,seed,MANIFEST.json}')
