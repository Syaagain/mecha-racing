/**
 * @file TrackSystem.ts
 * @module game/systems
 *
 * ECS System responsible for recycling the infinite procedural track as the
 * player advances.
 *
 * ## Responsibility
 * Each `update()` call the system:
 *   1. Queries for the player entity (requires `input` + `transform` components).
 *   2. Projects the player's XZ world position onto the forward axis of the
 *      current head segment using a dot-product.
 *   3. While that dot product exceeds `TrackBuilder.RECYCLE_TRIGGER`, calls
 *      `builder.recycleNext()` to move the oldest segment to the new tail.
 *
 * A guard cap of `TRACK_CHUNK_SIZE` (40) recycles per frame prevents hitches
 * after a respawn teleport that skips many segments at once.
 *
 * ## Dependencies
 * - `TrackBuilder` (world/TrackBuilder) — must be injected via `setBuilder()`
 *   after `LevelBuilder.build()` returns.
 * - `Transform` component — reads POS_X and POS_Z of the player.
 */
import { System }        from '../../engine/core/System';
import type { World }    from '../../engine/core/World';
import { Transform }     from '../components/Transform';
import {
  TrackBuilder,
  TRACK_CHUNK_SIZE,
} from '../world/TrackBuilder';

/**
 * TrackSystem — infinite rolling-buffer recycler.
 *
 * Each frame it checks how far the player vehicle has advanced past the
 * oldest (head) segment.  When the player is more than RECYCLE_TRIGGER
 * metres ahead of that segment's centre, it calls `builder.recycleNext()`
 * to move that slot to the new tail position.
 *
 * At most CHUNK_SIZE segments are recycled per frame (safety cap) to keep
 * frame-time predictable even after a long respawn teleport.
 */
export class TrackSystem extends System {
  private _builder: TrackBuilder | null = null;

  /** Called once from game boot after LevelBuilder.build() returns. */
  setBuilder(b: TrackBuilder): void {
    this._builder = b;
  }

  update(_dt: number, world: World): void {
    if (!this._builder) return;

    // Find the player entity (has both 'input' and 'transform' components).
    const players = world.query(['input', 'transform']);
    if (players.length === 0) return;

    const xfm = world.getComponent<Float32Array>(players[0], 'transform');
    if (!xfm) return;

    const px = xfm[Transform.POS_X];
    const pz = xfm[Transform.POS_Z];

    const td      = this._builder.trackData;
    const trigger = TrackBuilder.RECYCLE_TRIGGER;
    let   guard   = 0;

    // Cap at CHUNK_SIZE recycles per frame to avoid stalls after respawn.
    while (guard++ < TRACK_CHUNK_SIZE) {
      const hi  = this._builder.headIdx;
      const hcx = td.centers[hi * 2];
      const hcz = td.centers[hi * 2 + 1];
      const hh  = td.headings[hi];

      // Forward dot product: how far ahead of head-centre is the player?
      const fwdDot = (px - hcx) * Math.sin(hh) + (pz - hcz) * Math.cos(hh);

      if (fwdDot > trigger) {
        this._builder.recycleNext();
      } else {
        break;
      }
    }
  }
}
