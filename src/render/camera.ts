/** Fraction of the short side left empty on each side when fitting the unit disk. */
export const FIT_MARGIN = 0.04

/** Easing rate (1/s) for follow blend and zoom. */
export const CAMERA_RATE = 4

/** Screen pixels per world unit so the unit disk fits a width x height viewport with a margin. */
export function fitScale(width: number, height: number, margin = FIT_MARGIN): number {
  return Math.max(0, Math.min(width, height) * (0.5 - margin))
}

/** Exponential smoothing factor for a step of dt seconds. */
export function smoothing(dt: number, rate: number): number {
  return 1 - Math.exp(-rate * Math.max(0, dt))
}

/**
 * follow blends the view center from the origin (0) to the tip (1), so a moving tip
 * stays locked in view while the toggle itself eases. zoom multiplies fitScale.
 */
export interface Camera {
  follow: number
  zoom: number
}

export function newCamera(): Camera {
  return { follow: 0, zoom: 1 }
}

/** Eases cam toward the follow/zoom target. Returns true once settled (and snapped onto the target). */
export function stepCamera(cam: Camera, following: boolean, followZoom: number, dt: number): boolean {
  const tf = following ? 1 : 0
  const tz = following ? Math.max(1e-3, followZoom) : 1
  const k = smoothing(dt, CAMERA_RATE)
  cam.follow += (tf - cam.follow) * k
  const lz = Math.log(cam.zoom)
  cam.zoom = Math.exp(lz + (Math.log(tz) - lz) * k)
  if (Math.abs(tf - cam.follow) < 1e-3 && Math.abs(cam.zoom / tz - 1) < 1e-3) {
    cam.follow = tf
    cam.zoom = tz
    return true
  }
  return false
}

export interface View {
  /** screen = (ox + x * s, oy + y * s) */
  ox: number
  oy: number
  s: number
}

/** World-to-screen transform for a viewport, given the camera and the current tip. */
export function viewTransform(width: number, height: number, cam: Camera, tipX: number, tipY: number, out: View): View {
  const s = fitScale(width, height) * cam.zoom
  out.s = s
  out.ox = width / 2 - cam.follow * tipX * s
  out.oy = height / 2 - cam.follow * tipY * s
  return out
}

/**
 * Smooth follow state: the world point at the screen center and its velocity (world units per
 * second). Locking the view onto the tip shakes the whole drawing on every turn of the tip; this
 * drifts after it instead.
 */
export interface FollowCam {
  x: number
  y: number
  vx: number
  vy: number
}

export function newFollowCam(): FollowCam {
  return { x: 0, y: 0, vx: 0, vy: 0 }
}

export interface FollowLimits {
  /** The camera holds still while the target is within this many screen px of the center. */
  deadZone: number
  /** Top speed in screen px per second, */
  maxSpeed: number
  /** plus this much per px the target is away, so a camera that fell behind catches up. */
  catchUp: number
}

/** Rate (1/s) at which the camera closes the distance past the dead zone, and eases its velocity. */
const FOLLOW_RATE = 4
const FOLLOW_ACCEL_RATE = 6

/**
 * Moves fc toward the target (tx, ty) in world units, at scale s screen px per unit. The camera
 * eases its velocity, never moves faster than the limits allow, and stops inside the dead zone.
 * Returns true when it's at rest.
 */
export function stepFollow(fc: FollowCam, tx: number, ty: number, s: number, dt: number, lim: FollowLimits): boolean {
  if (!(s > 0)) return true
  const dx = (tx - fc.x) * s
  const dy = (ty - fc.y) * s
  const dist = Math.hypot(dx, dy)
  const max = lim.maxSpeed + lim.catchUp * dist
  let wx = 0
  let wy = 0
  if (dist > lim.deadZone) {
    const want = Math.min(max, (dist - lim.deadZone) * FOLLOW_RATE)
    wx = (dx / dist) * want
    wy = (dy / dist) * want
  }
  if (dt > 0) {
    const a = smoothing(dt, FOLLOW_ACCEL_RATE)
    let vx = fc.vx * s + (wx - fc.vx * s) * a
    let vy = fc.vy * s + (wy - fc.vy * s) * a
    const sp = Math.hypot(vx, vy)
    if (sp > max) {
      vx *= max / sp
      vy *= max / sp
    }
    fc.vx = vx / s
    fc.vy = vy / s
    fc.x += fc.vx * dt
    fc.y += fc.vy * dt
  }
  const resting = Math.hypot(fc.vx, fc.vy) * s < 0.5 && dist <= lim.deadZone + 0.5
  if (resting) {
    fc.vx = 0
    fc.vy = 0
  }
  return resting
}
