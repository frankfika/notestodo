import { test, expect } from '@playwright/test'
import { CATALOG, sourcesFor } from '../src/lib/builtinModels'

const gemma = CATALOG.find((m) => m.id === 'gemma-4-e4b')!
const whisper = CATALOG.find((m) => m.id === 'whisper-large-v3-turbo')!
const keys = (xs: { key: string }[]) => xs.map((x) => x.key)

test('下载源：国内自动优先 OpenCSG / hf-mirror，海外优先 Hugging Face', () => {
  expect(keys(sourcesFor(gemma, 'auto', true))).toEqual(['opencsg', 'hf-mirror', 'huggingface'])
  expect(keys(sourcesFor(gemma, 'auto', false))).toEqual(['huggingface', 'hf-mirror', 'opencsg'])
})

test('下载源：没有 OpenCSG 镜像的模型（whisper）只走 HF 族；指定源排第一、其余兜底', () => {
  expect(keys(sourcesFor(whisper, 'auto', true))).toEqual(['hf-mirror', 'huggingface'])
  expect(keys(sourcesFor(gemma, 'hf-mirror', false))).toEqual(['hf-mirror', 'opencsg', 'huggingface'])
  expect(sourcesFor(gemma, 'opencsg', true)[0].url).toBe(
    'https://hub.opencsg.com/api/v1/models/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf?ref=main')
  // 同族（字节一致）才允许续传
  expect(sourcesFor(gemma, 'auto', true).map((s) => s.family)).toEqual(['opencsg', 'hf', 'hf'])
})
