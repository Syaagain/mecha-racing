/**
 * @file PhysicsSystem.ts
 * @module game/systems
 *
 * Semi-arcade vehicle physics system.
 *
 * ## Physics model (local-frame decomposition)
 * Each tick the world-space velocity is decomposed into a **forward** component
 * (`vFwd`) and a **lateral** component (`vLat`) relative to the vehicle's
 * current heading (YAW).  Forces are applied in local space and the result is
 * recomposed into a world-space velocity vector before integration.
 *
 * ### Force pipeline (per vehicle per tick)
 * 1. Compute local forward / right unit vectors from YAW.
 * 2. Decompose velocity: `vFwd = vel · fwd`, `vLat = vel · rgt`.
 * 3. Speed-sensitive steering: `dYaw = steering × steerSpeed × (1 − speed/topSpeed)`.
 * 4. Engine force applied along forward axis; braking deceleration.
 * 5. Aerodynamic drag: `vFwd *= (1 − drag × dt)`  (framerate-independent).
 * 6. Rolling resistance: constant decel applied when |vFwd| > 0.
 * 7. Top-speed clamp.
 * 8. Lateral grip: `vLat *= gripStatic^(dt×60)` (normal) or `gripDynamic`
 *    (handbrake drift).  Framerate-independent via exponent scaling.
 * 9. Recompose `vel = vFwd×fwd + vLat×rgt`.
 * 10. Gravity + downforce, position integration, heading → quaternion sync.
 *
 * ## Track floor enforcement
 * `enforceTrackFloor()` scans all TRACK_WINDOW_SIZE segments, finds the
 * nearest one whose footprint contains the vehicle's XZ position (dot-product
 * overlap test), and snaps the vehicle's Y to the surface when it falls below.
 *
 * ## Respawn
 * `checkRespawn()` detects when the vehicle falls below Y < −10 or drifts
 * more than `halfWidth + 1.5 m` from every segment, then teleports it back to
 * the track spawn point.
 *
 * ## Coordinate conventions (Babylon left-handed Y-up)
 * - +Z = forward at YAW = 0.
 * - `fwd = (sin(yaw), 0, cos(yaw))`,  `rgt = (cos(yaw), 0, −sin(yaw))`.
 */
import { System }             from '../../engine/core/System';
import type { World }          from '../../engine/core/World';
import { Physics }             from '../components/Physics';
import { Transform }           from '../components/Transform';
import type { InputComponent } from '../components/Input';
import type { ColliderData }   from '../components/Collider';
import { aabbOverlap, sphereOverlap } from '../components/Collider';
import { eventBus }           from '../../engine/core/EventBus';
import type { TrackData }      from '../world/TrackBuilder';
import type { TrackBuilder }   from '../world/TrackBuilder';
import type { Renderable }     from '../components/Renderable';

// ── Respawn / OOB constants ────────────────────────────────────────────────

/** Car must fall below this Y before an immediate respawn is triggered (m). */
const RESPAWN_Y_THRESHOLD  = -10.0;

/**
 * How many metres above the track surface the car is placed after teleport.
 * The drop ensures `enforceTrackFloor` registers the car as grounded within
 * the first physics tick.
 */
const RESPAWN_DROP_HEIGHT  =   2.0;

/**
 * Duration of the physics freeze that hides the teleport snap (seconds).
 * Must be kept in sync with the CSS transition in index.ts (FADE_DURATION_MS).
 */
const FADE_DURATION_S      =   0.3;

/** Immunity window after a teleport — prevents double-triggering (seconds). */
const SPAWN_COOLDOWN_S     =   1.0;

/**
 * How long the car must remain outside the track boundary before a lateral
 * OOB respawn fires.  Prevents accidental resets during jumps (seconds).
 */
const OOB_TRIGGER_DELAY_S  =   0.5;

