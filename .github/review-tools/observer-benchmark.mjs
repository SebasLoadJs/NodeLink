import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { once } from 'node:events'
import { AudioVisualization } from '../../src/playback/processing/AudioVisualization.ts'
import { MusicAnalysis } from '../../src/playback/processing/MusicAnalysis.ts'

const frame = Buffer.alloc(3840)
for (let i = 0; i < 960; i++) {
  const sample = Math.round(10000 * Math.sin(i * 2 * Math.PI * 440 / 48000))
  frame.writeInt16LE(sample, i * 4)
  frame.writeInt16LE(sample, i * 4 + 2)
}
for (const count of [1, 10, 25]) {
  for (const mode of ['visualization', 'analysis', 'combined']) {
    const delay = monitorEventLoopDelay({ resolution: 10 })
    const streams = Array.from({ length: count }, () => {
      const v = mode !== 'analysis' ? new AudioVisualization() : null
      const a = mode !== 'visualization' ? new MusicAnalysis() : null
      if (v && a) v.pipe(a)
      const input = v ?? a
      const output = a ?? v
      let bytes = 0
      output.on('data', chunk => { bytes += chunk.length })
      return { input, output, done: once(output, 'end'), bytes: () => bytes }
    })
    delay.enable()
    const before = process.memoryUsage()
    const cpu = process.cpuUsage()
    const start = performance.now()
    for (let i = 0; i < 800; i++) {
      for (const stream of streams) stream.input.write(frame)
      if (i % 10 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    for (const stream of streams) stream.input.end()
    await Promise.all(streams.map(stream => stream.done))
    const elapsed = performance.now() - start
    const used = process.cpuUsage(cpu)
    const after = process.memoryUsage()
    delay.disable()
    for (const stream of streams) {
      if (stream.bytes() !== 800 * frame.length) throw new Error('PCM byte loss')
    }
    console.log(JSON.stringify({ mode, streams: count, simulatedAudioSeconds: 16, elapsedMs: Math.round(elapsed), cpuMs: (used.user + used.system) / 1000, heapDeltaBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss, eventLoopP99Ms: delay.percentile(99) / 1e6 }))
  }
}
