import { Loader2, Mic, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/** v4.4 语音输入：麦克风采集（getUserMedia + AudioContext）→ 16kHz 单声道 PCM →
 *  本地 whisper 转写（window.easybow.asrTranscribe，离线免费、不上传）。
 *  交互：点一次开始录音（红色停止钮 + 计时），再点停止即转写并把文本交还 onText
 *  （由调用方插入光标处）；最长 90 秒自动停止。 */
const MAX_SEC = 90

interface RecState {
  ctx: AudioContext
  stream: MediaStream
  proc: ScriptProcessorNode
  chunks: Float32Array[]
}

/** 拼接采集块并线性重采样（采集率→目标率） */
function concatResample(chunks: Float32Array[], fromRate: number, toRate: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  if (!total) return new Float32Array(0)
  const src = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    src.set(c, o)
    o += c.length
  }
  if (Math.abs(fromRate - toRate) < 1) return src
  const outLen = Math.floor((total * toRate) / fromRate)
  const out = new Float32Array(outLen)
  const step = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(total - 1, i0 + 1)
    const f = pos - i0
    out[i] = src[i0] * (1 - f) + src[i1] * f
  }
  return out
}

export function VoiceInput(props: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'rec' | 'work'>('idle')
  const [err, setErr] = useState('')
  const [sec, setSec] = useState(0)
  const recRef = useRef<RecState | null>(null)
  const timerRef = useRef<number | null>(null)
  const stopRef = useRef<() => Promise<void>>(async () => {})

  const stopTracks = () => {
    const r = recRef.current
    recRef.current = null
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    try {
      r?.proc.disconnect()
    } catch {}
    try {
      r?.stream.getTracks().forEach((t) => t.stop())
    } catch {}
    try {
      void r?.ctx.close()
    } catch {}
  }

  // 卸载兜底：组件消失时释放麦克风
  useEffect(() => () => stopTracks(), [])

  const start = async () => {
    if (recRef.current || state === 'work') return
    setErr('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      await ctx.resume()
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      proc.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      // ScriptProcessor 必须接入输出图才会持续触发；增益 0 防麦克风回放
      const gain = ctx.createGain()
      gain.gain.value = 0
      src.connect(proc)
      proc.connect(gain)
      gain.connect(ctx.destination)
      recRef.current = { ctx, stream, proc, chunks }
      setState('rec')
      const t0 = Date.now()
      setSec(0)
      timerRef.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000)
        setSec(s)
        if (s >= MAX_SEC) void stopRef.current()
      }, 1000)
    } catch (e: any) {
      setErr(`麦克风不可用：${String(e?.message || e).slice(0, 24)}`)
      stopTracks()
      setState('idle')
    }
  }

  const stop = async () => {
    const r = recRef.current
    if (!r) return
    const rate = r.ctx.sampleRate
    const chunks = r.chunks
    stopTracks()
    setState('work')
    try {
      const pcm = concatResample(chunks, rate, 16000)
      if (pcm.length < 1600) throw new Error('录音太短，没录到声音')
      const res = await window.easybow.asrTranscribe(pcm, 16000)
      if (!res.ok || !res.text?.trim()) throw new Error(res.error || '转写结果为空')
      props.onText(res.text.trim())
      setState('idle')
    } catch (e: any) {
      setErr(String(e?.message || e).slice(0, 28))
      setState('idle')
    }
  }
  stopRef.current = stop

  return (
    <span className="voice-wrap">
      {state === 'rec' ? (
        <button
          className="btn mini voice-on"
          title="停止录音并转写（最长 90 秒自动停止）"
          onClick={() => void stop()}
          disabled={props.disabled}
        >
          <Square size={12} strokeWidth={2.5} /> 停止 {sec}s
        </button>
      ) : (
        <button
          className="btn mini"
          title="语音输入：说话转文字填入光标处（本地转写，不上传；最长 90 秒）"
          onClick={() => void start()}
          disabled={props.disabled || state === 'work'}
        >
          {state === 'work' ? (
            <>
              <Loader2 size={12} strokeWidth={2} className="voice-spin" /> 转写中…
            </>
          ) : (
            <>
              <Mic size={12} strokeWidth={2} /> 语音
            </>
          )}
        </button>
      )}
      {err && (
        <span className="voice-err" title={err}>
          {err}
        </span>
      )}
    </span>
  )
}
