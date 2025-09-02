import { useCallback, useRef, useState, useEffect } from 'react'
import speakText, { stopSpeech } from '../scripts/tts'

/**
 * useTTS encapsulates audio playback state and controls for selection and response.
 *
 * @param {Object} opts
 * @param {(source: 'selection'|'response') => void} [opts.onLoadingStart] optional callback when loading starts
 * @param {(msg: string) => void} [opts.onError] error sink
 * @param {() => string} [opts.resolveSelectionText] returns preferred selection text
 * @returns {Object} controls and flags
 */
export default function useTTS(opts = {}) {
  const { onLoadingStart, onError, resolveSelectionText } = opts

  const [speaking, setSpeaking] = useState(false)
  const [speakingSource, setSpeakingSource] = useState(null) // 'selection' | 'response' | null
  const [audioLoadingSelection, setAudioLoadingSelection] = useState(false)
  const [audioLoadingResponse, setAudioLoadingResponse] = useState(false)

  // Keep a ref of speaking to avoid stale closures without re-creating callbacks
  const speakingRef = useRef(false)
  useEffect(() => { speakingRef.current = speaking }, [speaking])

  const stopAll = useCallback(() => {
    try { stopSpeech() } catch {}
    setAudioLoadingSelection(false)
    setAudioLoadingResponse(false)
    speakingRef.current = false
    setSpeaking(false)
    setSpeakingSource(null)
  }, [])

  const play = useCallback(async (text, source) => {
    if (!text) {
      onError && onError('Please select some text to read.')
      return
    }
    try {
      speakingRef.current = true
      setSpeaking(true)
      setSpeakingSource(source)
      const setLoading = source === 'response' ? setAudioLoadingResponse : setAudioLoadingSelection
      setLoading(true)
      onLoadingStart && onLoadingStart(source)
      await new Promise(requestAnimationFrame)
      const timeoutMs = 12000
      const ttsPromise = speakText(text, {
        playbackRate: 1.25,
        // Disable streaming for reliability; fallback endpoint returns a full mp3 and triggers onReady
        stream: false,
        timeoutMs,
        onLoadingStart: () => {},
        onReady: () => setLoading(false),
      })
      // Watchdog: ensure we never wait forever
      const watchdog = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Audio timeout')), timeoutMs + 2000)
      })
      await Promise.race([ttsPromise, watchdog])
    } catch (e) {
      onError && onError(e?.message || 'Failed to play audio')
    } finally {
      setAudioLoadingSelection(false)
      setAudioLoadingResponse(false)
      speakingRef.current = false
      setSpeaking(false)
      setSpeakingSource(null)
    }
  }, [onError, onLoadingStart])

  const handleSelectionAudio = useCallback(async (fallback) => {
    if (speakingRef.current) {
      stopAll()
      return
    }
    let text = fallback || ''
    // Prefer live selection; if absent, use resolver if provided
    try {
      const sel = window.getSelection && window.getSelection()
      const live = sel ? sel.toString().trim() : ''
      if (live) text = live
      else if (typeof resolveSelectionText === 'function') {
        const resolved = String(resolveSelectionText() || '').trim()
        if (resolved) text = resolved
      }
    } catch {}
    await play(text, 'selection')
  }, [play, resolveSelectionText, stopAll])

  const handleResponseAudio = useCallback(async (responseText) => {
    if (speakingRef.current) {
      stopAll()
      return
    }
    await play(responseText, 'response')
  }, [play, stopAll])

  return {
    speaking,
    speakingSource,
    audioLoadingSelection,
    audioLoadingResponse,
    handleSelectionAudio,
    handleResponseAudio,
    stopAll,
  }
}
