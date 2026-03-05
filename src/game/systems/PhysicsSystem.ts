import { System }   from '../../engine/core/System';
import type { World } from '../../engine/core/World';
import { Physics }  from '../components/Physics';
import { Transform } from '../components/Transform';
import type { ColliderData } from '../components/Collider';
import { aabbOverlap, sphereOverlap } from '../components/Collider';
import { eventBus } from '../../engine/core/EventBus';

const GRAVITY = -9.81;

export class PhysicsSystem extends System {
  /**
   * Called at fixed timestep.
   * Reads InputSystem.state via the legacy getter (passed from App)
   * or directly from world's 'input' component when available.
   */
  update(dt: number, world: World): void {
    this.integrate(dt, world);
    this.detectCollisions(world);
  }

  // ── Integration ─────────────────────────────────────────────────────────────────

  private integrate(dt: number, world: World): void {
    const entities = world.query(['physics', 'transform']);
    const { MASS, DRAG, MAX_SPEED, SPEED, VEL_X, VEL_Y, VEL_Z, ACC_X, ACC_Z } = Physics;
    const { POS_X, POS_Y, POS_Z } = Transform;

    for (const id of entities) {
      const phys = world.getComponent<Float32Array>(id, 'physics')!;
      const xfm  = world.getComponent<Float32Array>(id, 'transform')!;

      // Read steering/throttle from InputComponent if present
      const inp   = world.getComponent<{ throttle: number; steering: number; actions: Uint8Array }>(id, 'input');
      const fwd   = inp ? Math.max(0,  inp.throttle) : 0;
      const bwd   = inp ? Math.max(0, -inp.throttle) : 0;
      const right = inp ? Math.max(0,  inp.steering) : 0;
      const left  = inp ? Math.max(0, -inp.steering) : 0;
      const boost = inp ? (inp.actions[0] ? 2 : 1) : 1;

      phys[ACC_X] = right - left;
      phys[ACC_Z] = fwd   - bwd;

      phys[VEL_X] = (phys[VEL_X] + phys[ACC_X] * dt * boost) * (1 - phys[DRAG]);
      phys[VEL_Z] = (phys[VEL_Z] + phys[ACC_Z] * dt * boost) * (1 - phys[DRAG]);
      phys[VEL_Y] = Math.max(phys[VEL_Y] + GRAVITY * dt / phys[MASS], -50);

      const spd = Math.sqrt(phys[VEL_X] ** 2 + phys[VEL_Z] ** 2);
      phys[SPEED] = spd;
      if (spd > phys[MAX_SPEED]) {
        const inv = phys[MAX_SPEED] / spd;
        phys[VEL_X] *= inv;
        phys[VEL_Z] *= inv;
      }

      xfm[POS_X] += phys[VEL_X] * dt;
      xfm[POS_Y] += phys[VEL_Y] * dt;
      xfm[POS_Z] += phys[VEL_Z] * dt;
    }
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