/**
 * PhysicsSystem – Semi-Arcade racing model.
 *
 * ## Force decomposition per vehicle entity
 * The world-space velocity is split into two local components each tick:
 *
 *   vFwd  – along the vehicle's heading (forward/backward).
 *   vLat  – perpendicular to the heading (sideways slide).
 *
 * Each component is treated independently, then recomposed into world space.
 * This gives the "on-rails" feel of a proper arcade racer: the car carves
 * corners rather than sliding like a puck.
 *
 * ## Zero-GC guarantee
 * All intermediate vectors use the class-level scratch fields (_fwdX, etc.).
 * No `new Vector3` or temporary objects are created in the hot path.
 */
export class PhysicsSystem extends System {
  // ── Scratch vectors (allocated once, reused every tick) ──────────────────
  private _fwdX = 0;  // forward unit-vector X component (world space)
  private _fwdZ = 0;  // forward unit-vector Z component
  private _rgtX = 0;  // right unit-vector X component
  private _rgtZ = 0;  // right unit-vector Z component

  // ── Track data & builder for OOB detection / respawn ──────────────────────
  private _trackData:    TrackData    | null = null;
  private _trackBuilder: TrackBuilder | null = null;

  // ── Per-entity respawn state (keyed by entity ID) ────────────────────────
  /** Lateral OOB accumulator (seconds).  Cleared when car returns to track. */
  private readonly _oobTimer      = new Map<number, number>();
  /** Freeze countdown (seconds).  Entity runs no physics while this exists. */
  private readonly _respawnTimer  = new Map<number, number>();
  /** Post-teleport immunity (seconds).  OOB check is skipped while > 0. */
  private readonly _spawnCooldown = new Map<number, number>();

  /**
   * Provide the TrackBuilder to enable out-of-bounds detection and correct
   * floor snapping after segment recycling.  Call once after LevelBuilder.build().
   *
   * Internally stores both the builder (for the live `headIdx`) and its
   * `trackData` reference (for the SoA arrays), so no further calls are needed.
   */
  setTrackBuilder(builder: TrackBuilder): void {
    this._trackBuilder = builder;
    this._trackData    = builder.trackData;
  }

  update(dt: number, world: World): void {
    this.integrateVehicles(dt, world);
    this.detectCollisions(world);
  }

  // ── Integration ───────────────────────────────────────────────────────────

