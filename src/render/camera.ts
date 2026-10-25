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
