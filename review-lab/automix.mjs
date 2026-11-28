// SPDX-License-Identifier: GPL-3.0-or-later
// External contributor benchmark; no changes to the checkout.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Readable, PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep, setImmediate as turn } from 'node:timers/promises'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { cpus, platform, arch, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const [root, expected, output] = process.argv.slice(2)
const sha = execFileSync('git', ['-C',root,'rev-parse','HEAD'], {encoding:'utf8'}).trim()
if (sha !== expected) throw new Error('Unexpected checkout '+sha)
const load = (p) => import(pathToFileURL(resolve(root,p)).href)
const {AutoMixRegistry} = await load('src/playback/processing/AutoMixRegistry.ts')
const {TransitionProfileCache} = await load('src/playback/processing/MusicalAnalyzer.ts')
const {default: SourcesManager} = await load('src/managers/sourceManager.ts')
const {http1makeRequest} = await load('src/utils.ts')
const registry = AutoMixRegistry.getInstance()
const idle = async () => {
  const start = performance.now()
  while (registry.activeWorkers || registry.pendingResourceFetches || registry.queue?.length) {
    if (performance.now()-start > 10000) throw Error('Registry not idle')
    await sleep(2)
  }
}
const opts = (id,ms,fetchResource,extra={}) => ({
  track:{info:{sourceName:'lab',identifier:id,length:100000}},
  urlData:{}, windowStartMs:100000-ms,windowDurationMs:ms,
  remainingMs:0,priority:'IMMINENT_TRANSITION',triggerSource:'external-lab',
  fetchResource,...extra
})
const pcm = (ms,tail=0) => {
  const b=Buffer.alloc(ms*192)
  for(let i=0;i<(ms-tail)*48;i++){
    const envelope=0.4+0.6*Math.pow(Math.sin(Math.PI*i/24000),2)
    const sample=Math.round(10000*envelope*Math.sin(2*Math.PI*440*i/48000))
    b.writeInt16LE(sample,i*4);b.writeInt16LE(sample,i*4+2)
  }
  return b
}
const resource = stream => ({stream:{stream,destroy:()=>stream.destroy()}})
const chunks = b => (function*(){for(let i=0;i<b.length;i+=3840)yield b.subarray(i,i+3840)})()
const data=pcm(4000,1000)
const round = async (id,count) => {
  let fetches=0,callbacks=0,completed=0, peakRss=process.memoryUsage().rss
  const rssStart=peakRss
  const h=monitorEventLoopDelay({resolution:10});h.enable()
  const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss)},5)
  const cpu=process.cpuUsage(),start=performance.now()
  const durations=[]
  try {
    await Promise.all(Array.from({length:count},async (_,i)=>{
      const t=performance.now()
      const p=await registry.requestOutroAnalysis(opts(id+'-'+i,4000,async()=>{
        fetches++;return resource(Readable.from(chunks(data),{objectMode:false}))
      },{onComplete:()=>callbacks++}))
      if(p)completed++
      durations.push(performance.now()-t)
    }))
    await idle()
    peakRss=Math.max(peakRss,process.memoryUsage().rss)
    const c=process.cpuUsage(cpu);durations.sort((a,b)=>a-b)
    return {jobs:count,completed,fetches,callbacks,wallMs:performance.now()-start,cpuMs:(c.user+c.system)/1000,
      rssStartBytes:rssStart,rssPeakSampledBytes:peakRss,processMaxRssKiB:process.resourceUsage().maxRSS,
      eventLoopP95Ms:h.percentile(95)/1e6,eventLoopSamples:Number(h.count??0),
      jobP50Ms:durations[Math.ceil(count*.5)-1],jobP95Ms:durations[Math.ceil(count*.95)-1]}
  }finally{clearInterval(sampler);h.disable()}
}
const failedWindow=async()=>{
  const b=pcm(24500,800),stream=new PassThrough()
  let callbacks=0
  const p=registry.requestOutroAnalysis(opts('partial-error',25000,async()=>resource(stream),{onComplete:()=>callbacks++}))
  await turn()
  for(const chunk of chunks(b)) { if(!stream.write(chunk)) await once(stream,'drain') }
  stream.destroy(new Error('deliberate incomplete decoder failure'))
  const profile=await p;await idle()
  const key=profile?.trackId??JSON.stringify(['lab','partial-error',null,100000])
  return {profileCreated:!!profile,callbacks,cached:!!TransitionProfileCache.get(key),
    observedWindowEndMs:profile?.outroProfile?.analyzedWindowEndMs??null,
    naturalOutroPointMs:profile?.outroProfile?.naturalOutroPointMs??null}
}
const cancellation=async()=>{
  const controller=new AbortController()
  let requested,closed,closedAt=null,signalSeen=false,requests=0
  const ready=new Promise(r=>requested=r), done=new Promise(r=>closed=r)
  const server=createServer((_req,res)=>{
    requests++;res.once('close',()=>{closedAt=performance.now();closed()});requested()
    const timer=setTimeout(()=>res.end(Buffer.alloc(16)),750)
    res.once('close',()=>clearTimeout(timer))
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const url='http://127.0.0.1:'+server.address().port
  const manager=new SourcesManager({options:{}})
  manager.sourceMap.set('lab',{loadStream:async(_track,input,_protocol,extra)=>{
    signalSeen=!!extra?.signal
    const r=await http1makeRequest(input,{streamOnly:true,maxRetries:0})
    return {stream:r.stream,type:'pcm'}
  }})
  try{
    const p=registry.requestOutroAnalysis(opts('pending-http',1000,async(track,_data,_pos,_pcm,_background,signal)=>{
      const r=await manager.getTrackStream(track,url,undefined,{},signal)
      r.stream?.destroy()
      return {exception:{message:'lab completion'}}
    },{signal:controller.signal}))
    await Promise.race([ready,sleep(3000, null,{ref:false}).then(()=>{throw Error('no HTTP request')})])
    const start=performance.now();controller.abort()
    const result=await p;const consumerMs=performance.now()-start
    await idle();const idleMs=performance.now()-start
    await Promise.race([done,sleep(3000,null,{ref:false}).then(()=>{throw Error('socket remained open')})])
    return {signalSeen,requests,consumerMs,idleMs,socketCloseMs:closedAt-start,resultNull:result===null,
      activeWorkers:registry.activeWorkers,pendingResourceFetches:registry.pendingResourceFetches??null,serverFallbackMs:750}
  }finally{controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r))}
}
const warmup=await round('warmup',2)
const rounds=[]
for(let i=0;i<3;i++)rounds.push(await round('measured-'+i,8))
const report={sha,node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),fixture:'48kHz stereo s16le; 440Hz amplitude-modulated tone, 1s silent tail',warmup,rounds,failedWindow:await failedWindow(),cancellation:await cancellation(),scope:'AutoMixRegistry with local PCM streams and SourcesManager HTTP/1 loopback fixture; not Player/Discord or third-party provider'}
writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log('LAB_RESULT '+JSON.stringify(report))
