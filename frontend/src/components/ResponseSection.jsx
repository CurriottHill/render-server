import React, { useEffect, useRef } from 'react'

export default function ResponseSection({
  response,
  error,
  loading,
  deeperPlaceholder,
  onClose,
  onReadResponse,
  audioLoadingResponse,
  speaking,
  speakingSource,
  onDeeperSubmit,
  history = [],
  limitReached = 0,
  limitShown = false,
  onLimitAction,
}) {
  const sectionRef = useRef(null)
  const resultRef = useRef(null)
  const prevRef = useRef({ historyLen: 0, hadResponseText: false })
  const deeperInputRef = useRef(null)
  const deeperWrapRef = useRef(null)
  const shakeTimeoutRef = useRef(null)
  // Local guard to avoid duplicate display before parent props update lands
  const hasShownLimitRef = useRef(false)

  // Trigger a brief shake on the deeper search input
  const shakeDeeperInput = () => {
    const el = deeperWrapRef.current
    if (!el) return
    try {
      el.classList.remove('shake')
      // Force reflow to restart animation if already applied
      // eslint-disable-next-line no-unused-expressions
      void el.offsetWidth
      el.classList.add('shake')
      if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current)
      shakeTimeoutRef.current = setTimeout(() => {
        try { el.classList.remove('shake') } catch {}
      }, 600)
    } catch {}
  }

  // Cleanup any pending timers on unmount
  useEffect(() => {
    return () => {
      if (shakeTimeoutRef.current) {
        clearTimeout(shakeTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    // Sync local guard with parent state
    if (!limitShown) {
      hasShownLimitRef.current = false
    } else {
      hasShownLimitRef.current = true
    }
  }, [limitShown])

  // Track overflow on the scrollable result to control bottom blur via CSS
  useEffect(() => {
    function checkOverflow() {
      const resEl = resultRef.current
      const secEl = sectionRef.current
      if (!resEl || !secEl) return
      const overflowing = resEl.scrollHeight - resEl.clientHeight > 1
      secEl.classList.toggle('is-overflowing', overflowing)
    }

    // Observe size changes of the result area
    let ro = null
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => checkOverflow())
      if (resultRef.current) ro.observe(resultRef.current)
    }
    // Also react to window resizes
    window.addEventListener('resize', checkOverflow, { passive: true })

    // Track scroll to know when at the bottom (hide blur)
    function handleScroll() {
      const resEl = resultRef.current
      const secEl = sectionRef.current
      if (!resEl || !secEl) return
      const atBottom = resEl.scrollTop + resEl.clientHeight >= resEl.scrollHeight - 1
      secEl.classList.toggle('at-bottom', atBottom)
    }
    if (resultRef.current) {
      resultRef.current.addEventListener('scroll', handleScroll, { passive: true })
    }
    // Re-check when content state flips
    checkOverflow()
    handleScroll()
    return () => {
      window.removeEventListener('resize', checkOverflow)
      if (ro && resultRef.current) ro.disconnect()
      if (resultRef.current) resultRef.current.removeEventListener('scroll', handleScroll)
    }
  }, [response, error, loading])

  // (Removed) auto-scroll-to-bottom to honor aligning new responses to top

  // Helper: scroll so the top of the latest assistant bubble is at the top
  const scrollLatestAssistantToTop = () => {
    const res = resultRef.current
    if (!res) return
    // Prefer the streaming bubble when loading & response text is present
    let target = null
    if (loading && !error && response) {
      const nodes = res.getElementsByClassName('bubble-assistant')
      if (nodes && nodes.length) target = nodes[nodes.length - 1]
    }
    // Otherwise, pick the last assistant bubble in history
    if (!target) {
      const nodes = res.getElementsByClassName('bubble-assistant')
      if (nodes && nodes.length) target = nodes[nodes.length - 1]
    }
    if (!target) return
    // Compute top relative to scroll container using bounding rects
    const resRect = res.getBoundingClientRect()
    const tRect = target.getBoundingClientRect()
    const deltaTop = tRect.top - resRect.top
    res.scrollTop += deltaTop
  }

  // When a new assistant message is appended to history, align it to the top
  useEffect(() => {
    const prev = prevRef.current
    const newLen = history.length
    if (newLen > prev.historyLen) {
      const last = history[newLen - 1]
      if (last && last.role === 'assistant') {
        // Wait for DOM to paint bubbles
        requestAnimationFrame(() => scrollLatestAssistantToTop())
      }
    }
    prevRef.current.historyLen = newLen
  }, [history])

  // When streaming starts producing text for a new response, align to the top once
  useEffect(() => {
    const prev = prevRef.current
    const hasText = !!response
    if (loading && !error && hasText && !prev.hadResponseText) {
      requestAnimationFrame(() => scrollLatestAssistantToTop())
    }
    prevRef.current.hadResponseText = hasText
  }, [loading, error, response])

  // Debug: log history whenever it changes
  useEffect(() => {
    try {
      // eslint-disable-next-line no-console
      console.log('[ResponseSection] history:', history)
    } catch {}
  }, [history])

  const visibleHistory = Array.isArray(history) && history.length > 0 ? history.slice(1) : []

  return (
    <div className="response-section" ref={sectionRef}>
      <h3 className="response-title">Response...</h3>
      <button
        type="button"
        className="response-close"
        aria-label="Close response"
        title="Close"
        onClick={onClose}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18.3 5.7a1 1 0 0 0-1.4-1.4L12 9.17 7.1 4.3A1 1 0 0 0 5.7 5.7L10.59 10.6 5.7 15.49a1 1 0 1 0 1.4 1.42L12 12.01l4.9 4.9a1 1 0 0 0 1.4-1.42L13.41 10.6 18.3 5.7Z" />
        </svg>
      </button>
      {(visibleHistory.length > 0 || error || loading || response) && (
        <div className="result" ref={resultRef}>
          {error && (
            <div className="error" role="alert" style={{ color: 'crimson', marginBottom: 8 }}>
              {error}
            </div>
          )}
          {/* Chat messages */}
          <div className="chat">
            {visibleHistory.map((m, idx) => {
              const isObj = m && typeof m === 'object'
              const role = isObj && typeof m.role === 'string' ? m.role : 'assistant'
              const isLimit = isObj && m.meta && m.meta.limit
              const seconds = Math.max(0, Number(limitReached || 0))
              const text = isLimit
                ? `Too many requests, please try again in ${seconds} seconds.`
                : (isObj ? m.content : String(m ?? ''))
              return (
                <div
                  key={idx}
                  className={`bubble ${role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}
                  role="text"
                >
                  {text}
                </div>
              )
            })}
            {/* Transient rate-limit bubble (not stored in history) */}
            {!loading && limitReached >= 1 && (
              <div className="bubble bubble-assistant" role="text">
                {`Too many requests, please try again in ${Math.max(0, Number(limitReached || 0))} seconds.`}
              </div>
            )}
            {/* Streaming assistant preview while loading */}
            {loading && !error && response && (
              <div className="bubble bubble-assistant" aria-live="polite">
                {response}
              </div>
            )}
            {/* Loader when no text yet */}
            {loading && !error && !response && (
              <div className="loader-dots" aria-live="polite" aria-label="Loading">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            )}
          </div>
        </div>
      )}
      {/* Deeper search row: search + audio button */}
      <div className="response-search-row">
        <div className="response-search-wrap" ref={deeperWrapRef}>
          <input
            type="search"
            className="search"
            placeholder={deeperPlaceholder}
            aria-label="go deeper"
            ref={deeperInputRef}
            onMouseDown={(e) => {
              // Keep mouse interactions inside the popup
              e.stopPropagation()
            }}
            onKeyDown={(e) => {
            // Prevent site-level shortcuts (e.g., Space toggling media)
            e.stopPropagation()
            // When server rate limit is reached, on first attempt show the assistant limit message, then block
            if (limitReached >= 1 && e.key === 'Enter') {
              e.preventDefault()
              if (!limitShown && !hasShownLimitRef.current) {
                // Show server-provided limit message once; do not clear input
                hasShownLimitRef.current = true
                onLimitAction && onLimitAction()
              }
              // Shake the deeper input to indicate action is blocked
              shakeDeeperInput()
              return
            }
            if (e.key === 'Enter') {
              const el = e.currentTarget
              const q = el.value.trim()
                if (q) {
                  onDeeperSubmit && onDeeperSubmit(q)
                  // Clear the text after search
                  el.value = ''
                }
            }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onKeyPress={(e) => e.stopPropagation()}
          />
          <svg
            className={`search-icon${limitReached >= 1 ? ' is-disabled' : ''}`}
            clipRule="evenodd"
            fillRule="evenodd"
            strokeLinejoin="round"
            strokeMiterlimit="2"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            role="button"
            tabIndex={0}
            aria-label="submit deeper search"
            aria-disabled={limitReached >= 1}
            onMouseDown={(e) => {
              // Keep interactions within popup and avoid focus shifts
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (limitReached >= 1) {
                // On first limited click, show assistant message; do not clear input
                if (!limitShown && !hasShownLimitRef.current) {
                  hasShownLimitRef.current = true
                  onLimitAction && onLimitAction()
                }
                // Shake the deeper input to indicate action is blocked
                shakeDeeperInput()
                return
              }
              const el = deeperInputRef.current
              const q = el && typeof el.value === 'string' ? el.value.trim() : ''
              if (q) {
                onDeeperSubmit && onDeeperSubmit(q)
                if (el) el.value = ''
              }
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (limitReached >= 1) {
                  if (!limitShown && !hasShownLimitRef.current) {
                    hasShownLimitRef.current = true
                    onLimitAction && onLimitAction()
                  }
                  // Shake the deeper input to indicate action is blocked
                  shakeDeeperInput()
                  return
                }
                const el = deeperInputRef.current
                const q = el && typeof el.value === 'string' ? el.value.trim() : ''
                if (q) {
                  onDeeperSubmit && onDeeperSubmit(q)
                  if (el) el.value = ''
                }
              }
            }}
          >
            <path d="m15.97 17.031c-1.479 1.238-3.384 1.985-5.461 1.985-4.697 0-8.509-3.812-8.509-8.508s3.812-8.508 8.509-8.508c4.695 0 8.508 3.812 8.508 8.508 0 2.078-.747 3.984-1.985 5.461l4.749 4.75c.146.146.219.338.219.531 0 .587-.537.75-.75.75-.192 0-.384-.073-.531-.22zm-5.461-13.53c-3.868 0-7.007 3.14-7.007 7.007s3.139 7.007 7.007 7.007c3.866 0 7.007-3.14 7.007-7.007s-3.141-7.007-7.007-7.007z" fillRule="nonzero"/>
          </svg>
        </div>
        <button type="button"
                className="response-audio"
                aria-label="audio"
                onClick={onReadResponse}
                title={speaking && speakingSource === 'response' ? 'Stop' : 'Read response aloud'}>
          {audioLoadingResponse ? (
            <span className="spinner spinner-purple" aria-hidden="true" />
          ) : speaking && speakingSource === 'response' ? (
            // Pause icon in purple (inherits currentColor)
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="Pause">
              <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="Play">
              <path d="M15 23l-9.309-6h-5.691v-10h5.691l9.309-6v22zm-9-15.009v8.018l8 5.157v-18.332l-8 5.157zm14.228-4.219c2.327 1.989 3.772 4.942 3.772 8.229 0 3.288-1.445 6.241-3.77 8.229l-.708-.708c2.136-1.791 3.478-4.501 3.478-7.522s-1.342-5.731-3.478-7.522l.706-.706zm-2.929 2.929c1.521 1.257 2.476 3.167 2.476 5.299 0 2.132-.955 4.042-2.476 5.299l-.706-.706c1.331-1.063 2.182-2.729 2.182-4.591 0-1.863-.851-3.529-2.184-4.593l.708-.708z"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
