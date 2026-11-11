import { describe, expect, it } from 'vitest'
import { FIT_MARGIN, fitScale, newCamera, newFollowCam, smoothing, stepCamera, stepFollow, viewTransform, type View } from './camera'

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

describe('stepFollow', () => {
  const lim = { deadZone: 50, maxSpeed: 700, catchUp: 3 }
  const s = 100 // screen px per world unit
  const dt = 1 / 60

  it('holds still while the target is inside the dead zone', () => {
    const fc = newFollowCam()
    for (let i = 0; i < 60; i++) expect(stepFollow(fc, 0.3, 0.2, s, dt, lim)).toBe(true)
    expect(fc).toEqual(newFollowCam())
  })

  it('comes to rest inside the dead zone without passing the target', () => {
    const fc = newFollowCam()
    let rest = false
    for (let i = 0; i < 600; i++) {
      rest = stepFollow(fc, 3, 0, s, dt, lim)
      expect(fc.x).toBeLessThan(3)
    }
    expect(rest).toBe(true)
    expect((3 - fc.x) * s).toBeLessThanOrEqual(lim.deadZone)
    expect(fc.vx).toBe(0)
  })

  it('never moves faster than the cap allows for its distance', () => {
    const fc = newFollowCam()
    for (let i = 0; i < 120; i++) {
      const dist = Math.hypot(5 - fc.x, -2 - fc.y) * s
      stepFollow(fc, 5, -2, s, dt, lim)
      expect(Math.hypot(fc.vx, fc.vy) * s).toBeLessThanOrEqual(lim.maxSpeed + lim.catchUp * dist + 1e-6)
    }
  })

  it('catches up from far behind in about a second', () => {
    const fc = newFollowCam()
    // 8000 px away, as after zooming in fast.
    for (let i = 0; i < 90; i++) stepFollow(fc, 80, 0, s, dt, lim)
    expect((80 - fc.x) * s).toBeLessThan(400)
  })

  it('without a dead zone it settles on the target', () => {
    const fc = newFollowCam()
    let rest = false
    for (let i = 0; i < 600 && !rest; i++) rest = stepFollow(fc, 1, 1, s, dt, { ...lim, deadZone: 0 })
    expect(rest).toBe(true)
    expect(Math.hypot(1 - fc.x, 1 - fc.y) * s).toBeLessThan(1)
  })
})
