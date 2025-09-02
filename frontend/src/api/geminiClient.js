// Client wrapper for calling the server Gemini endpoint

export async function callGeminiAPI(prompt, { model = 'gemini-1.5-flash', endpoint } = {}) {
  const base = (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || 'http://localhost:3000'
  const url = endpoint || `${base}/gemini`
  const body = { prompt, model }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch {}
    throw new Error(`Gemini request failed: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''}`)
  }
  const data = await res.json()
  return data?.text || ''
}

// Streaming client using fetch to POST to our SSE endpoint and parse events.
// Usage:
// await callGeminiStream(prompt, { onToken: (t) => append(t), onDone: () => {}, model })
export async function callGeminiStream(prompt, { onToken, onDone, onError, model = 'gemini-1.5-flash', endpoint } = {}) {
  const base = (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || 'http://localhost:3000'
  const url = endpoint || `${base}/gemini/stream`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model }),
  })
  if (!res.ok || !res.body) {
    const msg = `Gemini stream failed: ${res.status} ${res.statusText}`
    onError?.(new Error(msg))
    throw new Error(msg)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx
      // Process complete SSE events separated by double newlines
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        // Each event may contain multiple lines, parse data lines
        for (const line of rawEvent.split(/\n/)) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue // comment/heartbeat
          if (trimmed.toLowerCase().startsWith('event:')) {
            // we only care about 'done' and 'error' if they arrive
            // handled via data below
            continue
          }
          if (trimmed.toLowerCase().startsWith('data:')) {
            const payload = trimmed.slice(5).trim()
            if (payload === '"[DONE]"' || payload === '[DONE]') {
              onDone?.()
              break
            }
            try {
              const text = JSON.parse(payload)
              if (typeof text === 'string' && text) onToken?.(text)
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }
    // Flush any remaining buffered text (unlikely in SSE, but safe)
    if (buffer) {
      for (const line of buffer.split(/\n/)) {
        const trimmed = line.trim()
        if (trimmed.toLowerCase().startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          try {
            const text = JSON.parse(payload)
            if (typeof text === 'string' && text) onToken?.(text)
          } catch {}
        }
      }
    }
    onDone?.()
  } catch (err) {
    onError?.(err)
    throw err
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

// Query current Gemini rate limit status from the server.
// Returns an object: { limit: 0|1, remaining: number, windowMs: number }
export async function getGeminiLimitStatus() {
  const base = (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || 'http://localhost:3000'
  const url = `${base}/gemini/limit`
  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const data = await res.json()
    return {
      limit: data?.limit ? 1 : 0,
      remaining: Number(data?.remaining ?? 0),
      windowMs: Number(data?.windowMs ?? 60000),
      secondsRemaining: Number(data?.secondsRemaining ?? 0),
    }
  } catch {
    // On failure, assume not limited to avoid blocking UX
    return { limit: 0, remaining: 0, windowMs: 60000, secondsRemaining: 0 }
  }
}
