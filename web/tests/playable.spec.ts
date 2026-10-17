import { test, expect } from '@playwright/test'
import { encodeWav } from '../src/audio/playable'

test('encodeWav：标准 PCM16 单声道 WAV 头 + 数据长度正确 + 削波', async () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 2, -2]) // 2 / -2 应被削到 ±1
  const blob = encodeWav(pcm, 24000)
  expect(blob.type).toBe('audio/wav')
  const v = new DataView(await blob.arrayBuffer())
  const tag = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(o + i)))
  expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
  expect(v.getUint16(22, true)).toBe(1) // 单声道
  expect(v.getUint32(24, true)).toBe(24000)
  expect(v.getUint16(34, true)).toBe(16)
  expect(v.getUint32(40, true)).toBe(pcm.length * 2)
  expect(blob.size).toBe(44 + pcm.length * 2)
  expect([v.getInt16(46, true), v.getInt16(50, true), v.getInt16(52, true)]).toEqual([16383, 32767, -32767])
})
