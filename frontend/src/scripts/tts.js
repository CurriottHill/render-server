let currentAudio = null
let currentUrl = null
let endResolver = null
let currentMediaSource = null
let currentSourceBuffer = null
let audioUnlocked = false

// A very short silent mp3 (duration ~0.05s). Used to unlock audio on user gesture.
const SILENT_MP3 =
  'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/**
 * Preload/unlock the audio pipeline. Should be called in response to a user gesture.
 * Idempotent: safe to call multiple times.
 */
export function preloadAudio() {
  if (audioUnlocked) return
  try {
    const el = new Audio()
    // iOS/Safari often requires a real play() to unlock. Use a short silent data URI.
    el.src = SILENT_MP3
    el.volume = 0.0001
    const p = el.play()
    if (p && typeof p.then === 'function') {
      p.then(() => {
        try { el.pause() } catch {}
        audioUnlocked = true
      }).catch(() => {
        // Even if play fails, we've at least constructed Audio which helps on some browsers
        audioUnlocked = true
      })
    } else {
      // Fallback: mark unlocked after constructing
      audioUnlocked = true
    }
  } catch {
    audioUnlocked = true
  }
}

function cleanup(resolve) {
  try {
    if (currentAudio) {
      currentAudio.onended = null
      currentAudio.onerror = null
      currentAudio.pause()
      currentAudio.currentTime = 0
      try {
        currentAudio.src = ''
        currentAudio.load()
      } catch {}
    }
  } finally {
    if (currentUrl) URL.revokeObjectURL(currentUrl)
    try { if (currentMediaSource) currentMediaSource.endOfStream?.() } catch {}
    currentAudio = null
    currentUrl = null
    currentMediaSource = null
    currentSourceBuffer = null
    if (resolve) resolve()
    endResolver = null
  }
}

export function stopSpeech() {
  if (endResolver) {
    const resolve = endResolver
    cleanup(resolve)
  } else {
    cleanup()
  }
}

async function speakTextStream(text, opts = {}) {
  // Feature detection for MediaSource
  if (typeof window === 'undefined' || !('MediaSource' in window)) return null

  // Decide on a supported mime/format pair
  const candidates = [
    { mime: 'audio/mpeg', format: 'mp3' },
    { mime: 'audio/webm; codecs=opus', format: 'opus' },
  ]
  let selected = null
  for (const c of candidates) {
    try { if (window.MediaSource.isTypeSupported(c.mime)) { selected = c; break } } catch {}
  }
  if (!selected) return null

  // Notify start
  try { opts.onLoadingStart && opts.onLoadingStart() } catch {}

  stopSpeech()

  currentMediaSource = new MediaSource()
  currentUrl = URL.createObjectURL(currentMediaSource)
  currentAudio = new Audio(currentUrl)
  if (typeof opts.playbackRate === 'number' && opts.playbackRate > 0) {
    currentAudio.playbackRate = opts.playbackRate
  }

  const endpoint = opts.endpointStream || 'http://localhost:3000/tts/stream'
  const voice = opts.voice || 'alloy'
  const model = opts.model || 'gpt-4o-mini-tts'

  // Apply timeout to avoid hangs
  const ac = new AbortController()
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000
  const tId = setTimeout(() => ac.abort('stream-timeout'), timeoutMs)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, format: selected.format, model }),
    signal: ac.signal,
  })
  clearTimeout(tId)
  if (!res.ok || !res.body) {
    // Allow caller to fallback to non-streaming
    return null
  }

  return new Promise((resolve, reject) => {
    endResolver = resolve

    const abort = (err) => {
      const e = err instanceof Error ? err : new Error('Streaming TTS error')
      cleanup()
      reject(e)
    }

    currentAudio.onended = () => cleanup(resolve)
    currentAudio.onerror = () => abort(new Error('Audio playback error'))

    currentMediaSource.addEventListener('sourceopen', () => {
      try {
        currentSourceBuffer = currentMediaSource.addSourceBuffer(selected.mime)
      } catch (e) {
        abort(e)
        return
      }

      const reader = res.body.getReader()
      let queue = []
      let appending = false
      let ended = false

      const pump = async () => {
        try {
          const { value, done } = await reader.read()
          if (done) {
            ended = true
            // If not currently updating and no queued data, end stream
            if (!currentSourceBuffer.updating && queue.length === 0) {
              try { currentMediaSource.endOfStream() } catch {}
            }
            return
          }
          if (value && value.byteLength) queue.push(value.buffer)
          if (!appending) appendNext()
          pump()
        } catch (e) {
          abort(e)
        }
      }

      const appendNext = () => {
        if (!currentSourceBuffer || currentSourceBuffer.updating) return
        const next = queue.shift()
        if (next) {
          appending = true
          try {
            currentSourceBuffer.appendBuffer(next)
          } catch (e) {
            abort(e)
            return
          }
        } else if (ended && !currentSourceBuffer.updating) {
          try { currentMediaSource.endOfStream() } catch {}
        }
      }

      currentSourceBuffer.addEventListener('updateend', () => {
        appending = false
        appendNext()
      })

      // Start reading and appending
      pump()

      // Once some data is buffered, start playback (on first updateend)
      const startOnReady = () => {
        currentSourceBuffer.removeEventListener('updateend', startOnReady)
        try { opts.onReady && opts.onReady() } catch {}
        currentAudio.play().catch(abort)
      }
      currentSourceBuffer.addEventListener('updateend', startOnReady)
    }, { once: true })
  })
}

export default async function speakText(text, opts = {}) {
  // Stop any existing playback before starting a new one
  stopSpeech()

  // notify caller that we are starting network fetch
  try { opts.onLoadingStart && opts.onLoadingStart() } catch {}

  // Try streaming first unless explicitly disabled
  if (opts.stream !== false) {
    try {
      const streamed = await speakTextStream(text, opts)
      if (streamed) return streamed
    } catch {
      // swallow and fallback
    }
  }

  const endpoint = opts.endpoint || 'http://localhost:3000/tts'
  const voice = opts.voice || 'alloy'
  const format = opts.format || 'mp3'
  const model = opts.model || 'gpt-4o-mini-tts'

  // Apply timeout to avoid hangs
  const ac = new AbortController()
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000
  const tId = setTimeout(() => ac.abort('tts-timeout'), timeoutMs)
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Known-good defaults
    body: JSON.stringify({ text, voice, format, model }),
    signal: ac.signal,
  });
  clearTimeout(tId)

  if (!res.ok) {
    let detail = ''
    try {
      const json = await res.json()
      detail = json?.error || JSON.stringify(json)
    } catch {
      try { detail = await res.text() } catch {}
    }
    throw new Error(`TTS request failed${detail ? `: ${detail}` : ''}`)
  }

  const blob = await res.blob();
  currentUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentUrl);
  
  if (typeof opts.playbackRate === 'number' && opts.playbackRate > 0) {
    currentAudio.playbackRate = opts.playbackRate;
  }
  // mp3 is ready; allow UI to clear loading state
  try { opts.onReady && opts.onReady() } catch {}

  return new Promise(async (resolve, reject) => {
    endResolver = resolve
    currentAudio.onended = () => cleanup(resolve)
    currentAudio.onerror = (e) => {
      const err = new Error('Audio playback error')
      cleanup()
      reject(err)
    }
    try {
      await currentAudio.play()
    } catch (err) {
      cleanup()
      reject(err)
    }
  })
}