  private integrateVehicles(dt: number, world: World): void {
    const entities = world.query(['physics', 'transform']);

    for (const id of entities) {
      const phys = world.getComponent<Float32Array>(id, 'physics')!;
      const xfm  = world.getComponent<Float32Array>(id, 'transform')!;
      const inp  = world.getComponent<InputComponent>(id, 'input');

      const throttle   = inp?.throttle  ?? 0;
      const steerInput = inp?.steering  ?? 0;
      const handbrake  = inp?.handbrake ?? 0;
      const boost      = (inp?.actions[0] ?? 0) ? 1.5 : 1.0;

      // ── Respawn freeze ───────────────────────────────────────────────────
      // While _respawnTimer is active the screen is fading to black.
      // Velocity is already zeroed by scheduleRespawn; re-zero VEL_Y each
      // tick as the only guard against gravity accumulation during the hold.
      // All other physics (gravity, integration, floor snap) is skipped.
      if (inp !== null && this._respawnTimer.has(id)) {
        phys[Physics.VEL_Y] = 0; // suppress gravity accumulation during fade
        const remaining = this._respawnTimer.get(id)! - dt;
        if (remaining <= 0) {
          this._respawnTimer.delete(id);
          this._oobTimer.delete(id);
          this._spawnCooldown.set(id, SPAWN_COOLDOWN_S);
          if (this._trackData) this.respawn(id, phys, xfm, this._trackData, world);
        } else {
          this._respawnTimer.set(id, remaining);
        }
        continue; // skip gravity, integration, floor snap — car is frozen
      }

      // ── 1. Forward & right unit vectors from current yaw ────────────────
      // Babylon.js coordinate system: LEFT-HANDED, Y-up.
      //   +X = right,  +Y = up,  +Z = forward (into scene).
      //
      // YAW convention: yaw = 0 → vehicle faces +Z.
      //   Positive yaw = CLOCKWISE from above (+Y view):
      //     yaw = 0    → fwd = (  0, 0,  1 ) = +Z  (north / forward)
      //     yaw = π/2  → fwd = (  1, 0,  0 ) = +X  (east  / right)
      //     yaw = π    → fwd = (  0, 0, -1 ) = –Z  (south / backward)
      //
      //   fwd = ( sin(yaw),  0,  cos(yaw) )
      //   rgt = ( cos(yaw),  0, –sin(yaw) )   ← 90° clockwise from fwd
      //
      // W → throttle = +1 → vFwd increases → VEL_Z += → POS_Z increases.
      // Camera is behind the vehicle (Camera rotationOffset = 180°),
      // so +Z motion appears as forward on screen. ✓
      const yaw    = phys[Physics.YAW];
      const sinYaw = Math.sin(yaw);
      const cosYaw = Math.cos(yaw);
      this._fwdX =  sinYaw;  this._fwdZ =  cosYaw;
      this._rgtX =  cosYaw;  this._rgtZ = -sinYaw;

      // ── 2. Decompose current velocity into local components ──────────────
      const vx    = phys[Physics.VEL_X];
      const vz    = phys[Physics.VEL_Z];
      let vFwd    = vx * this._fwdX + vz * this._fwdZ;
      let vLat    = vx * this._rgtX + vz * this._rgtZ;
      const speed = Math.sqrt(vx * vx + vz * vz);
      phys[Physics.SPEED] = speed;

      // ── 3. Speed-sensitive steering ─────────────────────────────────────
      // turnRate = steerSpeed / (1 + speed / turnRadius)
      // → fast at low speed, progressively slower at high speed.
      // Only rotate when there is meaningful forward motion so the car
      // doesn't spin in place when stationary.
      if (speed > 0.5) {
        const steerRate = phys[Physics.STEER_SPEED]
          / (1 + speed / phys[Physics.TURN_RADIUS]);
        phys[Physics.YAW] = yaw + steerInput * steerRate * dt;
      }

      // ── 4. Longitudinal force (engine / brake) ───────────────────────────
      if (throttle > 0) {
        // Throttle – engine force, multiplied by boost modifier.
        vFwd += throttle * phys[Physics.ENGINE_FORCE] * boost * dt;
      } else if (throttle < 0) {
        // Brake / reverse – braking force is deliberately stronger than engine
        // so the car stops quickly and can reverse at reduced speed.
        vFwd += throttle * phys[Physics.BRAKING_FORCE] * dt;
      }

      // ── 5. Drag – velocity *= (1.0 - dragCoefficient * dt) ──────────────
      // Applied to longitudinal velocity; models air resistance.
      // Linear approximation – a small value (0.02–0.05) removes a % of
      // speed each second, letting rolling resistance handle final stopping.
      vFwd *= 1 - phys[Physics.DRAG] * dt;

      // ── 6. Rolling resistance ────────────────────────────────────────────
      // Constant deceleration opposing direction of travel, always present
      // even when throttle is released.  Guards against sub-step oscillation.
      const rollDelta = phys[Physics.ROLLING_RESISTANCE] * dt;
      if (Math.abs(vFwd) > rollDelta) {
        vFwd -= Math.sign(vFwd) * rollDelta;
      } else {
        vFwd = 0;
      }

      // ── 7. Top speed cap ─────────────────────────────────────────────────
      // Hard clamp on longitudinal speed; downforce slightly raises effective
      // cap to reward skilled driving at full throttle (optional tuning).
      const topSpd = phys[Physics.TOP_SPEED];
      if (Math.abs(vFwd) > topSpd) vFwd = Math.sign(vFwd) * topSpd;

      // ── 8. Lateral grip ──────────────────────────────────────────────────
      // Exponentiates the grip multiplier to be framerate-independent:
      //   gripFactor = grip ^ (dt * 60)  →  same feel at 30/60/120 Hz.
      //
      // gripStatic (≈0.98): 98% of sideways velocity removed each reference
      //   frame – car carves corners, virtually no puck-on-ice sliding.
      // gripDynamic (≈0.40–0.60): handbrake reduces grip, rear swings out.
      const grip       = handbrake ? phys[Physics.GRIP_DYNAMIC] : phys[Physics.GRIP_STATIC];
      const gripFactor = Math.pow(grip, dt * 60);
      vLat *= gripFactor;

      // ── 9. Recompose world-space velocity ────────────────────────────────
      phys[Physics.VEL_X] = this._fwdX * vFwd + this._rgtX * vLat;
      phys[Physics.VEL_Z] = this._fwdZ * vFwd + this._rgtZ * vLat;

      // ── 10. Vertical integration (gravity + downforce) ───────────────────
      // Downforce adds to gravity proportionally to v² → sticks to ground
      // at high speed (Forza-lite feel), caps free-fall at –50 m/s.
      const gravAccel     = phys[Physics.GRAVITY]
        + phys[Physics.DOWNFORCE] * speed * speed;
      phys[Physics.VEL_Y] = Math.max(phys[Physics.VEL_Y] - gravAccel * dt, -50);

      // ── 11. Position integration ──────────────────────────────────────────
      xfm[Transform.POS_X] += phys[Physics.VEL_X] * dt;
      xfm[Transform.POS_Y] += phys[Physics.VEL_Y] * dt;
      xfm[Transform.POS_Z] += phys[Physics.VEL_Z] * dt;

      // ── 11b. Fake floor – track segment support ───────────────────────────
      // Thin-instance meshes have no Babylon physics impostor, so gravity
      // would pull the vehicle through the floor without this explicit check.
      // For each physics entity we find the nearest track segment and, if the
      // entity’s XZ footprint overlaps that segment, clamp POS_Y to the
      // track’s surface + the entity’s collider half-height.
      //
      // ColliderData.hy is queried once per tick; no allocation required.
      if (this._trackData !== null) {
        const col = world.getComponent<ColliderData>(id, 'collider');
        const vehicleHalfH = col ? col.hy : 0.5;
        this.enforceTrackFloor(phys, xfm, vehicleHalfH);
      }

      // ── 12. Sync heading → Transform quaternion (pure Y-axis rotation) ───
      // q = ( cos(θ/2), 0, sin(θ/2), 0 )  ⇒  ROT_W = cos, ROT_Y = sin
      // Written once per tick; RenderSystem reads it without any conversion.
      const halfYaw = phys[Physics.YAW] * 0.5;
      xfm[Transform.ROT_W] = Math.cos(halfYaw);
      xfm[Transform.ROT_X] = 0;
      xfm[Transform.ROT_Y] = Math.sin(halfYaw);
      xfm[Transform.ROT_Z] = 0;

      if (this.debugMode) {
        console.assert(isFinite(phys[Physics.VEL_X]),  `PhysicsSystem: NaN vx  on entity ${id}`);
        console.assert(isFinite(phys[Physics.VEL_Z]),  `PhysicsSystem: NaN vz  on entity ${id}`);
        console.assert(isFinite(phys[Physics.YAW]),    `PhysicsSystem: NaN yaw on entity ${id}`);
        console.assert(isFinite(phys[Physics.SPEED]),  `PhysicsSystem: NaN spd on entity ${id}`);
      }

      // ── 13. Out-of-bounds detection ───────────────────────────────────────
      // Only player-controlled entities (InputComponent present) are checked.
      // Skipped entirely during the spawn-immunity window.
      if (inp !== null && this._trackData !== null) {
        const cd = this._spawnCooldown.get(id);
        if (cd !== undefined) {
          // Decrement immunity and keep skipping OOB this tick.
          const ncd = cd - dt;
          if (ncd <= 0) this._spawnCooldown.delete(id);
          else this._spawnCooldown.set(id, ncd);
        } else {
          this.checkRespawn(id, phys, xfm, dt);
        }
      }
    }
  }

