/**
 * Collider component.
 * Stores shape parameters used by PhysicsSystem for custom AABB / sphere
 * collision. Also carries the Babylon PhysicsImpostor type string so
 * LevelBuilder can wire up Babylon physics if the Havok plugin is enabled.
 */
export type ColliderKind = 'aabb' | 'sphere';

/** Maps to Babylon PhysicsImpostor constants (kept as strings for tree-shaking) */
export type ImpostorType = 'box' | 'sphere' | 'cylinder' | 'none';

export interface ColliderData {
  kind:         ColliderKind;
  impostorType: ImpostorType;
  // AABB half-extents
  hx: number; hy: number; hz: number;
  // Sphere
  radius: number;
  mass:         number;
  restitution:  number;
  friction:     number;
  /** Set by PhysicsSystem on collision this frame. */
  isColliding:  boolean;
  hitEntity:    number;
}

export function createAABB(
  hx: number, hy: number, hz: number,
  mass = 0, restitution = 0.2, friction = 0.8,
): ColliderData {
  return { kind: 'aabb', impostorType: 'box', hx, hy, hz, radius: 0, mass, restitution, friction, isColliding: false, hitEntity: -1 };
}

export function createSphere(
  radius: number,
  mass = 0, restitution = 0.3, friction = 0.5,
): ColliderData {
  return { kind: 'sphere', impostorType: 'sphere', hx: 0, hy: 0, hz: 0, radius, mass, restitution, friction, isColliding: false, hitEntity: -1 };
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
