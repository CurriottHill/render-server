import React, { useCallback, useState, useEffect, useRef } from 'react'
import { Prompt, SearchPrompt, DeeperPrompt } from '../prompt/prompt.jsx'
import { getPageContext, getSelectionContextText } from '../utils/context.js'
import { callGeminiAPI, callGeminiStream, getGeminiLimitStatus } from '../api/geminiClient.js'
import { createSelectionOverlay } from '../overlay/selectionOverlay.js'
import { createSelectionLock } from '../overlay/selectionLock.js'
import useTTS from '../hooks/useTTS'
import { preloadAudio } from '../scripts/tts'
import ResponseSection from './ResponseSection.jsx'

// Context helpers moved to ../utils/context.js
// ! Use an absolute extension URL so the image resolves correctly in content scripts (prevents ReferenceError)
const LogoUrl = chrome.runtime.getURL('assets/logo.png')

// Build the full prompt as a single string using only heading, url, and context
// ! Build the base prompt from selection + page context. User question is appended where needed.
function buildPrompt({selection, heading = '', url = '', context = '' }) {
  return (
    Prompt(selection, url, heading, context)
  )
}

// Helper: slice ~300 chars of paragraph around the selection text
function sliceAroundSelection(paragraph = '', selection = '', radius = 50) {
  try {
    const p = String(paragraph || '')
    const sel = String(selection || '').trim()
    if (!p) return ''
    if (!sel) {
      // No selection; just clamp to 300 chars
      return p.length > radius * 2 ? p.slice(0, radius * 2) + '…' : p
    }
    // Find selection index (case-insensitive to be robust)
    const idx = p.toLowerCase().indexOf(sel.toLowerCase())
    if (idx < 0) {
      return p.length > radius * 2 ? p.slice(0, radius * 2) + '…' : p
    }
    const start = Math.max(0, idx - radius)
    const end = Math.min(p.length, idx + sel.length + radius)
    let slice = p.slice(start, end)
    if (start > 0) slice = '…' + slice
    if (end < p.length) slice = slice + '…'
    return slice
  } catch {
    return String(paragraph || '')
  }
}