  // ── Track floor helper ─────────────────────────────────────────────────────────────

  /**
   * Snap the entity’s Y position to the track surface when it would otherwise
   * sink through a thin-instance segment.
   *
   * ## Algorithm (Zero-GC)
   * 1. Find the nearest segment centre by squared XZ distance (linear scan).
   * 2. Project the entity offset onto the segment’s local forward and right
   *    vectors using dot products – both are pure scalar arithmetic on already
   *    computed sin/cos values, no allocation.
   * 3. If the entity is within [halfWidth × segmentHalfLen] AND below the
   *    floor line, clamp POS_Y and zero any downward VEL_Y.
   */
  private enforceTrackFloor(
    phys:         Float32Array,
    xfm:          Float32Array,
    vehicleHalfH: number,
  ): void {
    const td = this._trackData!;
    const px = xfm[Transform.POS_X];
    const pz = xfm[Transform.POS_Z];

    // Step 1: nearest segment by squared XZ distance.
    let nearIdx = 0;
    let nearD2  = Infinity;
    for (let i = 0; i < td.count; i++) {
      const dx = px - td.centers[i * 2];
      const dz = pz - td.centers[i * 2 + 1];
      const d2 = dx * dx + dz * dz;
      if (d2 < nearD2) { nearD2 = d2; nearIdx = i; }
    }

    // Step 2: local forward / lateral extents.
    const cx   = td.centers[nearIdx * 2];
    const cz   = td.centers[nearIdx * 2 + 1];
    const h    = td.headings[nearIdx];
    const sinH = Math.sin(h);
    const cosH = Math.cos(h);
    const dx   = px - cx;
    const dz   = pz - cz;
    //   fwd component: dot( offset, forwardVec )  where fwd = (sinH, 0, cosH)
    const fwdDist = dx * sinH + dz * cosH;
    //   lat component: dot( offset, rightVec   )  where rgt = (cosH, 0,-sinH)
    const latDist = dx * cosH + dz * (-sinH);

    // Step 3: clamp Y when inside segment footprint and below surface.
    if (
      Math.abs(fwdDist) <= td.segmentHalfLen &&
      Math.abs(latDist) <= td.halfWidth
    ) {
      const floorY = td.surfaceY + vehicleHalfH;
      if (xfm[Transform.POS_Y] < floorY) {
        xfm[Transform.POS_Y]  = floorY;
        if (phys[Physics.VEL_Y] < 0) phys[Physics.VEL_Y] = 0;
      }
    }
  }

