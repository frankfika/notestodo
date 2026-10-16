import { test, expect } from '@playwright/test'
import { dataFlow, isLoopbackUrl } from '../src/lib/dataFlow'
import { DEFAULT_SETTINGS, type AppSettings } from '../src/types'

const local: AppSettings = { ...DEFAULT_SETTINGS, ai_mode: 'local', asr_mode: 'local' }

test('isLoopbackUrl：只认回环地址', () => {
  for (const u of ['http://127.0.0.1:11434/v1', 'http://localhost:8080', 'http://[::1]:8080/v1', 'http://app.localhost'])
    expect(isLoopbackUrl(u), u).toBe(true)
  for (const u of ['http://192.168.1.5:11434/v1', 'https://api.minimax.io', 'http://127.0.0.1.evil.com', 'not a url', ''])
    expect(isLoopbackUrl(u), u).toBe(false)
})

test('dataFlow：全本地 → 全部在本机；字幕在本地转录模式下不出现', () => {
  const f = dataFlow(local, true)
  expect(f.every((x) => x.where === 'device')).toBe(true)
  expect(f.some((x) => x.what.includes('字幕'))).toBe(false)
})

test('dataFlow：「Local」填了局域网地址 / 转录走云端 / 开了浏览器字幕 → 如实标为离开本机', () => {
  const lan = dataFlow({ ...local, local_llm_base_url: 'http://192.168.1.5:11434/v1' }, false)
  expect(lan[1]).toMatchObject({ where: 'remote', to: '192.168.1.5:11434' })
  const cloudAsr = dataFlow({ ...local, asr_mode: 'cloud' }, true)
  expect(cloudAsr[0].where).toBe('remote')
  expect(cloudAsr.find((x) => x.what.includes('字幕'))?.where).toBe('remote')
})
