import { describe, expect, it } from 'vitest'
import { FIT_MARGIN, fitScale, newCamera, smoothing, stepCamera, viewTransform, type View } from './camera'

describe('fitScale', () => {
  it('fits the unit disk inside the short side with a margin', () => {
    const s = fitScale(800, 600)
    expect(s).toBeCloseTo(600 * (0.5 - FIT_MARGIN))
    expect(2 * s).toBeLessThan(600)
    expect(fitScale(600, 800)).toBe(s)
  })

  it('is zero for an empty viewport', () => {
    expect(fitScale(0, 500)).toBe(0)
  })
})

describe('viewTransform', () => {
  const out: View = { ox: 0, oy: 0, s: 0 }

  it('centers the origin when not following', () => {
    const v = viewTransform(400, 300, newCamera(), 0.5, -0.25, out)
    expect(v.ox).toBe(200)
    expect(v.oy).toBe(150)
  })

  it('puts the tip at the viewport center when fully following', () => {
    const cam = { follow: 1, zoom: 6 }
    const v = viewTransform(400, 300, cam, 0.5, -0.25, out)
    expect(v.s).toBeCloseTo(fitScale(400, 300) * 6)
    expect(v.ox + 0.5 * v.s).toBeCloseTo(200)
    expect(v.oy - 0.25 * v.s).toBeCloseTo(150)
  })
})

describe('stepCamera', () => {
  it('does not move on a zero step', () => {
    const cam = newCamera()
    expect(stepCamera(cam, true, 6, 0)).toBe(false)
    expect(cam).toEqual({ follow: 0, zoom: 1 })
  })

  it('eases monotonically toward the follow target and settles', () => {
    const cam = newCamera()
    let prevF = 0
    let prevZ = 1
    let settled = false
    for (let i = 0; i < 600 && !settled; i++) {
      settled = stepCamera(cam, true, 6, 1 / 60)
      expect(cam.follow).toBeGreaterThanOrEqual(prevF)
      expect(cam.zoom).toBeGreaterThanOrEqual(prevZ)
      // No single 60fps frame jumps more than a small fraction of the way.
      expect(cam.follow - prevF).toBeLessThan(0.1)
      prevF = cam.follow
      prevZ = cam.zoom
    }
    expect(settled).toBe(true)
    expect(cam).toEqual({ follow: 1, zoom: 6 })
  })

  it('eases back out when following is turned off', () => {
    const cam = { follow: 1, zoom: 6 }
    stepCamera(cam, false, 6, 1 / 60)
    expect(cam.follow).toBeGreaterThan(0.9)
    expect(cam.zoom).toBeGreaterThan(5)
    for (let i = 0; i < 600; i++) if (stepCamera(cam, false, 6, 1 / 60)) break
    expect(cam).toEqual({ follow: 0, zoom: 1 })
  })

  it('is frame-rate independent', () => {
    const a = newCamera()
    const b = newCamera()
    for (let i = 0; i < 30; i++) stepCamera(a, true, 4, 1 / 60)
    for (let i = 0; i < 15; i++) stepCamera(b, true, 4, 1 / 30)
    expect(a.follow).toBeCloseTo(b.follow, 10)
    expect(a.zoom).toBeCloseTo(b.zoom, 10)
  })

  it('smoothing is 0 at dt 0 and approaches 1', () => {
    expect(smoothing(0, 4)).toBe(0)
    expect(smoothing(-1, 4)).toBe(0)
    expect(smoothing(10, 4)).toBeGreaterThan(0.999)
  })
})