  // u{2500}u{2500} Out-of-bounds helpers u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}u{2500}

  /**
   * Sample the vehicle's position every tick and accumulate off-track time.
   *
   * - **Condition A** (Y < `RESPAWN_Y_THRESHOLD`): triggers a respawn immediately.
   * - **Condition B** (lateral OOB): only schedules after OOB_TRIGGER_DELAY_S seconds.
   *
   * Zero-GC guarantee: only scalar arithmetic on pre-allocated Float32Arrays.
   */
  private checkRespawn(
    id:   number,
    phys: Float32Array,
    xfm:  Float32Array,
    dt:   number,
  ): void {
    const td = this._trackData!;
    const px = xfm[Transform.POS_X];
    const pz = xfm[Transform.POS_Z];
    const py = xfm[Transform.POS_Y];

    // Condition A: fell below the hard Y threshold.
    if (py < RESPAWN_Y_THRESHOLD) {
      this._oobTimer.delete(id);
      this.scheduleRespawn(id, phys);
      return;
    }

    // Condition B: lateral distance > halfWidth + 1.5 m grace margin.
    let nearestIdx   = 0;
    let nearestDist2 = Infinity;
    for (let i = 0; i < td.count; i++) {
      const cx = td.centers[i * 2];
      const cz = td.centers[i * 2 + 1];
      const d2 = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
      if (d2 < nearestDist2) { nearestDist2 = d2; nearestIdx = i; }
    }
    const h       = td.headings[nearestIdx];
    const cx      = td.centers[nearestIdx * 2];
    const cz      = td.centers[nearestIdx * 2 + 1];
    const latDist = Math.abs(
      (px - cx) * Math.cos(h) + (pz - cz) * (-Math.sin(h)),
    );
    if (latDist > td.halfWidth + 1.5) {
      const accum = (this._oobTimer.get(id) ?? 0) + dt;
      if (accum >= OOB_TRIGGER_DELAY_S) {
        this._oobTimer.delete(id);
        this.scheduleRespawn(id, phys);
      } else {
        this._oobTimer.set(id, accum);
      }
    } else {
      this._oobTimer.delete(id);
    }
  }

