import { Quaternion } from '@babylonjs/core';
import { System }           from '../../engine/core/System';
import type { World }        from '../../engine/core/World';
import { Transform, TRANSFORM_STRIDE } from '../components/Transform';
import type { Renderable }  from '../components/Renderable';

/**
 * RenderSystem – the bridge between ECS and Babylon.
 *
 * Reads the flat `Float32Array` transform storage and writes position,
 * rotation and scale into each entity's Babylon `AbstractMesh`.
 *
 * ### Performance contract (no GC in hot path)
 * - Transform data is accessed via `world.getStorage<Float32Array>` so the
 *   entire SoA buffer is touched in a single sequential pass.
 * - `mesh.position.set()`        – mutates in-place, zero allocation.
 * - `mesh.rotationQuaternion.set()` – mutates in-place, zero allocation.
 * - `mesh.scaling.copyFromFloats()` – mutates in-place, zero allocation.
 *   ⚠ Never assign `mesh.scaling = new Vector3(...)` – that allocates
 *   a new object every frame for every entity.
 *
 * ### Debug mode
 * Set `renderSystem.debugMode = true` to enable NaN assertions and
 * future wireframe / bounding-box overlays.
 */
export class RenderSystem extends System {
  // ── Reusable identity Quaternion, allocated once ──────────────────────────
  private readonly _identityQ = Quaternion.Identity();

  // ── System interface ──────────────────────────────────────────────────────

  /**
   * Intentional no-op for the fixed tick.
   *
   * Rendering is variable-rate: `sync(alpha, world)` is called explicitly
   * by the variable callback in `App.run()` immediately before
   * `scene.render()`.  Calling sync here a second time per fixed step would
   * write identical values twice and, at display rates > fixedHz, would
   * produce a brief mid-frame state that Babylon can observe internally,
   * manifesting as a one-pixel jitter on rotating meshes.
   */
  update(_dt: number, _world: World): void {}

  // ── Main sync ─────────────────────────────────────────────────────────────

  /**
   * Synchronises ECS transform data into Babylon mesh transforms.
   *
   * @param _alpha  Interpolation factor [0, 1] reserved for future
   *                render-interpolation between fixed steps.
   * @param world   The ECS world.
   */
  sync(_alpha: number, world: World): void {
    // Grab the full flat buffer once – avoids one Map lookup per entity.
    let xfmBuf: Float32Array;
    let rdrMap: Map<number, Renderable>;
    try {
      xfmBuf = world.getStorage<Float32Array>('transform');
      rdrMap = world.getStorage<Map<number, Renderable>>('renderable');
    } catch {
      // Components not yet registered (pre-first-entity frame) – nothing to do.
      return;
    }

    const stride = world.getStride('transform') ?? TRANSFORM_STRIDE;
    const ids    = world.query(['transform', 'renderable']);

    for (let i = 0; i < ids.length; i++) {
      const e   = ids[i];
      const rdr = rdrMap.get(e);
      if (!rdr?.mesh) continue;

      const base = e * stride;

      // ── Debug assertions (stripped in production by debugMode guard) ──────
      if (this.debugMode) {
        console.assert(
          isFinite(xfmBuf[base + Transform.POS_X]) &&
          isFinite(xfmBuf[base + Transform.POS_Y]) &&
          isFinite(xfmBuf[base + Transform.POS_Z]),
          `RenderSystem: NaN/Inf position on entity ${e}`,
        );
      }

      // ── Position (in-place mutation, zero allocation) ─────────────────────
      rdr.mesh.isVisible = rdr.visible;
      rdr.mesh.position.set(
        xfmBuf[base + Transform.POS_X],
        xfmBuf[base + Transform.POS_Y],
        xfmBuf[base + Transform.POS_Z],
      );

      // ── Rotation quaternion (in-place mutation, zero allocation) ──────────
      //
      // Meshes should have rotationQuaternion pre-initialised to
      // Quaternion.Identity() at creation time (LevelBuilder / index.ts).
      // The guard below is a safety net for meshes spawned by external code.
      //
      // ⚠  Never set mesh.rotation (Euler) after this point: Babylon resets
      //    rotationQuaternion to null whenever mesh.rotation is written,
      //    causing one-frame Euler snap jitter on the next sync call.
      if (!rdr.mesh.rotationQuaternion) {
        rdr.mesh.rotationQuaternion = this._identityQ.clone();
      }
      // Babylon Quaternion.set(x, y, z, w) – matches our buffer layout:
      //   buf[base+4]=ROT_X  buf[base+5]=ROT_Y  buf[base+6]=ROT_Z  buf[base+3]=ROT_W
      rdr.mesh.rotationQuaternion.set(
        xfmBuf[base + Transform.ROT_X],
        xfmBuf[base + Transform.ROT_Y],
        xfmBuf[base + Transform.ROT_Z],
        xfmBuf[base + Transform.ROT_W],
      );

      // ── Scale – copyFromFloats mutates in-place (no `new Vector3`) ────────
      rdr.mesh.scaling.copyFromFloats(
        xfmBuf[base + Transform.SCL_X],
        xfmBuf[base + Transform.SCL_Y],
        xfmBuf[base + Transform.SCL_Z],
      );
    }
  }

  // ── Thin-instance sync ────────────────────────────────────────────────────

  /**
   * Builds a single flat matrix buffer and pushes it to a shared mesh via
   * `thinInstanceSetBuffer`.  Call this for tile / obstacle groups that share
   * the same mesh geometry.
   *
   * TODO (Phase 4): iterate entities with matching `thinInstanceIndex >= 0`,
   * compose the 4×4 matrix from the transform SoA, and call:
   *   `sharedMesh.thinInstanceSetBuffer('matrix', matrixBuffer, 16);`
   */
  syncThinInstances(_world: World): void {
    // Stub – wired up in Phase 4 once tile entities are in place.
  }
}
