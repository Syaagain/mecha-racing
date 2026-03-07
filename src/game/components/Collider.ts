/**
 * Collider component.
 * Stores shape parameters used by PhysicsSystem for custom AABB / sphere
 * collision.
 */
export type ColliderKind = 'aabb' | 'sphere';

export interface ColliderData {
  kind:   ColliderKind;
  // AABB half-extents
  hx: number; hy: number; hz: number;
  // Sphere
  radius: number;
}

export function createAABB(
  hx: number, hy: number, hz: number,
): ColliderData {
  return { kind: 'aabb', hx, hy, hz, radius: 0 };
}

export function createSphere(
  radius: number,
): ColliderData {
  return { kind: 'sphere', hx: 0, hy: 0, hz: 0, radius };
}

// ── Overlap helpers (used by PhysicsSystem when Havok is not active) ───────

export function aabbOverlap(
  ax: number, ay: number, az: number, a: ColliderData,
  bx: number, by: number, bz: number, b: ColliderData,
): boolean {
  return (
    Math.abs(ax - bx) <= a.hx + b.hx &&
    Math.abs(ay - by) <= a.hy + b.hy &&
    Math.abs(az - bz) <= a.hz + b.hz
  );
}

export function sphereOverlap(
  ax: number, ay: number, az: number, ra: number,
  bx: number, by: number, bz: number, rb: number,
): boolean {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz <= (ra + rb) ** 2;
}