  /**
   * Zero velocity, start the freeze timer, and publish PLAYER_FELL.
   * The actual teleport fires when the countdown expires in integrateVehicles.
   */
  private scheduleRespawn(id: number, phys: Float32Array): void {
    phys[Physics.VEL_X] = 0;
    phys[Physics.VEL_Y] = 0;
    phys[Physics.VEL_Z] = 0;
    phys[Physics.SPEED] = 0;
    phys[18]            = 0;
    phys[19]            = 0;
    this._respawnTimer.set(id, FADE_DURATION_S);
    eventBus.publish('PLAYER_FELL', { entityId: id });
    console.debug(`[PhysicsSystem] entity ${id}: OOB \u2014 respawn in ${FADE_DURATION_S * 1000} ms.`);
  }

  private respawn(
    id:    number,
    phys:  Float32Array,
    xfm:   Float32Array,
    td:    TrackData,
    world: World,
  ): void {
    // ── 1. Resolve respawn destination ───────────────────────────────────────
    // Use the CURRENT head segment (oldest surviving tile, always just behind
    // the player) rather than a fixed world-space anchor.  After recycleNext()
    // is called, the original segment-0 tile no longer exists at its initial
    // coordinates — landing there would put the car in a floor-less gap.
    // headIdx always points to a tile that is live in the thin-instance buffer.
    const headSlot   = this._trackBuilder?.headIdx ?? 0;
    const respawnX   = td.centers[headSlot * 2];
    const respawnZ   = td.centers[headSlot * 2 + 1];
    const respawnYaw = td.headings[headSlot];

    // ── 2. Clear residual / reserved physics slots ───────────────────────────
    // VEL_X/Y/Z are already zeroed by scheduleRespawn and held at zero by the
    // freeze block.  Only SPEED and the two reserved slots need clearing here.
    phys[Physics.SPEED] = 0;
    phys[18]            = 0;
    phys[19]            = 0;
    phys[Physics.YAW]   = respawnYaw;

    // ── 3. Position — safety drop above the live respawn tile ────────────────
    xfm[Transform.POS_X] = respawnX;
    xfm[Transform.POS_Y] = td.surfaceY + RESPAWN_DROP_HEIGHT;
    xfm[Transform.POS_Z] = respawnZ;

    // ── 4. Sync quaternion from new heading ───────────────────────────────────
    const halfYaw        = respawnYaw * 0.5;
    xfm[Transform.ROT_W] = Math.cos(halfYaw);
    xfm[Transform.ROT_X] = 0;
    xfm[Transform.ROT_Y] = Math.sin(halfYaw);
    xfm[Transform.ROT_Z] = 0;

    // ── 5. Force Babylon world matrix to new position ─────────────────────────
    // Without this the renderer reads the old cached matrix for one frame,
    // producing a visible ghost at the fall position even after fade-in.
    const rdr = world.getComponent<Renderable>(id, 'renderable');
    if (rdr?.mesh) {
      rdr.mesh.position.set(
        xfm[Transform.POS_X],
        xfm[Transform.POS_Y],
        xfm[Transform.POS_Z],
      );
      rdr.mesh.rotationQuaternion?.set(
        xfm[Transform.ROT_X],
        xfm[Transform.ROT_Y],
        xfm[Transform.ROT_Z],
        xfm[Transform.ROT_W],
      );
      rdr.mesh.computeWorldMatrix(true);
    }

    console.debug(`[PhysicsSystem] entity ${id}: respawned at head segment ${headSlot} (${respawnX.toFixed(1)}, ${(td.surfaceY + RESPAWN_DROP_HEIGHT).toFixed(1)}, ${respawnZ.toFixed(1)}).`);
    eventBus.publish('PLAYER_RESPAWN', { entityId: id });
  }

