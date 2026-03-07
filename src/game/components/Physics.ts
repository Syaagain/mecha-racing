/**
 * Physics component – Semi-Arcade racing model.
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
 * │  8  │ dragCoefficient      │ Air drag – velocity *= (1 - drag * dt)      │
 * │  9  │ rollingResistance    │ Constant ground friction decel (m/s²)       │
 * │ 10  │ steerSpeed           │ Base max steering rate (rad/s at v→0)       │
 * │ 11  │ gripStatic           │ Lateral grip factor – normal driving  [0,1] │
 * │ 12  │ gripDynamic          │ Lateral grip during handbrake/drift   [0,1] │
 * │ 13  │ turnRadius           │ Sharpness curve divisor – lower = tighter   │
 * │ 14  │ gravity              │ Downward acceleration (m/s², arcade-tuned)  │
 * │ 15  │ downforce            │ Extra gravity coefficient (scales with v²)  │
 * │ 16  │ suspensionStiffness  │ Bounce damping on landing                   │
 * │ 17  │ mass                 │ kg – used for collision response            │
 * │18-19│ (reserved)           │                                             │
 * └─────┴──────────────────────┴─────────────────────────────────────────────┘
 */
export const PHYSICS_STRIDE = 20;

/**
 * Factory – defaults are tuned for a mid-weight arcade racer.
 * Override individual parameters via named args to differentiate vehicle classes.
 */
export function createPhysics(
  engineForce         = 60,
  brakingForce        = 120,
  topSpeed            = 80,      // m/s ≈ 288 km/h
  dragCoefficient     = 0.03,    // air drag per second
  rollingResistance   = 0.10,   // m/s² constant ground friction
  steerSpeed          = 2.0,    // rad/s max turn rate (at v→0)
  gripStatic          = 0.98,   // 98 % lateral slide removed per frame
  gripDynamic         = 0.45,   // drift grip
  turnRadius          = 8,      // speed divisor for steering curve
  gravity             = 25,     // m/s² (higher than real-life for snappier feel)
  downforce           = 0.001,  // coefficient – F_down = k * v²
  suspensionStiffness = 0.6,
  mass                = 1200,   // kg
): Float32Array {
  const p = new Float32Array(PHYSICS_STRIDE);
  p[Physics.ENGINE_FORCE]          = engineForce;
  p[Physics.BRAKING_FORCE]         = brakingForce;
  p[Physics.TOP_SPEED]             = topSpeed;
  p[Physics.DRAG]                  = dragCoefficient;
  p[Physics.ROLLING_RESISTANCE]    = rollingResistance;
  p[Physics.STEER_SPEED]           = steerSpeed;
  p[Physics.GRIP_STATIC]           = gripStatic;
  p[Physics.GRIP_DYNAMIC]          = gripDynamic;
  p[Physics.TURN_RADIUS]           = turnRadius;
  p[Physics.GRAVITY]               = gravity;
  p[Physics.DOWNFORCE]             = downforce;
  p[Physics.SUSPENSION_STIFFNESS]  = suspensionStiffness;
  p[Physics.MASS]                  = mass;
  return p;
}

export const Physics = {
  STRIDE: PHYSICS_STRIDE,
  // ── Runtime state ──────────────────────────────────────────────────────
  VEL_X:  0, VEL_Y: 1, VEL_Z: 2,
  YAW:    3,
  SPEED:  4,
  // ── Per-vehicle config (set once, read every tick) ─────────────────────
  ENGINE_FORCE:         5,
  BRAKING_FORCE:        6,
  TOP_SPEED:            7,
  DRAG:                 8,
  ROLLING_RESISTANCE:   9,
  STEER_SPEED:          10,
  GRIP_STATIC:          11,
  GRIP_DYNAMIC:         12,
  TURN_RADIUS:          13,
  GRAVITY:              14,
  DOWNFORCE:            15,
  SUSPENSION_STIFFNESS: 16,
  MASS:                 17,
} as const;
