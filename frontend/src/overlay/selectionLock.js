// Utilities to lock user selection on the page while response UI is open

export function createSelectionLock(isEventInsidePopup, OVERLAY_ID) {
  const selectionBlockHandlers = {
    // Only block actions that directly start or modify selection
    selectstart: (e) => { if (!isEventInsidePopup(e)) { e.preventDefault(); e.stopPropagation() } },
    dragstart:   (e) => { if (!isEventInsidePopup(e)) { e.preventDefault(); e.stopPropagation() } },
    keydown:     (e) => {
      if (isEventInsidePopup(e)) return
      const k = e.key
      const isSelectKeys = (e.shiftKey && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(k)) || ((k === 'a' || k === 'A') && (e.metaKey || e.ctrlKey))
      if (isSelectKeys) { e.preventDefault(); e.stopPropagation() }
    },
  }

  function add() {
    try {
      for (const [evt, handler] of Object.entries(selectionBlockHandlers)) {
        window.addEventListener(evt, handler, true)
      }
      const el = document.getElementById(OVERLAY_ID)
      if (el) el.classList.add('locked')
    } catch {}
  }

  function remove() {
    try {
      for (const [evt, handler] of Object.entries(selectionBlockHandlers)) {
        window.removeEventListener(evt, handler, true)
      }
      const el = document.getElementById(OVERLAY_ID)
      if (el) el.classList.remove('locked')
    } catch {}
  }

  return { add, remove }
}