  // ── Collision Detection ─────────────────────────────────────────────────────────

  private detectCollisions(world: World): void {
    const collidables = world.query(['collider', 'transform']);
    for (const id of collidables) {
      const col = world.getComponent<ColliderData>(id, 'collider')!;
      col.isColliding = false;
      col.hitEntity   = -1;
    }
    for (let i = 0; i < collidables.length; i++) {
      for (let j = i + 1; j < collidables.length; j++) {
        const idA = collidables[i], idB = collidables[j];
        const colA = world.getComponent<ColliderData>(idA, 'collider')!;
        const colB = world.getComponent<ColliderData>(idB, 'collider')!;
        const xfmA = world.getComponent<Float32Array>(idA, 'transform')!;
        const xfmB = world.getComponent<Float32Array>(idB, 'transform')!;
        const ax = xfmA[Transform.POS_X], ay = xfmA[Transform.POS_Y], az = xfmA[Transform.POS_Z];
        const bx = xfmB[Transform.POS_X], by = xfmB[Transform.POS_Y], bz = xfmB[Transform.POS_Z];
        const hit = colA.kind === 'aabb' && colB.kind === 'aabb'
          ? aabbOverlap(ax, ay, az, colA, bx, by, bz, colB)
          : colA.kind === 'sphere' && colB.kind === 'sphere'
            ? sphereOverlap(ax, ay, az, colA.radius, bx, by, bz, colB.radius)
            : false;
        if (hit) {
          colA.isColliding = true; colA.hitEntity = idB;
          colB.isColliding = true; colB.hitEntity = idA;
          eventBus.publish('collision', { a: idA, b: idB });

          const physA = world.getComponent<Float32Array>(idA, 'physics');
          const physB = world.getComponent<Float32Array>(idB, 'physics');

          // Determine dominant collision axis so vertical hits (floor/ceiling)
          // are separated from horizontal hits (side walls).
          const overlapX = (colA.hx + colB.hx) - Math.abs(ax - bx);
          const overlapY = (colA.hy + colB.hy) - Math.abs(ay - by);
          const overlapZ = (colA.hz + colB.hz) - Math.abs(az - bz);

          if (overlapY <= overlapX && overlapY <= overlapZ) {
            // ── Vertical (floor / ceiling) ──────────────────────────────────
            // A is above B (vehicle landing on tile): stop downward velocity
            // and snap to the surface so gravity cannot accumulate.
            if (physA && ay > by && physA[Physics.VEL_Y] < 0) {
              physA[Physics.VEL_Y]   = 0;
              xfmA[Transform.POS_Y] = by + colB.hy + colA.hy;
            }
            // B is above A (symmetric, for future two-physics-body stacking):
            if (physB && by > ay && physB[Physics.VEL_Y] < 0) {
              physB[Physics.VEL_Y]   = 0;
              xfmB[Transform.POS_Y] = ay + colA.hy + colB.hy;
            }
          } else {
            // ── Horizontal (side wall) ───────────────────────────────────────
            if (physA) { physA[Physics.VEL_X] *= -0.5; physA[Physics.VEL_Z] *= -0.5; }
            if (physB) { physB[Physics.VEL_X] *= -0.5; physB[Physics.VEL_Z] *= -0.5; }
          }
        }
      }
    }
  }
}
