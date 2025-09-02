import fetch from 'node-fetch'

// Resolve API key from common env names
function getGeminiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    ''
  )
}

// Approximate tokenizer: assume ~4 chars per token. Conservative.
const INPUT_TOKEN_LIMIT = 50_000
const APPROX_CHARS_PER_TOKEN = 4

export async function generateContent(prompt, opts = {}) {
  const apiKey = getGeminiKey()
  if (!apiKey) {
    throw new Error('Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY in server/.env')
  }

  const model = opts.model || 'gemini-1.5-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  // Enforce input token limit (approximate) to 50k tokens
  const s = String(prompt || '')
  const maxChars = Math.max(0, Math.floor(INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN))
  if (s.length > maxChars) {
    throw new Error('Input too long, 50k tokens max')
  }
  const promptText = s

  const body = {
    contents: [
      {
        parts: [
          { text: promptText },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const json = await res.json()
      detail = json?.error?.message || JSON.stringify(json)
    } catch {
      try { detail = await res.text() } catch {}
    }
    throw new Error(`Gemini API error ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }

  const data = await res.json()
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  return out || ''
}

// Stream content via Google's streaming endpoint. Returns the fetch Response so callers can read response.body.
export async function streamGenerateContent(prompt, opts = {}) {
  const apiKey = getGeminiKey()
  if (!apiKey) {
    throw new Error('Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY in server/.env')
  }

  const model = opts.model || 'gemini-1.5-flash'
  // Request SSE explicitly for better compatibility
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  // Enforce input token limit (approximate) to 50k tokens
  const s = String(prompt || '')
  const maxChars = Math.max(0, Math.floor(INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN))
  if (s.length > maxChars) {
    throw new Error('Input too long, 50k tokens max')
  }
  const promptText = s

  const body = {
    contents: [
      {
        parts: [
          { text: promptText },
        ]
      },
    ],
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok || !res.body) {
    let detail = ''
    try {
      const json = await res.json()
      detail = json?.error?.message || JSON.stringify(json)
    } catch {
      try { detail = await res.text() } catch {}
    }
    throw new Error(`Gemini streaming error ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }

  return res
}
