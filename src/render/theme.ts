export interface ThemeColors {
  bg: string
  trail: string
  circle: string
  arrow: string
}

const LIGHT: ThemeColors = {
  bg: '#ffffff',
  trail: '#d6336c',
  circle: 'rgba(20, 24, 33, 0.28)',
  arrow: 'rgba(20, 24, 33, 0.75)',
}

const DARK: ThemeColors = {
  bg: '#0e1116',
  trail: '#ffd43b',
  circle: 'rgba(255, 255, 255, 0.28)',
  arrow: 'rgba(255, 255, 255, 0.8)',
}

export function fallbackColors(dark: boolean): ThemeColors {
  return { ...(dark ? DARK : LIGHT) }
}

export function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** --fd-bg, --fd-trail, --fd-circle, --fd-arrow from el's computed style, with fallbacks for the current scheme. */
export function readThemeColors(el: Element | null): ThemeColors {
  const out = fallbackColors(prefersDark())
  if (el === null || typeof getComputedStyle !== 'function') return out
  const cs = getComputedStyle(el)
  out.bg = cs.getPropertyValue('--fd-bg').trim() || out.bg
  out.trail = cs.getPropertyValue('--fd-trail').trim() || out.trail
  out.circle = cs.getPropertyValue('--fd-circle').trim() || out.circle
  out.arrow = cs.getPropertyValue('--fd-arrow').trim() || out.arrow
  return out
}
