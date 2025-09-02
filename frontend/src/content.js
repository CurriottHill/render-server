// ! Inject a popup that appears only when text is selected and sits just below the selection.
// ! It is clamped to remain within the visible viewport so it never goes off-screen.
import React from 'react'
import { createRoot } from 'react-dom/client'
import ContentPopup from './components/ContentPopup.jsx'
// Load CSS as text and inject into Shadow DOM for isolation
import popupCss from './styles/popup.scss?inline'
(() => {
  // ! Toggle to enable/disable debug logs quickly
  const DEBUG = true
  const dlog = (...args) => { try { if (DEBUG) console.debug('[Popup]', ...args) } catch {} }
  const id = 'popup' // ! Fixed id so we can find/reuse the same DOM node
  const MARGIN = 8 // ! Base padding (px) around selection and viewport edges
  let insidePopup = false // Track when pointer is inside the popup to avoid hiding on internal clicks
  let lastVisible = false // Track last visibility to fire open/close events only when state changes
  let rafId = 0 // rAF scheduler id to debounce frequent updates
  let isMouseDown = false // Track mouse button state to only show after release
  let pinned = false // ! Pin when response is open so popup persists without live selection
  let forceClosed = false // ! After explicit close, stay hidden until selection actually changes
  let lastSelectionText = '' // Track current selection string to detect changes

  // ! Shadow DOM host and root (created once)
  let shadowHost = null
  let shadowRoot = /** @type {ShadowRoot|null} */ (null)

  function ensureShadow() {
    // ! Create a Shadow DOM host at top-level and keep it attached across SPA rerenders
    if (shadowHost && shadowRoot) return { shadowHost, shadowRoot }
    shadowHost = document.getElementById(`${id}-host`)
    if (!shadowHost) {
      shadowHost = document.createElement('div')
      shadowHost.id = `${id}-host`
      shadowHost.style.cssText = 'all: initial; contain: content;'
      ;(document.body || document.documentElement).appendChild(shadowHost)
    }
    // Ensure the host remains attached across SPA rerenders
    try {
      if (!shadowHost.__observer) {
        const obs = new MutationObserver(() => {
          try {
            if (!document.contains(shadowHost)) {
              ;(document.body || document.documentElement).appendChild(shadowHost)
            }
          } catch {}
        })
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true })
        shadowHost.__observer = obs
      }
    } catch {}
    // Create or get shadow root and ensure styles are present
    shadowRoot = shadowHost.shadowRoot || shadowHost.attachShadow({ mode: 'open' })
    try {
      if ('adoptedStyleSheets' in shadowRoot && 'CSSStyleSheet' in window) {
        // ! Use constructable stylesheets when available (CSP-friendly, isolated)
        const hasSheet = shadowRoot.adoptedStyleSheets?.some(s => s.__popupStyles)
        if (!hasSheet) {
          const sheet = new CSSStyleSheet()
          sheet.replaceSync(popupCss || '')
          // tag for detection on subsequent runs
          sheet.__popupStyles = true
          shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]
          dlog('Injected styles via adoptedStyleSheets')
        }
      } else {
        // Fallback: inline <style>
        if (!shadowRoot.getElementById('popup-styles')) {
          const style = document.createElement('style')
          style.id = 'popup-styles'
          style.textContent = popupCss || ''
          shadowRoot.appendChild(style)
          dlog('Injected styles via <style> tag fallback')
        }
      }
    } catch (e) {
      // Last-resort fallback in case of errors
      if (!shadowRoot.getElementById('popup-styles')) {
        const style = document.createElement('style')
        style.id = 'popup-styles'
        style.textContent = popupCss || ''
        shadowRoot.appendChild(style)
        dlog('Injected styles via last-resort fallback')
      }
    }
    return { shadowHost, shadowRoot }
  }

  // ! Allow React app to pin/unpin the popup while response is open
  window.addEventListener('popup:pin', (e) => {
    // ! React app pins/unpins the popup while response is open
    try {
      // support both CustomEvent with detail and plain Event fallback
      const detail = /** @type {CustomEvent} */(e).detail
      pinned = !!(detail && detail.pinned)
    } catch { pinned = false }
    dlog('pin state changed ->', pinned)
    scheduleUpdate()
  })

  // ! Allow forcing the popup to close immediately (e.g., when X is pressed)
  window.addEventListener('popup:forceClose', () => {
    // ! Immediate close (e.g., Escape/X). Prevent re-open until selection actually changes
    pinned = false
    forceClosed = true
    insidePopup = false
    lastVisible = false
    const { shadowRoot } = ensureShadow()
    const el = shadowRoot.getElementById(id)
    if (el) el.style.display = 'none'
    dlog('forceClose dispatched; hiding popup')
    scheduleUpdate()
  })

  function getOrCreateBox() {
    // ! Render the popup into a shadow root for style isolation
    const { shadowRoot } = ensureShadow()
    let el = shadowRoot.getElementById(id)
    if (!el) {
      el = document.createElement('div')
      el.id = id
      el.className = 'content-popup'
      el.style.cssText = [
        'position:fixed',
        'background:transparent',
        'color:#111',
        'font-size:14px',
        'z-index:2147483647',
        'display:none',
        'max-width: calc(100vw - 16px)'
      ].join(';')
      shadowRoot.appendChild(el)

      // ! Mount React component once inside the popup node
      try {
        const root = createRoot(el)
        root.render(React.createElement(ContentPopup))
        ;(el).__reactRoot = root
      } catch {}

      // ! Keep popup open while interacting with it
      el.addEventListener('pointerenter', () => { insidePopup = true })
      el.addEventListener('pointerleave', () => { insidePopup = false })
      // ! Prevent clicks inside from bubbling to page listeners that might change selection
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.addEventListener(type, (e) => e.stopPropagation())
      }

      // ! Reposition when popup content size changes (e.g., response section appears)
      try {
        const ro = new ResizeObserver(() => {
          scheduleUpdate()
        })
        ro.observe(el)
        ;(el).__resizeObserver = ro
      } catch {}
    }
    return el
  }

  function hasSelection() {
    const sel = window.getSelection() // ! Browser selection API
    if (!sel) return false
    // Prefer actual text when available
    try {
      const t = sel.toString()
      if (t && t.trim().length > 0) return true
    } catch {}
    // Fallback: non-collapsed range indicates selection
    try { if (!sel.isCollapsed && sel.rangeCount > 0) return true } catch {}
    // As a proxy, consider overlay highlights as evidence of a saved selection
    try {
      const overlay = document.getElementById('content-popup-selection-overlay')
      if (overlay && overlay.querySelector('.hl')) return true
    } catch {}
    return false
  }

  function getSelectionRect() {
    // ! Prefer the bottom-most line rect so the popup appears below multi-line selections
    const sel = window.getSelection() // ! Read current selection
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0) // ! Consider the first range in the selection
      // ! Prefer the last client rect (i.e., bottom-most line) so the popup goes under the selection
      const rects = range.getClientRects()
      let rect = range.getBoundingClientRect() // ! Fallback: entire selection bounds
      if (rects && rects.length) {
        let bottomMost = rects[0]
        for (const r of rects) {
          if (r.bottom > bottomMost.bottom) bottomMost = r
        }
        rect = bottomMost
      }
      // ! Ignore empty rects (e.g., caret-only or hidden selections)
      if (!rect || (rect.width === 0 && rect.height === 0)) return null
      dlog('live selection rect ->', { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
      return rect
    }

    // ! If the overlay exists, derive rect from overlay highlights so we stick to the saved selection even when live selection collapsed
    try {
      const overlay = document.getElementById('content-popup-selection-overlay')
      if (overlay) {
        const blocks = Array.from(overlay.querySelectorAll('.hl'))
        if (blocks.length) {
          // choose bottom-most block
          let bottomMost = blocks[0].getBoundingClientRect()
          for (const el of blocks) {
            const r = el.getBoundingClientRect()
            if (r.bottom > bottomMost.bottom) bottomMost = r
          }
          if (bottomMost && (bottomMost.width > 0 || bottomMost.height > 0)) {
            dlog('overlay rect ->', { left: bottomMost.left, top: bottomMost.top, right: bottomMost.right, bottom: bottomMost.bottom })
            return bottomMost
          }
        }
      }
    } catch {}

    return null
  }

  function rectIntersectsViewport(rect) {
    // ! Consider visible if it intersects the viewport by at least 1px
    return (
      rect &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    )
  }

  function clamp(value, min, max) {
    // ! Keep a number between [min, max]
    return Math.max(min, Math.min(max, value))
  }

  function positionBox(box, rect) {
    // ! Clamp popup fully inside viewport while keeping it just below the selection
    // ! Determine where the selection sits on screen (rect provided by caller)
    if (!rect) return

    // ! Desired position just below the selection's bottom edge
    const desiredTop = rect.bottom + MARGIN
    const desiredLeft = rect.left

    // ! Ensure the element is measurable (needs display:block)
    box.style.display = 'block'
    // ! Measure the popup so we can ensure it remains fully visible
    const { width: boxW, height: boxH } = box.getBoundingClientRect()

    // ! Compute the furthest we can place the popup without overflowing the viewport
    const maxLeft = window.innerWidth - boxW - MARGIN
    const maxTop = window.innerHeight - boxH - MARGIN
    const clampedLeft = clamp(desiredLeft, MARGIN, Math.max(MARGIN, maxLeft))
    const clampedTop = clamp(desiredTop, MARGIN, Math.max(MARGIN, maxTop))

    // ! Clamp to viewport on both axes so nothing leaves the page
    box.style.left = `${clampedLeft}px`
    box.style.top = `${clampedTop}px`
    dlog('positioned', { desiredLeft, desiredTop, clampedLeft, clampedTop, boxW, boxH })
  }

  function update() {
    // ! Core visibility/positioning loop. Debounced through scheduleUpdate()
    const box = getOrCreateBox() // ! Lazily create and then reuse the popup element
    let rect = getSelectionRect()
    let selVisible = !!rect && rectIntersectsViewport(rect)

    // ! If selection is off-screen or collapsed, corner-anchor while selection exists OR popup is pinned (response open)
    const anySelectionOrPinned = hasSelection() || pinned
    if (!selVisible && anySelectionOrPinned) {
      rect = { left: MARGIN, top: window.innerHeight - (MARGIN + 1), right: MARGIN + 1, bottom: window.innerHeight - MARGIN, width: 1, height: 1 }
      selVisible = true
      dlog('corner-anchoring popup (no visible live rect, selection/pinned present)')
    }

    // ! Detect selection text changes to allow reopening after a force close
    let currentSelText = ''
    if (selVisible) {
      try { currentSelText = window.getSelection().toString().trim() } catch {}
    }
    const selectionChanged = currentSelText !== lastSelectionText // ! Only reopen after explicit close when text actually differs
    lastSelectionText = currentSelText

    // ! Only clear forceClosed when the selection CHANGES, not merely because it is visible
    if (selectionChanged) {
      forceClosed = false
    }

    // ! Only show for selection after the mouse is released, but always keep visible when interacting inside popup
    const shouldShow = !forceClosed && (pinned || (!isMouseDown && selVisible) || insidePopup)

    if (selVisible) {
      // ! Place under selection (or corner-snap if needed)
      positionBox(box, rect)
    }

    // ! Fire open/close events only when visibility changes
    if (shouldShow !== lastVisible) {
      try {
        // ! Dispatch on window so listeners outside the shadow can observe
        window.dispatchEvent(new CustomEvent(shouldShow ? 'popup:open' : 'popup:close'))
      } catch {}
      lastVisible = shouldShow
      dlog('visibility ->', shouldShow ? 'open' : 'closed')
    }

    box.style.display = shouldShow ? 'block' : 'none'
  }

  function scheduleUpdate() {
    // Debounce frequent layout-affecting events into a single rAF tick
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      try { update() } catch {}
    })
    dlog('scheduled update')
  }


