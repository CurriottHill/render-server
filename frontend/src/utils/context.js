// Context and selection helpers extracted from ContentPopup.jsx

// Find nearest block-level ancestor for context
export function getNearestBlockElement(node) {
  let el = node
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    const tag = el.tagName
    if (tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'ARTICLE' || tag === 'SECTION' || tag === 'MAIN' || tag === 'DIV') {
      // Heuristic: accept common block containers
      return el
    }
    el = el.parentElement
  }
  return null
}

// Get high-level page context: URL and primary heading
export function getPageContext() {
  try {
    const url = window.location?.href || ''
    const h1 = (document.querySelector('h1')?.innerText || '').trim()
    const title = (document.title || '').trim()
    const heading = h1 || title
    const MAX = 200
    const headingClamped = heading.length > MAX ? heading.slice(0, MAX) + '…' : heading
    return { url, heading: headingClamped }
  } catch {
    return { url: '', heading: '' }
  }
}

// Extract context paragraph text from current selection
export function getSelectionContextText() {
  try {
    const sel = window.getSelection && window.getSelection()
    if (!sel || sel.rangeCount === 0) return ''
    const range = sel.getRangeAt(0)
    const ancestor = range.commonAncestorContainer
    const block = getNearestBlockElement(ancestor)
    if (!block) return ''
    const text = (block.innerText || block.textContent || '').trim()
    // Clamp overly long context to keep prompts small
    const MAX = 800
    return text.length > MAX ? text.slice(0, MAX) + '…' : text
  } catch {
    return ''
  }
}
