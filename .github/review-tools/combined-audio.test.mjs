import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable, Writable, PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { AudioVisualization } from '../../src/playback/processing/AudioVisualization.ts'
import { MusicAnalysis } from '../../src/playback/processing/MusicAnalysis.ts'
import { ProtectedPcmInput, ProtectedLimiterOutput } from '../../src/playback/processing/ProtectedAudioTransforms.ts'
import { config } from '../../config.default.ts'

function* frames() {
  for (let k = 0; k < 200; k++) {
    const pcm = Buffer.alloc(3840)
    for (let i = 0; i < 960; i++) {
      const phase = (k * 960 + i) * 2 * Math.PI * 440 / 48000
      const sample = Math.round(30000 * Math.sin(phase))
      pcm.writeInt16LE(sample, i * 4)
      pcm.writeInt16LE(-sample, i * 4 + 2)
    }
    yield pcm
  }
}
async function render(protectedMode, observe) {
  const hash = createHash('sha256')
  let bytes = 0
  let samplePeak = 0
  const stages = []
  const v = observe ? new AudioVisualization() : null
  const a = observe ? new MusicAnalysis() : null
  if (protectedMode) stages.push(new ProtectedPcmInput(), new ProtectedLimiterOutput(() => 1))
  if (v && a) stages.push(v, a)
  const sink = new Writable({
    highWaterMark: 3840,
    write(chunk, _encoding, callback) {
      bytes += chunk.length
      hash.update(chunk)
      for (let i = 0; i < chunk.length; i += 2) {
        samplePeak = Math.max(samplePeak, Math.abs(chunk.readInt16LE(i)))
      }
      yieldTurn().then(() => callback(), callback)
    }
  })
  await pipeline(Readable.from(frames()), ...stages, sink)
  return { bytes, hash: hash.digest('hex'), samplePeak, v: v?.snapshot(), a: a?.snapshot() }
}
test('existing playback defaults stay legacy with both observers disabled', () => {
  assert.equal(config.playback.audio.processingMode, 'legacy')
  assert.equal(config.playback.audio.visualization, false)
  assert.equal(config.playback.audio.musicAnalysis, false)
  assert.equal(config.playback.audio.protected.telemetry, false)
})
for (const protectedMode of [false, true]) {
  test('observers preserve every PCM byte under backpressure; protected=' + protectedMode, async () => {
    const baseline = await render(protectedMode, false)
    const observed = await render(protectedMode, true)
    assert.equal(baseline.bytes, 200 * 3840)
    assert.equal(observed.bytes, baseline.bytes)
    assert.equal(observed.hash, baseline.hash)
    assert.equal(observed.samplePeak, baseline.samplePeak)
    assert.ok(observed.v)
    assert.ok(observed.a)
    assert.equal(observed.v.outputFrame, 192000)
    assert.equal(observed.a.outputWindowEndMs, 4000)
    assert.equal(observed.a.scope, 'processed-output')
    if (protectedMode) assert.ok(observed.samplePeak < 30000)
  })
}