export default function ContentPopup() {
  const [selectedText, setSelectedText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // TTS managed by hook
  const [response, setResponse] = useState('')
  // Conversation history: [{ role: 'user' | 'assistant', content: string }]
  const [history, setHistory] = useState([])
  // Collected context snapshots per user action
  const [contexts, setContexts] = useState([])
  const [placeholder, setPlaceholder] = useState('Ask a question')
  const [deeperPlaceholder, setDeeperPlaceholder] = useState('go deeper')
  const [debug, setDebug] = useState({ payload: '', prompt: '', body: '' })
  // 0 = not reached, 1 = reached (server-side Gemini limiter)
  const [limitReached, setLimitReached] = useState(0)
  // Tracks whether we've already shown the limit-reached assistant bubble for the current limited window
  const [limitShown, setLimitShown] = useState(false)
  // Top search bar UI snapshot. We read the actual value via ref when submitting.
  const [questionInput, setQuestionInput] = useState('')
  // "Go deeper" search bar UI snapshot, updated when the deeper bar submits.
  const [deeperInput, setDeeperInput] = useState('')
  const [originalSelection, setOriginalSelection] = useState('')
  // Client-side rate limit: 5 requests / 60s
  const requestTimesRef = useRef([])
  const RATE_LIMIT = 5
  const RATE_WINDOW_MS = 60_000
  // Guard to avoid duplicate limit message appends in the same limited window
  const limitActionLockRef = useRef(false)
  // Interval handle for the seconds countdown while limited
  const limitTimerRef = useRef(null)

  // Saved selection range to support overlay/tts text resolution
  // Ref to the TOP search input element. Used to pull the current value and
  // to preserve selection before the browser collapses it on focus/click.
  const searchInputRef = useRef(null)
  const selectionRangeRef = useRef(null)
  // Live refs for latest history/contexts to avoid stale closures in callbacks
  const historyRef = useRef(history)
  const contextsRef = useRef(contexts)
  // Keep a live ref of response for history capture on stream completion
  const responseRef = useRef('')
  // Guard to ensure assistant is only appended once per request
  const appendedOnceRef = useRef(false)
  const OVERLAY_ID = 'content-popup-selection-overlay'
  // Track whether response section is open for overlay locking logic (moved up so utilities can access)
  const responseOpenRef = useRef(false)

  // Overlay and lock utility singletons
  const overlayApiRef = useRef(null)
  const lockApiRef = useRef(null)

  const getOverlayApi = useCallback(() => {
    if (!overlayApiRef.current) overlayApiRef.current = createSelectionOverlay(OVERLAY_ID, responseOpenRef)
    return overlayApiRef.current
  }, [])

  const clearSelectionOverlay = useCallback(() => {
    try { getOverlayApi().clear() } catch {}
  }, [getOverlayApi])

  // Utilities to lock user selection on the page while response is open
  const isEventInsidePopup = (e) => {
    try {
      const host = document.getElementById('popup-host')
      if (!host) return false
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : []
      return path && path.includes(host)
    } catch {
      return false
    }
  }

  const getLockApi = useCallback(() => {
    if (!lockApiRef.current) lockApiRef.current = createSelectionLock(isEventInsidePopup, OVERLAY_ID)
    return lockApiRef.current
  }, [])

  const addSelectionLock = () => { try { getLockApi().add() } catch {} }
  const removeSelectionLock = () => { try { getLockApi().remove() } catch {} }

  const renderSelectionOverlay = useCallback((range) => {
    try { getOverlayApi().renderFromRange(range) } catch {}
  }, [getOverlayApi])

  const rerenderOverlayFromSavedRange = useCallback(() => {
    const r = selectionRangeRef.current
    if (r) renderSelectionOverlay(r)
  }, [renderSelectionOverlay])

  const captureSelectionRange = useCallback(() => {
    try {
      const sel = window.getSelection && window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).cloneRange()
        // Only capture if selection has meaningful, non-empty text.
        const t = (typeof r.toString === 'function' ? r.toString() : '') || ''
        const trimmed = t.trim()
        if (!trimmed) {
          // Do not overwrite existing saved range/overlay when current selection is empty
          return
        }
        selectionRangeRef.current = r
        renderSelectionOverlay(r)
        // Store plain text of the original selection
        setOriginalSelection(trimmed)
      }
    } catch {
      selectionRangeRef.current = null
    }
  }, [renderSelectionOverlay])

  const restoreSelectionRange = useCallback(() => {
    try {
      if (!selectionRangeRef.current) return
      const sel = window.getSelection && window.getSelection()
      if (!sel) return
      sel.removeAllRanges()
      sel.addRange(selectionRangeRef.current)
    } catch {
      // ignore
    }
  }, [])

  const resetState = useCallback(() => {
    // Core UI states
    setSelectedText('')
    setResponse('')
    setError('')
    setLoading(false)
    // Conversation and context snapshots
    setHistory([])
    setContexts([])
    // Inputs and placeholders
    setQuestionInput('')
    setDeeperInput('')
    // Page selection snapshot
    setOriginalSelection('')
    // Debug payloads
    setDebug({ payload: '', prompt: '', body: '' })
    // Reset limiter indicator
    setLimitReached(0)
    setLimitShown(false)
    // Clear refs used during requests
    try { responseRef.current = '' } catch {}
    try { appendedOnceRef.current = false } catch {}
    // Clear top search input element if present
    try { if (searchInputRef.current) searchInputRef.current.value = '' } catch {}
  }, [])

  // Sync response into ref so onDone can capture final text reliably
  useEffect(() => {
    responseRef.current = response
  }, [response])

  // Keep refs in sync with latest state
  useEffect(() => { historyRef.current = history }, [history])
  useEffect(() => { contextsRef.current = contexts }, [contexts])

  // (removed) Debug logging of history/contexts to reduce noise

  // TTS hook wiring
  const {
    speaking,
    speakingSource,
    audioLoadingSelection,
    audioLoadingResponse,
    handleSelectionAudio,
    handleResponseAudio,
    stopAll,
  } = useTTS({
    onError: (msg) => setError(msg),
    resolveSelectionText: () => {
      try {
        const r = selectionRangeRef.current
        const rText = r && typeof r.toString === 'function' ? r.toString().trim() : ''
        if (rText) return rText
        return originalSelection || ''
      } catch {
        return originalSelection || ''
      }
    },
  })

  useEffect(() => {
    // Reset on initial mount
    resetState()
    // Listen for popup visibility events dispatched on window by content.js
    const onOpen = () => {
      resetState()
      // Clear the top search input when popup opens
      setQuestionInput('')
      if (searchInputRef.current) searchInputRef.current.value = ''
      // Preconnect to local server to warm CORS/TCP/TLS
      try { fetch('http://localhost:3000/ping', { method: 'GET', mode: 'cors', keepalive: true }).catch(() => {}) } catch {}
      // Fetch current server-side Gemini limit status
      ;(async () => {
        try {
          const status = await getGeminiLimitStatus()
          setLimitReached(status.limit ? (Number(status.secondsRemaining || 0) || 1) : 0)
        } catch {}
      })()
      // Warm upstream OpenAI TTS path (best-effort, fire-and-forget)
      try { fetch('http://localhost:3000/tts/warm', { method: 'POST', mode: 'cors', keepalive: true }).catch(() => {}) } catch {}
    }
    const onClose = () => {
      // Clear any artificial selection and stored selection when popup closes
      clearSelectionOverlay()
      selectionRangeRef.current = null
      // Reset all component state
      resetState()
    }
    window.addEventListener('popup:open', onOpen)
    window.addEventListener('popup:close', onClose)
    // Keep overlay aligned with selected text while page scrolls/resizes
    let rafId = 0
    const onScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        rerenderOverlayFromSavedRange()
      })
    }
    const onResize = onScroll
    // use capture to listen to scrolls on any ancestor/scrollable container
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    // One-time user-gesture hook to unlock audio pipeline ASAP
    const unlockOnce = () => {
      try { preloadAudio() } catch {}
      window.removeEventListener('pointerdown', unlockOnce, true)
    }
    window.addEventListener('pointerdown', unlockOnce, true)
    return () => {
      window.removeEventListener('popup:open', onOpen)
      window.removeEventListener('popup:close', onClose)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointerdown', unlockOnce, true)
      clearSelectionOverlay()
    }
  }, [resetState, clearSelectionOverlay, rerenderOverlayFromSavedRange])

  // When server limit flips back to 0, allow showing the message again on next limit
  useEffect(() => {
    if (limitReached === 0 && limitShown) {
      setLimitShown(false)
    }
    if (limitReached === 0) {
      limitActionLockRef.current = false
    }
  }, [limitReached, limitShown])

  // Start/stop a 1s countdown when limited, updating limitReached down to 0
  useEffect(() => {
    // Clear any existing timer
    if (limitTimerRef.current) {
      clearInterval(limitTimerRef.current)
      limitTimerRef.current = null
    }
    if (typeof limitReached === 'number' && limitReached > 0) {
      limitTimerRef.current = setInterval(() => {
        setLimitReached((prev) => {
          const curr = typeof prev === 'number' ? prev : 0
          const next = curr - 1
          return next > 0 ? next : 0
        })
      }, 1000)
    }
    return () => {
      if (limitTimerRef.current) {
        clearInterval(limitTimerRef.current)
        limitTimerRef.current = null
      }
    }
  }, [limitReached])

  // Show the server limit reached message once as an assistant bubble
  const showLimitReachedOnce = useCallback(async () => {
    if (limitActionLockRef.current) return
    limitActionLockRef.current = true
    try {
      const status = await getGeminiLimitStatus()
      const secs = Number(status.secondsRemaining || Math.ceil((Number(status.windowMs || 60000)) / 1000))
      const msg = `Too many requests, please try again in ${secs || 60} seconds.`
      setResponse(msg)
      // Do not append a new assistant bubble for the limit message; transient only
      setLimitReached(secs || 60)
      setLimitShown(true)
    } catch {
      const msg = 'Too many requests, please try again in 60 seconds.'
      setResponse(msg)
      setLimitShown(true)
    }
  }, [])

  // Animate the search placeholder: "Ask a question", "Ask a question.", "Ask a question..", "Ask a question..."
  useEffect(() => {
    const frames = ['Ask a question', 'Ask a question.', 'Ask a question..', 'Ask a question...']
    let i = 0
    const id = setInterval(() => {
      i = (i + 1) % frames.length
      setPlaceholder(frames[i])
    }, 500)
    return () => clearInterval(id)
  }, [])

  // Animate the deeper search placeholder: "go deeper", "go deeper.", "go deeper..", "go deeper..."
  useEffect(() => {
    const frames = ['go deeper', 'go deeper.', 'go deeper..', 'go deeper...']
    let i = 0
    const id = setInterval(() => {
      i = (i + 1) % frames.length
      setDeeperPlaceholder(frames[i])
    }, 500)
    return () => clearInterval(id)
  }, [])

  const callGemini = useCallback(async (prompt) => {
    const bodyPreview = { prompt, model: 'gemini-1.5-flash' }
    setDebug((prev) => ({ ...prev, prompt, body: JSON.stringify(bodyPreview, null, 2) }))

    setLoading(true)
    setError('')
    setResponse('')
    appendedOnceRef.current = false

    try {
      const userMsg = { role: 'user', content: prompt}
      // Record user message in history outside; no persistent log buffer needed
      // Prefer streaming for typewriter UX; falls back to full response if stream fails
      await callGeminiStream(prompt, {
        model: 'gemini-1.5-flash',
        onToken: (t) => {
          // Append token to response and normalize: convert ".  " to two line breaks
          setResponse((prev) => {
            const next = (prev ? prev + t : t)
            return next.replace(/\.\s{2,}/g, '.\n\n')
          })
        },
        onDone: async () => {
          setLoading(false)
          // Capture final assistant message into history if non-empty
          const finalText = (responseRef.current || '').trim()
          if (finalText && !appendedOnceRef.current) {
            appendedOnceRef.current = true
            setHistory((prev) => [...prev, { role: 'assistant', content: finalText }])
          }
          // Refresh server limit status after a completed request
          try {
            const status = await getGeminiLimitStatus()
            setLimitReached(status.limit ? (Number(status.secondsRemaining || 0) || 1) : 0)
          } catch {}
        },
        onError: async (err) => {
          // Detect server rate limit (429) and render as assistant bubble instead of top-level error
          const is429 = /\b429\b|Too\s*Many\s*Requests/i.test(String(err?.message || ''))
          if (is429) {
            // Fetch seconds remaining for message and state
            let seconds = 0
            try { const s = await getGeminiLimitStatus(); seconds = Number(s?.secondsRemaining || 0) } catch {}
            const msg = `Too many requests, please try again in ${seconds || 60} seconds.`
            setResponse(msg)
            if (!appendedOnceRef.current) {
              appendedOnceRef.current = true
              // Do not append limit error to history; show as transient response only
            }
            setLimitReached(seconds || 60)
            setLoading(false)
            return
          }
          // If streaming fails for other reasons, fall back to non-streaming once
          try {
            const out = await callGeminiAPI(prompt, { model: 'gemini-1.5-flash' })
            // Normalize fallback response the same way (two line breaks)
            const normalized = (out || '(No response)').replace(/\.\s{2,}/g, '.\n\n')
            setResponse(normalized)
            // Also append to history immediately since we have final text
            const finalText = (normalized || '').trim()
            if (finalText && !appendedOnceRef.current) {
              appendedOnceRef.current = true
              setHistory((prev) => [...prev, { role: 'assistant', content: finalText }])
            }
            // Refresh server limit status after non-streaming fallback
            try {
              const status = await getGeminiLimitStatus()
              setLimitReached(status.limit ? (Number(status.secondsRemaining || 0) || 1) : 0)
            } catch {}
          } catch (e2) {
            const is429b = /\b429\b|Too\s*Many\s*Requests/i.test(String(e2?.message || ''))
            if (is429b) {
              let seconds = 0
              try { const s = await getGeminiLimitStatus(); seconds = Number(s?.secondsRemaining || 0) } catch {}
              const msg = `Too many requests, please try again in ${seconds || 60} seconds.`
              setResponse(msg)
              if (!appendedOnceRef.current) {
                appendedOnceRef.current = true
                // Do not append limit error to history; show as transient response only
              }
              setLimitReached(seconds || 60)
            } else {
              const msg = err?.message || e2?.message || 'Failed to call Gemini service'
              setError(msg)
            }
          } finally {
            setLoading(false)
          }
        },
      })
    } catch (e) {
      // As a safety, also map 429 here if it bubbles up
      const is429 = /\b429\b|Too\s*Many\s*Requests/i.test(String(e?.message || ''))
      if (is429) {
        let seconds = 0
        try { const s = await getGeminiLimitStatus(); seconds = Number(s?.secondsRemaining || 0) } catch {}
        const msg = `Too many requests, please try again in ${seconds || 60} seconds.`
        setResponse(msg)
        if (!appendedOnceRef.current) {
          appendedOnceRef.current = true
          // Do not append limit error to history; show as transient response only
        }
        setLimitReached(seconds || 60)
      } else {
        const msg = e?.message || 'Failed to call Gemini service'
        setError(msg)
      }
      setLoading(false)
    }
  }, [])

  const handleExplainClick = useCallback(() => {
    try {
      const sel = window.getSelection && window.getSelection()
      const text = sel ? sel.toString().trim() : ''
      // Proceed for any non-empty selection
      if (!text) {
        setSelectedText('')
        setError('Please select some text to explain.')
        setResponse('')
        return
      }
      // Rate limit gate
      const now = Date.now()
      const times = requestTimesRef.current || []
      // drop entries outside window
      const cutoff = now - RATE_WINDOW_MS
      const recent = times.filter((t) => t > cutoff)
      if (recent.length >= RATE_LIMIT) {
        const oldest = Math.min(...recent)
        const remainingSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000))
        setError('')
        setResponse(`Rate limit reached. Try again in ${remainingSec}s`)
        return
      }
      // record this request
      recent.push(now)
      requestTimesRef.current = recent
      setSelectedText(text)
      const fullContext = getSelectionContextText()
      const { url, heading } = getPageContext()
      const context = sliceAroundSelection(fullContext, text)
      const prompt = buildPrompt({ selection: text, context, heading, url })
      // Record USER message as the full constructed prompt (from prompt.jsx)
      setHistory((prev) => [...prev, { role: 'user', content: prompt }])
      // Store context snapshot
      setContexts((prev) => [
        { selection: text, paragraph: context, heading, url }
      ])
      // store assembled prompt as payload preview
      setDebug((prev) => ({ ...prev, payload: prompt }))
      // Trigger Gemini call with the final prompt only
      void callGemini(prompt, { mode: 'explain', selection: text, question: '', url, heading, context })
    } catch (e) {
      setError('Failed to read selection')
    }
  }, [callGemini])

  // Top search: read from ref, update state/history, build prompt, call Gemini
  const handleTopSearchSubmit = useCallback(() => {
    const val = searchInputRef.current ? String(searchInputRef.current.value || '').trim() : ''
    if (!val) return
    // Rate limit gate
    const now = Date.now()
    const times = requestTimesRef.current || []
    const cutoff = now - RATE_WINDOW_MS
    const recent = times.filter((t) => t > cutoff)
    if (recent.length >= RATE_LIMIT) {
      const oldest = Math.min(...recent)
      const remainingSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000))
      setError('')
      setResponse(`Rate limit reached. Try again in ${remainingSec}s`)
      return
    }
    recent.push(now)
    requestTimesRef.current = recent

    setQuestionInput(val)
    const fullContext = getSelectionContextText()
    const { url, heading } = getPageContext()
    // Use SearchPrompt with question
    const context = sliceAroundSelection(fullContext, originalSelection)
    const prompt = SearchPrompt(originalSelection, val, url, heading, context)
    // Record USER message as the full constructed SearchPrompt
    setHistory((prev) => [...prev, { role: 'user', content: prompt }])
    // Store context snapshot
    setContexts((prev) => [
      { selection: originalSelection, paragraph: context, heading, url }
    ])
    void callGemini(prompt)
  }, [callGemini, originalSelection])

  //!  Deeper search: gets query via callback from ResponseSection
  const handleDeeperSubmit = useCallback((query) => {
    const val = String(query || '').trim()
    if (!val) return
    // Rate limit gate
    const now = Date.now()
    const times = requestTimesRef.current || []
    const cutoff = now - RATE_WINDOW_MS
    const recent = times.filter((t) => t > cutoff)
    if (recent.length >= RATE_LIMIT) {
      const oldest = Math.min(...recent)
      const remainingSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000))
      setError('')
      setResponse(`Rate limit reached. Try again in ${remainingSec}s`)
      return
    }
    recent.push(now)
    requestTimesRef.current = recent
    setDeeperInput(val)
    // Record raw follow-up as user message
    setHistory((prev) => [...prev, { role: 'user', content: val }])
    // Build deeper prompt using latest history/contexts via refs
    const prompt = DeeperPrompt(historyRef.current, val, contextsRef.current)
    void callGemini(prompt)
  }, [callGemini])

  // Top search submit is handled by handleTopSearchSubmit

  // No-op: audio is handled by useTTS

  // Response overflow handling moved into ResponseSection

  // Pin the popup open while the response section is visible
  useEffect(() => {
    const pinned = !!(response || error || loading)
    try {
      window.dispatchEvent(new CustomEvent('popup:pin', { detail: { pinned } }))
    } catch {}
  }, [response, error, loading])

  useEffect(() => { responseOpenRef.current = !!(response || error || loading) }, [response, error, loading])

  // While response is open, lock page selection and ensure overlay blocks interactions
  useEffect(() => {
    const open = !!(response || error || loading)
    if (open) {
      addSelectionLock()
      // Ensure we have a saved selection range; if not, capture from the live selection
      try {
        if (!selectionRangeRef.current) captureSelectionRange()
      } catch {}
      // Re-render overlay with locked class to cover selection
      rerenderOverlayFromSavedRange()
    } else {
      removeSelectionLock()
    }
    return () => {
      // Safety on unmount
      removeSelectionLock()
    }
  }, [response, error, loading, rerenderOverlayFromSavedRange, captureSelectionRange])

  // Close popup on Escape only when response section is NOT open; do not alter selection
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        const responseOpen = !!(response || error || loading)
        if (!responseOpen) {
          e.preventDefault()
          e.stopPropagation()
          try { window.dispatchEvent(new CustomEvent('popup:forceClose')) } catch {}
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [response, error, loading])

  return (
    <div className='popup-container'>
      <div className="content-popup-body">
        {/* Logo */}
        <div className='logo-container'>
          <img src={LogoUrl} alt="Logo" className='logo'/>
        </div>

        {/* Explain button */}
        <button type="button" className="btn explain" onClick={handleExplainClick} disabled={loading}>
          Explain
        </button>

        {/* Search input (TOP BAR)
            - Uncontrolled input accessed via searchInputRef.
            - onMouseDown captures page selection before focus collapses it.
            - Enter key and clicking the magnifier submit via handleSearchSubmit().
          */}
        <div className="search-wrap">
          <input
            type="search"
            className="search"
            placeholder={placeholder}
            aria-label="search"
            ref={searchInputRef}
            onMouseDown={(e) => {
              // Capture selection before the browser collapses it on focus, but
              // allow default so the caret moves to the clicked position.
              captureSelectionRange()
              // Ensure mouse interaction on the input doesn't bubble to the page
              e.stopPropagation()
            }}
            onKeyDown={(e) => {
              // Prevent site-level shortcuts (e.g., Space toggling media)
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                handleTopSearchSubmit()
              }
            }}
            onKeyUp={(e) => {
              // Stop bubbling so sites don't react to keyup
              e.stopPropagation()
            }}
            onKeyPress={(e) => {
              // Stop legacy keypress bubbling
              e.stopPropagation()
            }}
          />
          <svg
            className="search-icon"
            clipRule="evenodd"
            fillRule="evenodd"
            strokeLinejoin="round"
            strokeMiterlimit="2"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            role="button"
            tabIndex={0}
            aria-label="submit question"
            onMouseDown={(e) => {
              // Preserve selection when clicking the icon too
              captureSelectionRange()
              e.preventDefault()
              // Do not let this click/press bubble to the page
              e.stopPropagation()
              if (searchInputRef.current) searchInputRef.current.focus({ preventScroll: true })
            }}
            onClick={(e) => { e.stopPropagation(); handleTopSearchSubmit() }}
            onKeyDown={(e) => {
              // Prevent site-level shortcuts when icon is focused
              e.stopPropagation()
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleTopSearchSubmit()
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onKeyPress={(e) => e.stopPropagation()}
          >
            <path d="m15.97 17.031c-1.479 1.238-3.384 1.985-5.461 1.985-4.697 0-8.509-3.812-8.509-8.508s3.812-8.508 8.509-8.508c4.695 0 8.508 3.812 8.508 8.508 0 2.078-.747 3.984-1.985 5.461l4.749 4.75c.146.146.219.338.219.531 0 .587-.537.75-.75.75-.192 0-.384-.073-.531-.22zm-5.461-13.53c-3.868 0-7.007 3.14-7.007 7.007s3.139 7.007 7.007 7.007c3.866 0 7.007-3.14 7.007-7.007s-3.141-7.007-7.007-7.007z" fillRule="nonzero"/>
          </svg>
        </div>

        {/* Audio button */}
        <button type="button"
  className={`btn audio${audioLoadingSelection ? ' is-loading' : ''}`}
  aria-label="audio"
  onMouseDown={(e) => e.preventDefault()}
  onClick={() => handleSelectionAudio(selectedText)}
  title={speaking && speakingSource === 'selection' ? 'Stop' : 'Read selection aloud'}>
          <span className="icon-wrap" aria-hidden="true">
            {audioLoadingSelection ? (
              <span className="spinner spinner-black" />
            ) : speaking && speakingSource === 'selection' ? (
              // Pause icon (two vertical bars)
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="Pause">
                <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
              </svg>
            ) : (
              // Play/speaker icon
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="Play">
                <path d="M15 23l-9.309-6h-5.691v-10h5.691l9.309-6v22zm-9-15.009v8.018l8 5.157v-18.332l-8 5.157zm14.228-4.219c2.327 1.989 3.772 4.942 3.772 8.229 0 3.288-1.445 6.241-3.77 8.229l-.708-.708c2.136-1.791 3.478-4.501 3.478-7.522s-1.342-5.731-3.478-7.522l.706-.706zm-2.929 2.929c1.521 1.257 2.476 3.167 2.476 5.299 0 2.132-.955 4.042-2.476 5.299l-.706-.706c1.331-1.063 2.182-2.729 2.182-4.591 0-1.863-.851-3.529-2.184-4.593l.708-.708z"/>
              </svg>
            )}
          </span>
        </button>

        {/* Menu button */}
        <button type="button" className="btn menu" aria-label="menu">
          <svg clip-rule="evenodd" fill-rule="evenodd" stroke-linejoin="round" stroke-miterlimit="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m13 16.745c0-.414-.336-.75-.75-.75h-9.5c-.414 0-.75.336-.75.75s.336.75.75.75h9.5c.414 0 .75-.336.75-.75zm9-5c0-.414-.336-.75-.75-.75h-18.5c-.414 0-.75.336-.75.75s.336.75.75.75h18.5c.414 0 .75-.336.75-.75zm-4-5c0-.414-.336-.75-.75-.75h-14.5c-.414 0-.75.336-.75.75s.336.75.75.75h14.5c.414 0 .75-.336.75-.75z" fill-rule="nonzero"/></svg>
        </button>
      </div>
      {(response || error || loading) && (
        <ResponseSection
          response={response}
          error={error}
          loading={loading}
          deeperPlaceholder={deeperPlaceholder}
          // Deeper search (SECOND BAR): ResponseSection calls this when Enter is pressed.
          onDeeperSubmit={handleDeeperSubmit}
          audioLoadingResponse={audioLoadingResponse}
          speaking={speaking}
          speakingSource={speakingSource}
          onReadResponse={() => handleResponseAudio(response)}
          history={history}
          limitReached={limitReached}
          limitShown={limitShown}
          onLimitAction={showLimitReachedOnce}
          onClose={() => {
            try { stopAll() } catch {}
            // Clear any selected text in state
            setSelectedText('')
            resetState()
            // Immediately clear artificial selection overlay and saved range
            try { clearSelectionOverlay() } catch {}
            selectionRangeRef.current = null
            setOriginalSelection('')
            // Also clear the browser's native selection so triggers tied to selection will close
            try {
              const sel = window.getSelection && window.getSelection()
              if (sel && typeof sel.removeAllRanges === 'function') sel.removeAllRanges()
            } catch {}
            // Defocus any focused input inside the popup
            try { if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur() } catch {}
            try { window.dispatchEvent(new CustomEvent('popup:forceClose')) } catch {}
          }}
        />
      )}
    </div>
  )
}
