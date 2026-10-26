import { render } from 'preact'
import posthog, { type Properties } from 'posthog-js'
import { App } from './app/App'
import { openFromLocation } from './app/controller'
import './styles.css'

const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY
if (POSTHOG_KEY) {
  // Cookieless, so nothing lands in cookies or storage. Photos never reach PostHog: autocapture
  // skips canvas pixels, and the hash is cut from URLs because a #d= share link holds the drawing.
  posthog.init(POSTHOG_KEY, {
    api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
    defaults: '2026-05-30',
    cookieless_mode: 'always',
    before_send: (event) => event && stripHash(event),
  })
} else if (import.meta.env.DEV) {
  throw new Error(
    'VITE_PUBLIC_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_PUBLIC_POSTHOG_KEY is configured',
  )
}

/** Cuts the hash off every URL of this page, at any depth: web vitals nest their own copies. */
function stripHash<T>(value: T): T {
  if (typeof value === 'string') return (value.startsWith(location.origin) ? value.split('#')[0] : value) as T
  if (value && typeof value === 'object') {
    const obj = value as Properties
    for (const key of Object.keys(obj)) obj[key] = stripHash(obj[key])
  }
  return value
}

render(<App />, document.getElementById('app')!)
void openFromLocation()
