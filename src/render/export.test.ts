import { describe, expect, it } from 'vitest'
import { mixRgb, parseRgb } from './theme'
import type { SinglePath } from '../pipeline/types'
import { pathToSvg } from './export'

function path(xy: number[], jump: number[]): SinglePath {
  return { points: Float32Array.from(xy), jump: Uint8Array.from(jump) }
}

function dOf(svg: string): string | null {
  const m = /<path d="([^"]*)"/.exec(svg)
  return m ? m[1] : null
}

describe('pathToSvg', () => {
  // Square with the second side (1 -> 2) a connecting jump.
  const square = path([0, 0, 10, 0, 10, 10, 0, 10], [0, 1, 0, 0])

  it('produces a pixel-space SVG document with stroke only', () => {
    const svg = pathToSvg(square, 640, 480, false)
    expect(svg.startsWith('<?xml')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('viewBox="0 0 640 480"')
    expect(svg).toContain('width="640"')
    expect(svg).toContain('fill="none"')
    expect(svg).toMatch(/stroke="[^"]+"/)
    expect(svg.trim().endsWith('</svg>')).toBe(true)
    expect(svg.match(/<path /g)).toHaveLength(1)
  })

  it('keeps one closed subpath when jumps are shown', () => {
    expect(dOf(pathToSvg(square, 20, 20, false))).toBe('M0 0L10 0L10 10L0 10Z')
  })

  it('splits into subpaths at jumps when hidden', () => {
    // Remaining segments: 0->1, then 2->3->0 as one run.
    expect(dOf(pathToSvg(square, 20, 20, true))).toBe('M0 0L10 0M10 10L0 10L0 0')
  })

  it('omits the closing segment when it is a jump', () => {
    const p = path([0, 0, 5, 0, 5, 5], [0, 0, 1])
    expect(dOf(pathToSvg(p, 10, 10, true))).toBe('M0 0L5 0L5 5')
    expect(dOf(pathToSvg(p, 10, 10, false))).toBe('M0 0L5 0L5 5Z')
  })

  it('handles several separate strokes', () => {
    const p = path([0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0], [0, 1, 0, 1, 0, 1])
    expect(dOf(pathToSvg(p, 10, 10, true))).toBe('M0 0L1 0M2 0L3 0M4 0L5 0')
  })

  it('emits no path when every segment is a jump', () => {
    const p = path([0, 0, 1, 1], [1, 1])
    expect(dOf(pathToSvg(p, 10, 10, true))).toBeNull()
  })

  it('rounds coordinates to 2 decimals', () => {
    const p = path([1.23456, 2.0, 3.999, -0.001], [0, 0])
    expect(dOf(pathToSvg(p, 10.5, 10, false))).toBe('M1.23 2L4 0Z')
    expect(pathToSvg(p, 10.5, 10, false)).toContain('viewBox="0 0 10.5 10"')
  })

  it('handles empty and single-point paths', () => {
    const empty = pathToSvg(path([], []), 100, 50, true)
    expect(empty).toContain('viewBox="0 0 100 50"')
    expect(dOf(empty)).toBeNull()
    expect(dOf(pathToSvg(path([3, 4], [0]), 10, 10, false))).toBeNull()
  })

  it('splits a long path into one subpath per stroke', () => {
    const n = 500
    const xy: number[] = []
    const jump: number[] = []
    for (let i = 0; i < n; i++) {
      xy.push(100 + 50 * Math.cos(i), 100 + 50 * Math.sin(i))
      jump.push(i % 50 === 49 ? 1 : 0)
    }
    const d = dOf(pathToSvg(path(xy, jump), 200, 200, true))
    expect(d).toMatch(/^[MLZ0-9. -]+$/)
    expect(d!.match(/M/g)).toHaveLength(10)
  })
})

describe('mixRgb', () => {
  it('premixes a color over the background', () => {
    expect(mixRgb([255, 0, 0], [0, 0, 255], 0.5)).toBe('rgb(128, 0, 128)')
    expect(mixRgb([10, 20, 30], [200, 200, 200], 1)).toBe('rgb(10, 20, 30)')
  })
})

describe('parseRgb', () => {
  // Stands in for a canvas context: normalizes like Chrome does.
  const fake = () => {
    let v = '#000000'
    return {
      get fillStyle(): string {
        return v
      },
      set fillStyle(c: string) {
        if (/^#[0-9a-f]{6}$/i.test(c) || /^rgba?\(/.test(c)) v = c.toLowerCase()
        else if (c === '#000') v = '#000000'
      },
    }
  }
  it('reads hex and rgba', () => {
    expect(parseRgb(fake(), '#F9E2AF')).toEqual([249, 226, 175])
    expect(parseRgb(fake(), 'rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3])
  })
  it('returns black for colors the canvas rejects, like the canvas does', () => {
    expect(parseRgb(fake(), 'not-a-color')).toEqual([0, 0, 0])
  })
})
