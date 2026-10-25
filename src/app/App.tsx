import { useEffect } from 'preact/hooks'
import { openFromClipboardData, pasteFromClipboard } from './controller'
import { ClipboardIcon, EpicycleIcon, UploadIcon } from './icons'
import { Panel } from './Panel'
import { FileInput, pickFile, Stage } from './Stage'
import { recording, source } from './state'

export function App() {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Let text fields keep their own paste.
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (recording.peek()) return
      if (openFromClipboardData(e.clipboardData)) e.preventDefault()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  return (
    <div class="app-shell is-fixed">
      <header class="topbar is-split is-compact">
        <span class="wordmark">
          <span class="mark" aria-hidden="true">
            <EpicycleIcon class="cn-icon" />
          </span>
          Fourier<em>&nbsp;drawing</em>
        </span>
        <TopActions />
      </header>
      <main class="fd-main">
        <Stage />
        <MaybePanel />
      </main>
      <FileInput />
    </div>
  )
}

// Before the first upload the stage is the whole page; nothing in the panel applies yet.
function MaybePanel() {
  return source.value === 'none' ? null : <Panel />
}

function TopActions() {
  if (source.value === 'none') return <span />
  const busy = recording.value
  return (
    <div class="cn-row cn-end">
      <button type="button" class="btn btn-ghost is-sm" disabled={busy} onClick={() => void pasteFromClipboard()}>
        <ClipboardIcon />
        Paste
      </button>
      <button type="button" class="btn btn-secondary is-sm" disabled={busy} onClick={pickFile}>
        <UploadIcon />
        New image
      </button>
    </div>
  )
}
