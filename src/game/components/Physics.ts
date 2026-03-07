/**
 * Physics component – Hover-Mecha arcade model.
 * Flat Float32Array (SoA layout, zero-GC per frame).
 *
 * ┌─────┬──────────────────────┬─────────────────────────────────────────────┐
 * │ idx │ Name                 │ Notes                                       │
 * ├─────┼──────────────────────┼─────────────────────────────────────────────┤
 * │ 0-2 │ vel x/y/z            │ World-space velocity (m/s)                  │
 * │  3  │ yaw                  │ Heading angle in radians (XZ plane)         │
 * │  4  │ speed                │ Derived horizontal speed scalar             │
 * │  5  │ engineForce          │ Peak acceleration force (m/s²)              │
 * │  6  │ brakingForce         │ Deceleration when braking/reversing (m/s²)  │
 * │  7  │ topSpeed             │ Hard velocity cap (m/s)                     │
 * │  8  │ drag                 │ Air drag – grounded; velocity *= (1-drag·dt)│
 * │  9  │ rollingResistance    │ Constant decel when grounded (m/s²)         │
 * │ 10  │ steerSpeed           │ Base max steering rate (rad/s at v→0)       │
 * │ 11  │ gripStatic           │ Lateral grip – normal hover   [0,1]         │
 * │ 12  │ gripDynamic          │ Lateral grip – handbrake/drift [0,1]        │
 * │ 13  │ turnRadius           │ Sharpness curve divisor                     │
 * │ 14  │ gravity              │ Downward accel (m/s²)                       │
 * │ 15  │ airDrag              │ Drag multiplier when fully airborne          │
 * │ 16  │ hoverTargetHeight    │ Spring rest height above track surface (m)  │
 * │ 17  │ springStiffness      │ Spring force = heightErr × stiffness        │
 * │ 18  │ springDampening      │ Damper force  = velY × dampening            │
 * │ 19  │ bankingAngle         │ Max lean angle on steering (radians)        │
 * │ 20  │ mass                 │ kg – collision response                     │
 * │ 21  │ (reserved)           │                                             │
 * └─────┴──────────────────────┴─────────────────────────────────────────────┘
 */
export const PHYSICS_STRIDE = 22;

/**
 * Factory – defaults tuned for a mid-weight hover-mecha.
 */
export function createPhysics(
  engineForce        = 60,
  brakingForce       = 120,
  topSpeed           = 80,      // m/s ≈ 288 km/h
  drag               = 0.025,   // ground drag per second
  rollingResistance  = 0.08,    // m/s² constant ground friction (lower than wheeled)
  steerSpeed         = 2.0,     // rad/s max turn rate (at v→0)
  gripStatic         = 0.82,    // hover slides more than a wheeled car
  gripDynamic        = 0.30,    // wide drift on handbrake
  turnRadius         = 8,
  gravity            = 25,
  airDrag            = 0.008,   // much lower drag airborne (floaty feel)
  hoverTargetHeight  = 1.5,     // m above track surface
  springStiffness    = 55,      // tuned: not too stiff, not too loose
  springDampening    = 9,       // tuned: stops oscillation without deadening
  bankingAngle       = 0.28,    // ~16° max lean
  mass               = 1200,
): Float32Array {
  const p = new Float32Array(PHYSICS_STRIDE);
  p[Physics.ENGINE_FORCE]       = engineForce;
  p[Physics.BRAKING_FORCE]      = brakingForce;
  p[Physics.TOP_SPEED]          = topSpeed;
  p[Physics.DRAG]               = drag;
  p[Physics.ROLLING_RESISTANCE] = rollingResistance;
  p[Physics.STEER_SPEED]        = steerSpeed;
  p[Physics.GRIP_STATIC]        = gripStatic;
  p[Physics.GRIP_DYNAMIC]       = gripDynamic;
  p[Physics.TURN_RADIUS]        = turnRadius;
  p[Physics.GRAVITY]            = gravity;
  p[Physics.AIR_DRAG]           = airDrag;
  p[Physics.HOVER_TARGET_HEIGHT]= hoverTargetHeight;
  p[Physics.SPRING_STIFFNESS]   = springStiffness;
  p[Physics.SPRING_DAMPENING]   = springDampening;
  p[Physics.BANKING_ANGLE]      = bankingAngle;
  p[Physics.MASS]               = mass;
  return p;
}

export const Physics = {
  // ── Runtime state ──────────────────────────────────────────────────────
  VEL_X:  0, VEL_Y: 1, VEL_Z: 2,
  YAW:    3,
  SPEED:  4,
  // ── Per-vehicle config (set once, read every tick) ─────────────────────
  ENGINE_FORCE:        5,
  BRAKING_FORCE:       6,
  TOP_SPEED:           7,
  DRAG:                8,
  ROLLING_RESISTANCE:  9,
  STEER_SPEED:         10,
  GRIP_STATIC:         11,
  GRIP_DYNAMIC:        12,
  TURN_RADIUS:         13,
  GRAVITY:             14,
  AIR_DRAG:            15,
  HOVER_TARGET_HEIGHT: 16,
  SPRING_STIFFNESS:    17,
  SPRING_DAMPENING:    18,
  BANKING_ANGLE:       19,
  MASS:                20,
} as const;
