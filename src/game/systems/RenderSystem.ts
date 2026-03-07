/**
 * @file RenderSystem.ts
 * @module game/systems
 *
 * Bridges the ECS Transform component with the Babylon.js scene graph for
 * visual rendering.
 *
 * ## Split-tick design
 * The game loop runs at two frequencies:
 * - **Fixed 60 Hz** — `update()` runs ECS logic (input, physics, camera).
 *   `RenderSystem.update()` is intentionally a **no-op**; transforms are
 *   already written by PhysicsSystem at this step.
 * - **Variable frame rate** — `sync(alpha, world)` is called once per
 *   browser frame before `scene.render()`.  It copies the latest ECS
 *   position/rotation/scale into Babylon mesh properties.
 *
 * ## Interpolation
 * `alpha` (0–1) is the fractional position between the last two fixed ticks.
 * Currently positions are copied without interpolation (alpha is accepted for
 * future sub-tick smoothing).  Adding lerp here would eliminate visual
 * judder at display refresh rates above 60 Hz.
 *
 * ## Zero-GC guarantee
 * All Babylon setters (`position.set`, `rotationQuaternion.set`,
 * `scaling.copyFromFloats`) mutate existing objects in-place — no temporary
 * `Vector3` or `Quaternion` allocations occur per frame.
 */
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

  // ── Render-interpolation snapshot ────────────────────────────────────────
  // _prevBuf holds the transform SoA as it was at the START of the last
  // fixed physics tick (captured by snapshot() before world.tick() runs).
  // sync(alpha) lerps between _prevBuf and the current buffer so rendering
  // is smooth at any display refresh rate without changing fixedHz.
  private _prevBuf: Float32Array | null = null;

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
   * Capture the current transform SoA into _prevBuf.
   * Call this BEFORE world.tick(dt) each fixed step so that sync(alpha)
   * can lerp between the pre-tick state (prev) and post-tick state (curr).
   * Zero allocation after the first call — just a typed-array copy.
   */
  snapshot(world: World): void {
    let xfmBuf: Float32Array;
    try { xfmBuf = world.getStorage<Float32Array>('transform'); }
    catch { return; }
    if (!this._prevBuf || this._prevBuf.length !== xfmBuf.length) {
      this._prevBuf = new Float32Array(xfmBuf); // allocates + copies once
    } else {
      this._prevBuf.set(xfmBuf);
    }
  }

  /**
   * Synchronises ECS transform data into Babylon mesh transforms.
   * Lerps position and rotation between the pre-tick snapshot (_prevBuf)
   * and the current physics state by `alpha` so motion is smooth at any
   * display refresh rate (60 / 120 / 144 Hz …).
   *
   * @param alpha  Interpolation factor [0, 1) – how far into the next tick.
   * @param world  The ECS world.
   */
  sync(alpha: number, world: World): void {
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

    const prevBuf = this._prevBuf;
    const omt    = 1 - alpha; // pre-computed (1 - alpha) reused per component
    const stride  = world.getStride('transform') ?? TRANSFORM_STRIDE;
    const ids     = world.query(['transform', 'renderable']);

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

      // ── Position: lerp prev → curr by alpha (zero allocation) ─────────────
      rdr.mesh.isVisible = rdr.visible;
      if (prevBuf) {
        rdr.mesh.position.set(
          omt * prevBuf[base + Transform.POS_X] + alpha * xfmBuf[base + Transform.POS_X],
          omt * prevBuf[base + Transform.POS_Y] + alpha * xfmBuf[base + Transform.POS_Y],
          omt * prevBuf[base + Transform.POS_Z] + alpha * xfmBuf[base + Transform.POS_Z],
        );
      } else {
        rdr.mesh.position.set(
          xfmBuf[base + Transform.POS_X],
          xfmBuf[base + Transform.POS_Y],
          xfmBuf[base + Transform.POS_Z],
        );
      }

      // ── Rotation quaternion: nlerp prev → curr by alpha ───────────────────
      // nlerp (no sqrt normalisation) is visually identical to slerp for the
      // sub-16 ms angular deltas we have here, and is zero-allocation.
      //
      // ⚠  Never set mesh.rotation (Euler) – Babylon resets rotationQuaternion
      //    to null on the next write, causing a one-frame snap.
      if (!rdr.mesh.rotationQuaternion) {
        rdr.mesh.rotationQuaternion = this._identityQ.clone();
      }
      if (prevBuf) {
        rdr.mesh.rotationQuaternion.set(
          omt * prevBuf[base + Transform.ROT_X] + alpha * xfmBuf[base + Transform.ROT_X],
          omt * prevBuf[base + Transform.ROT_Y] + alpha * xfmBuf[base + Transform.ROT_Y],
          omt * prevBuf[base + Transform.ROT_Z] + alpha * xfmBuf[base + Transform.ROT_Z],
          omt * prevBuf[base + Transform.ROT_W] + alpha * xfmBuf[base + Transform.ROT_W],
        );
      } else {
        rdr.mesh.rotationQuaternion.set(
          xfmBuf[base + Transform.ROT_X],
          xfmBuf[base + Transform.ROT_Y],
          xfmBuf[base + Transform.ROT_Z],
          xfmBuf[base + Transform.ROT_W],
        );
      }

      // ── Scale – doesn't change per-tick; copy current directly ────────────
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
