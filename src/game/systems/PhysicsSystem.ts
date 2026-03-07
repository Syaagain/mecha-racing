/**
 * @file PhysicsSystem.ts
 * @module game/systems
 *
 * Hover-Mecha arcade physics system.
 *
 * ## Vertical model -- spring-damper suspension
 * Each tick the nearest track segment is found (O(N) scalar scan, zero GC).
 * When the mecha is within a grace margin of the track footprint a spring-
 * damper pushes it toward HOVER_TARGET_HEIGHT above the surface:
 *
 *   heightError  = targetHeight - (posY - surfaceY)
 *   velY        += (heightError * stiffness  -  velY * dampening) * dt
 *
 * A hard floor clamp prevents clipping. When no segment is underfoot (true
 * air), plain gravity applies and drag switches to AIR_DRAG (much lower).
 *
 * ## Orientation -- yaw + banking
 * The final quaternion is composed from:
 *   A) Yaw   -- heading.
 *   B) Bank  -- lean into the turn: roll proportional to steerInput * speed.
 * Surface-pitch is scaffolded (placeholder = 0) for when ramp segments arrive.
 *
 * ## Horizontal model
 * Identical to the wheeled model but with lower gripStatic (0.82) so the
 * mecha slides visibly around corners.
 *
 * ## Zero-GC guarantee
 * All intermediate values use class-level scratch scalars. No `new` in hot path.
 *
 * ## Coordinate conventions (Babylon.js left-handed Y-up)
 *   fwd = ( sin(yaw), 0, cos(yaw) )
 *   rgt = ( cos(yaw), 0, -sin(yaw) )
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESPAWN_Y_THRESHOLD = -10.0;
const RESPAWN_DROP_HEIGHT  =  2.0;
const FADE_DURATION_S      =  0.3;
const SPAWN_COOLDOWN_S     =  1.0;
const OOB_TRIGGER_DELAY_S  =  0.5;

// ---------------------------------------------------------------------------
// PhysicsSystem
// ---------------------------------------------------------------------------

export class PhysicsSystem extends System {
  // Scratch scalars -- forward/right unit vectors in world space.
  private _fwdX = 0;
  private _fwdZ = 0;
  private _rgtX = 0;
  private _rgtZ = 0;

  private _trackData:    TrackData    | null = null;
  private _trackBuilder: TrackBuilder | null = null;

  private readonly _oobTimer      = new Map<number, number>();
  private readonly _respawnTimer  = new Map<number, number>();
  private readonly _spawnCooldown = new Map<number, number>();

  setTrackBuilder(builder: TrackBuilder): void {
    this._trackBuilder = builder;
    this._trackData    = builder.trackData;
  }

  update(dt: number, world: World): void {
    this.integrateVehicles(dt, world);
    this.detectCollisions(world);
  }

  // ---------------------------------------------------------------------------
  // Integration
  // ---------------------------------------------------------------------------

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

      // -- Respawn freeze ----------------------------------------------------
      if (inp !== null && this._respawnTimer.has(id)) {
        phys[Physics.VEL_Y] = 0;
        const remaining = this._respawnTimer.get(id)! - dt;
        if (remaining <= 0) {
          this._respawnTimer.delete(id);
          this._oobTimer.delete(id);
          this._spawnCooldown.set(id, SPAWN_COOLDOWN_S);
          if (this._trackData) this.respawn(id, phys, xfm, this._trackData, world);
        } else {
          this._respawnTimer.set(id, remaining);
        }
        continue;
      }

      // -- 1. Forward/right unit vectors from current yaw -------------------
      const yaw    = phys[Physics.YAW];
      const sinYaw = Math.sin(yaw);
      const cosYaw = Math.cos(yaw);
      this._fwdX =  sinYaw;  this._fwdZ =  cosYaw;
      this._rgtX =  cosYaw;  this._rgtZ = -sinYaw;

      // -- 2. Decompose velocity into local components ----------------------
      const vx    = phys[Physics.VEL_X];
      const vz    = phys[Physics.VEL_Z];
      let vFwd    = vx * this._fwdX + vz * this._fwdZ;
      let vLat    = vx * this._rgtX + vz * this._rgtZ;
      const speed = Math.sqrt(vx * vx + vz * vz);
      phys[Physics.SPEED] = speed;

      // -- 3. Speed-sensitive steering --------------------------------------
      if (speed > 0.5) {
        const steerRate = phys[Physics.STEER_SPEED]
          / (1 + speed / phys[Physics.TURN_RADIUS]);
        phys[Physics.YAW] = yaw + steerInput * steerRate * dt;
      }

      // -- 4. Longitudinal force (engine / brake) ---------------------------
      if (throttle > 0) {
        vFwd += throttle * phys[Physics.ENGINE_FORCE] * boost * dt;
      } else if (throttle < 0) {
        vFwd += throttle * phys[Physics.BRAKING_FORCE] * dt;
      }

      // -- 5. Spring-damper hover (or gravity if airborne) ------------------
      //
      // Find the nearest track segment by squared XZ distance.
      // When within the segment footprint (+1 m grace), a spring-damper
      // drives the mecha toward HOVER_TARGET_HEIGHT above the surface.
      // When airborne, plain gravity applies.
      let velY     = phys[Physics.VEL_Y];
      let grounded = false;

      if (this._trackData !== null) {
        const td = this._trackData;
        const px = xfm[Transform.POS_X];
        const pz = xfm[Transform.POS_Z];
        const py = xfm[Transform.POS_Y];

        let nearIdx = 0;
        let nearD2  = Infinity;
        for (let i = 0; i < td.count; i++) {
          const ddx = px - td.centers[i * 2];
          const ddz = pz - td.centers[i * 2 + 1];
          const d2  = ddx * ddx + ddz * ddz;
          if (d2 < nearD2) { nearD2 = d2; nearIdx = i; }
        }

        const cx   = td.centers[nearIdx * 2];
        const cz   = td.centers[nearIdx * 2 + 1];
        const segH = td.headings[nearIdx];
        const sinH = Math.sin(segH);
        const cosH = Math.cos(segH);
        const offX = px - cx;
        const offZ = pz - cz;
        const latD = offX * cosH - offZ * sinH;

        if (Math.abs(latD) <= td.halfWidth + 1.0) {
          grounded = true;

          const heightAbove = py - td.surfaceY;
          const heightError = phys[Physics.HOVER_TARGET_HEIGHT] - heightAbove;
          const springForce = heightError * phys[Physics.SPRING_STIFFNESS]
                            - velY        * phys[Physics.SPRING_DAMPENING];
          velY += springForce * dt;

          // Hard floor: never clip through the mesh surface.
          const minY = td.surfaceY + 0.3;
          if (xfm[Transform.POS_Y] + velY * dt < minY) {
            xfm[Transform.POS_Y] = minY;
            if (velY < 0) velY = 0;
          }
        }
      }

      // -- 6. Gravity (airborne only) ---------------------------------------
      if (!grounded) {
        velY = Math.max(velY - phys[Physics.GRAVITY] * dt, -50);
      }
      phys[Physics.VEL_Y] = velY;

      // -- 7. Drag -- lower coefficient when airborne (floaty mecha feel) ---
      const dragCoeff = grounded ? phys[Physics.DRAG] : phys[Physics.AIR_DRAG];
      vFwd *= 1 - dragCoeff * dt;

      // -- 8. Rolling resistance (grounded only) ----------------------------
      if (grounded) {
        const rollDelta = phys[Physics.ROLLING_RESISTANCE] * dt;
        if (Math.abs(vFwd) > rollDelta) vFwd -= Math.sign(vFwd) * rollDelta;
        else                             vFwd  = 0;
      }

      // -- 9. Top-speed cap -------------------------------------------------
      const topSpd = phys[Physics.TOP_SPEED];
      if (Math.abs(vFwd) > topSpd) vFwd = Math.sign(vFwd) * topSpd;

      // -- 10. Lateral grip (mecha slides more than a wheeled car) ----------
      const grip       = handbrake ? phys[Physics.GRIP_DYNAMIC] : phys[Physics.GRIP_STATIC];
      const gripFactor = Math.pow(grip, dt * 60);
      vLat *= gripFactor;

      // -- 11. Recompose world-space velocity --------------------------------
      phys[Physics.VEL_X] = this._fwdX * vFwd + this._rgtX * vLat;
      phys[Physics.VEL_Z] = this._fwdZ * vFwd + this._rgtZ * vLat;

      // -- 12. Position integration -----------------------------------------
      xfm[Transform.POS_X] += phys[Physics.VEL_X] * dt;
      xfm[Transform.POS_Y] += phys[Physics.VEL_Y] * dt;
      xfm[Transform.POS_Z] += phys[Physics.VEL_Z] * dt;

      // -- 13. Orientation: yaw + banking -----------------------------------
      //
      // Final quaternion = qYaw * qBank (Hamilton product of two pure-axis
      // rotations, expanded to scalar arithmetic -- zero allocation).
      //
      //   qYaw  = ( cos(yaw/2),  0,         sin(yaw/2),  0       )  [Y-axis]
      //   qBank = ( cos(b/2),    0,          0,           sin(b/2))  [Z-axis]
      //
      //   qResult = qYaw * qBank:
      //     rw = Yw*Bw
      //     rx = Yy*Bz          (cross Y-axis x Z-axis)
      //     ry = Yy*Bw
      //     rz = Yw*Bz
      //
      // Banking: lean INTO the turn -- negative roll for rightward steer.
      //   bankAngle = -maxBank * steerInput * clamp(speed/(topSpeed*0.4), 0,1)
      const newYaw = phys[Physics.YAW];
      const hYaw   = newYaw * 0.5;
      const qYw    = Math.cos(hYaw);
      const qYy    = Math.sin(hYaw);

      const bankAngle = -phys[Physics.BANKING_ANGLE]
                       * steerInput
                       * Math.min(speed / Math.max(topSpd * 0.4, 1), 1);
      const hBank  = bankAngle * 0.5;
      const qBw    = Math.cos(hBank);
      const qBz    = Math.sin(hBank);

      xfm[Transform.ROT_W] = qYw * qBw;
      xfm[Transform.ROT_X] = qYy * qBz;
      xfm[Transform.ROT_Y] = qYy * qBw;
      xfm[Transform.ROT_Z] = qYw * qBz;

      if (this.debugMode) {
        console.assert(isFinite(phys[Physics.VEL_X]),  `PhysicsSystem: NaN vx  on entity ${id}`);
        console.assert(isFinite(phys[Physics.VEL_Z]),  `PhysicsSystem: NaN vz  on entity ${id}`);
        console.assert(isFinite(phys[Physics.YAW]),    `PhysicsSystem: NaN yaw on entity ${id}`);
        console.assert(isFinite(phys[Physics.SPEED]),  `PhysicsSystem: NaN spd on entity ${id}`);
      }

      // -- 14. OOB detection -----------------------------------------------
      if (inp !== null && this._trackData !== null) {
        const cd = this._spawnCooldown.get(id);
        if (cd !== undefined) {
          const ncd = cd - dt;
          if (ncd <= 0) this._spawnCooldown.delete(id);
          else          this._spawnCooldown.set(id, ncd);
        } else {
          this.checkRespawn(id, phys, xfm, dt);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // OOB / Respawn helpers
  // ---------------------------------------------------------------------------

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

    if (py < RESPAWN_Y_THRESHOLD) {
      this._oobTimer.delete(id);
      this.scheduleRespawn(id, phys);
      return;
    }

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

  private scheduleRespawn(id: number, phys: Float32Array): void {
    phys[Physics.VEL_X] = 0;
    phys[Physics.VEL_Y] = 0;
    phys[Physics.VEL_Z] = 0;
    phys[Physics.SPEED] = 0;
    this._respawnTimer.set(id, FADE_DURATION_S);
    eventBus.publish('PLAYER_FELL', { entityId: id });
    console.debug(`[PhysicsSystem] entity ${id}: OOB respawn in ${FADE_DURATION_S * 1000} ms.`);
  }

  private respawn(
    id:    number,
    phys:  Float32Array,
    xfm:   Float32Array,
    td:    TrackData,
    world: World,
  ): void {
    const headSlot   = this._trackBuilder?.headIdx ?? 0;
    const respawnX   = td.centers[headSlot * 2];
    const respawnZ   = td.centers[headSlot * 2 + 1];
    const respawnYaw = td.headings[headSlot];

    phys[Physics.SPEED] = 0;
    phys[Physics.YAW]   = respawnYaw;

    xfm[Transform.POS_X] = respawnX;
    xfm[Transform.POS_Y] = td.surfaceY + RESPAWN_DROP_HEIGHT;
    xfm[Transform.POS_Z] = respawnZ;

    const halfYaw        = respawnYaw * 0.5;
    xfm[Transform.ROT_W] = Math.cos(halfYaw);
    xfm[Transform.ROT_X] = 0;
    xfm[Transform.ROT_Y] = Math.sin(halfYaw);
    xfm[Transform.ROT_Z] = 0;

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

    console.debug(`[PhysicsSystem] entity ${id}: respawned at head ${headSlot} (${respawnX.toFixed(1)}, ${(td.surfaceY + RESPAWN_DROP_HEIGHT).toFixed(1)}, ${respawnZ.toFixed(1)}).`);
    eventBus.publish('PLAYER_RESPAWN', { entityId: id });
  }

  // ---------------------------------------------------------------------------
  // Collision detection
  // ---------------------------------------------------------------------------

  private detectCollisions(world: World): void {
    const collidables = world.query(['collider', 'transform']);
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
          eventBus.publish('collision', { a: idA, b: idB });

          const physA = world.getComponent<Float32Array>(idA, 'physics');
          const physB = world.getComponent<Float32Array>(idB, 'physics');

          const overlapX = (colA.hx + colB.hx) - Math.abs(ax - bx);
          const overlapY = (colA.hy + colB.hy) - Math.abs(ay - by);
          const overlapZ = (colA.hz + colB.hz) - Math.abs(az - bz);

          if (overlapY <= overlapX && overlapY <= overlapZ) {
            if (physA && ay > by && physA[Physics.VEL_Y] < 0) {
              physA[Physics.VEL_Y]   = 0;
              xfmA[Transform.POS_Y] = by + colB.hy + colA.hy;
            }
            if (physB && by > ay && physB[Physics.VEL_Y] < 0) {
              physB[Physics.VEL_Y]   = 0;
              xfmB[Transform.POS_Y] = ay + colA.hy + colB.hy;
            }
          } else {
            if (physA) { physA[Physics.VEL_X] *= -0.5; physA[Physics.VEL_Z] *= -0.5; }
            if (physB) { physB[Physics.VEL_X] *= -0.5; physB[Physics.VEL_Z] *= -0.5; }
          }
        }
      }
    }
  }
}