// Run once on load in case a selection already exists (rare but safe)
update()

// ! Keep the popup in sync with user actions and viewport changes (debounced)
document.addEventListener('selectionchange', scheduleUpdate, { passive: true }) // ! As user drags/selects
document.addEventListener('mousedown', () => { isMouseDown = true; scheduleUpdate() }, { passive: true }) // ! Defer showing while pressed
document.addEventListener('mouseup', () => {
  isMouseDown = false
  scheduleUpdate()
  // Some apps clear selection immediately after mouseup; schedule a micro-delayed update
  setTimeout(() => { try { scheduleUpdate() } catch {} }, 20)
}, { passive: true }) // ! Show after release
document.addEventListener('keyup', scheduleUpdate, { passive: true }) // ! Handles Cmd/Ctrl+A and Escape, etc.
// Reposition on any scrolling, including nested scroll containers (capture to catch non-bubbling scroll)
document.addEventListener('scroll', scheduleUpdate, { passive: true, capture: true })
document.addEventListener('wheel', scheduleUpdate, { passive: true, capture: true })
document.addEventListener('touchmove', scheduleUpdate, { passive: true, capture: true })
window.addEventListener('scroll', scheduleUpdate, { passive: true }) // ! Reposition if page scrolls
window.addEventListener('resize', scheduleUpdate, { passive: true }) // ! Reposition if viewport resizes
})()