import { describe, expect, it } from 'vitest'
import { parsePathData, parseViewBox, splitSubpaths } from './svg'

describe('parsePathData', () => {
  it('expands implicit linetos after a moveto', () => {
    expect(parsePathData('M0 0 10 0 10 10')).toEqual([
      { cmd: 'M', args: [0, 0] },
      { cmd: 'L', args: [10, 0] },
      { cmd: 'L', args: [10, 10] },
    ])
    expect(parsePathData('m1 1 2 2').map((s) => s.cmd)).toEqual(['m', 'l'])
  })

  it('reads compact numbers, exponents and packed arc flags', () => {
    expect(parsePathData('M-1-2.5.5 1L1e1,2E-1')).toEqual([
      { cmd: 'M', args: [-1, -2.5] },
      { cmd: 'L', args: [0.5, 1] },
      { cmd: 'L', args: [10, 0.2] },
    ])
    expect(parsePathData('a10 10 0 01100 100')).toEqual([{ cmd: 'a', args: [10, 10, 0, 0, 1, 100, 100] }])
  })

  it('repeats curve commands and handles closepath', () => {
    const segs = parsePathData('M0 0C1 1 2 2 3 3 4 4 5 5 6 6zM9 9')
    expect(segs.map((s) => s.cmd)).toEqual(['M', 'C', 'C', 'z', 'M'])
    expect(segs[2].args).toEqual([4, 4, 5, 5, 6, 6])
  })

  it('stops at the first error and handles empty input', () => {
    expect(parsePathData('')).toEqual([])
    expect(parsePathData('   ')).toEqual([])
    expect(parsePathData('M0 0 L5 x L9 9')).toEqual([{ cmd: 'M', args: [0, 0] }])
    expect(parsePathData('10 10')).toEqual([])
    expect(parsePathData('M0 0 L1')).toEqual([{ cmd: 'M', args: [0, 0] }])
  })
})

describe('splitSubpaths', () => {
  it('splits at each moveto and makes relative movetos absolute', () => {
    expect(splitSubpaths('M0 0 L10 0 m5 5 l1 1')).toEqual(['M0 0 L10 0', 'M15 5 l1 1'])
  })

  it('tracks the current point through every command type', () => {
    const parts = splitSubpaths('M10 10 h5 v5 H0 V2 c1 1 2 2 3 3 s1 1 2 2 q1 1 4 4 t1 1 a1 1 0 0 1 2 2 m1 1 l1 0')
    // 10,10 -> h5 15,10 -> v5 15,15 -> H0 0,15 -> V2 0,2 -> c 3,5 -> s 5,7 -> q 9,11 -> t 10,12 -> a 12,14 -> m 13,15
    expect(parts).toHaveLength(2)
    expect(parts[1]).toBe('M13 15 l1 0')
  })

  it('returns to the subpath start after closepath', () => {
    expect(splitSubpaths('M5 5 l10 0 l0 10 z m1 1 l2 0')).toEqual(['M5 5 l10 0 l0 10 Z', 'M6 6 l2 0'])
  })

  it('keeps drawing after closepath without a moveto in the same piece', () => {
    expect(splitSubpaths('M0 0 L4 0 Z l0 4')).toEqual(['M0 0 L4 0 Z l0 4'])
  })

  it('drops subpaths that only move', () => {
    expect(splitSubpaths('M0 0 M5 5 L6 6 M9 9')).toEqual(['M5 5 L6 6'])
    expect(splitSubpaths('M1 1')).toEqual([])
    expect(splitSubpaths('')).toEqual([])
  })

  it('treats implicit linetos of a relative moveto as relative', () => {
    expect(splitSubpaths('m10 10 5 0 m1 1 2 2')).toEqual(['M10 10 l5 0', 'M16 11 l2 2'])
  })
})

describe('parseViewBox', () => {
  it('parses space and comma separated values', () => {
    expect(parseViewBox('0 0 100 50')).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(parseViewBox(' -10,-5, 20 ,10 ')).toEqual({ x: -10, y: -5, width: 20, height: 10 })
  })

  it('rejects missing and degenerate boxes', () => {
    expect(parseViewBox(null)).toBeNull()
    expect(parseViewBox('')).toBeNull()
    expect(parseViewBox('0 0 0 10')).toBeNull()
    expect(parseViewBox('0 0 10')).toBeNull()
    expect(parseViewBox('a b c d')).toBeNull()
  })
})
