// Byte-weighted progress over several files, reported as one monotonic 0..1 value.

export interface Progress {
  /** Record bytes for one file. total 0 means unknown (counts as not started). */
  file(key: string, loaded: number, total: number): void
  /** Report 1. Later updates are ignored. */
  done(): void
}

/**
 * expected: known file sizes, so the bar does not jump when a later file starts.
 * Output never decreases and stays below 1 until done().
 */
export function createProgress(onProgress: (p: number) => void, expected: Record<string, number> = {}): Progress {
  const files = new Map<string, { loaded: number; total: number }>()
  for (const [k, total] of Object.entries(expected)) files.set(k, { loaded: 0, total })
  let last = 0
  let finished = false

  const emit = () => {
    if (finished) return
    let loaded = 0
    let total = 0
    for (const f of files.values()) {
      loaded += Math.min(f.loaded, f.total)
      total += f.total
    }
    if (total <= 0) return
    const p = Math.min(0.999, loaded / total)
    if (p <= last) return
    last = p
    onProgress(p)
  }

  const set = (key: string, loaded: number, total: number) => {
    const prev = files.get(key)
    // Keep a known size when an event reports none (e.g. a missing Content-Length).
    const t = total > 0 ? total : (prev?.total ?? 0)
    files.set(key, { loaded: Math.max(loaded, prev?.loaded ?? 0), total: Math.max(t, loaded) })
  }

  return {
    file(key, loaded, total) {
      set(key, loaded, total)
      emit()
    },
    done() {
      if (finished) return
      finished = true
      onProgress(1)
    },
  }
}

/**
 * Wrap a loader so concurrent and repeated calls share one promise. Every caller's
 * onProgress receives updates from then on. A failed load is forgotten so a later call retries.
 */
export function sharedLoader<T>(
  load: (onProgress: (p: number) => void) => Promise<T>,
): ((onProgress?: (p: number) => void) => Promise<T>) & { reset(): void } {
  let pending: Promise<T> | null = null
  const listeners = new Set<(p: number) => void>()
  const emit = (p: number) => {
    for (const l of listeners) l(p)
  }
  let loaded = false
  const fn = (onProgress?: (p: number) => void): Promise<T> => {
    if (loaded) {
      onProgress?.(1)
      return pending as Promise<T>
    }
    if (onProgress) listeners.add(onProgress)
    if (!pending) {
      const p = (async () => load(emit))()
      pending = p
      p.then(
        () => {
          loaded = true
          emit(1)
          listeners.clear()
        },
        () => {
          if (pending === p) pending = null
          listeners.clear()
        },
      )
    }
    return pending
  }
  /** Forget a finished load, so the next call loads again. A load in flight is left alone. */
  fn.reset = () => {
    if (!loaded) return
    loaded = false
    pending = null
  }
  return fn
}
