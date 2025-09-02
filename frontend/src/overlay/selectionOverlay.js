
// Utilities for managing a visual overlay that highlights the saved selection range

export function createSelectionOverlay(OVERLAY_ID, responseOpenRef) {
  function ensureStyles() {
    if (document.getElementById('selection-overlay-style')) return
    const style = document.createElement('style')
    style.id = 'selection-overlay-style'
    style.textContent = `
      #${OVERLAY_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483646; }
      #${OVERLAY_ID} .hl { position: fixed; background: rgba(120, 160, 255, 0.35); border-radius: 2px; box-shadow: 0 0 0 1px rgba(120,160,255,0.25) inset; }
      /* Overlay must never block page interactions; selection locking is handled by listeners */
      #${OVERLAY_ID}.locked { pointer-events: none; }
    `
    document.head.appendChild(style)
  }

  function clear() {
    const ex = document.getElementById(OVERLAY_ID)
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex)
  }

  function renderFromRange(range) {
    try {
      if (!range) return
      ensureStyles()
      // Remove previous
      clear()
      const container = document.createElement('div')
      container.id = OVERLAY_ID
      // If response section is open, previously we toggled a class; keep but non-interactive
      try {
        const open = !!(responseOpenRef?.current)
        if (open) container.classList.add('locked')
      } catch {}
      const rects = range.getClientRects()
      for (const r of rects) {
        // Ignore zero-sized rects
        if (r.width < 0.5 || r.height < 0.5) continue
        const d = document.createElement('div')
        d.className = 'hl'
        d.style.left = `${Math.round(r.left)}px`
        d.style.top = `${Math.round(r.top)}px`
        d.style.width = `${Math.round(r.width)}px`
        d.style.height = `${Math.round(r.height)}px`
        container.appendChild(d)
      }
      document.body.appendChild(container)
    } catch {
      // ignore overlay issues
    }
  }

  return { ensureStyles, clear, renderFromRange }
}
