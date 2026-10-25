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

/** fg over bg at opacity a, as an opaque rgb() string. Channels are 0..255. */
export function mixRgb(fg: readonly number[], bg: readonly number[], a: number): string {
  const ch = (i: number) => Math.round(bg[i] + (fg[i] - bg[i]) * a)
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`
}

/**
 * Any CSS color as [r, g, b], letting the canvas parse it: fillStyle reads back as
 * #rrggbb or rgba(...). Alpha is dropped. The canvas ignores invalid colors, so they read
 * as black; null only when fillStyle comes back in a form we don't parse.
 */
export function parseRgb(ctx: { fillStyle: string | CanvasGradient | CanvasPattern }, color: string): number[] | null {
  const prev = ctx.fillStyle
  ctx.fillStyle = '#000'
  ctx.fillStyle = color
  const v = ctx.fillStyle
  ctx.fillStyle = prev
  if (typeof v !== 'string') return null
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v)
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)]
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(v)
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null
}
