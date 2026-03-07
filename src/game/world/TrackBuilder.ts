/**
 * @file TrackBuilder.ts
 * @module game/world
 *
 * Generates and manages an **infinite, procedurally generated track** for the
 * MechaRacing game using a rolling-buffer architecture.
 *
 * ## Architecture overview
 * The full visible course is divided into TRACK_WINDOW_SIZE (200) segments
 * spread across TRACK_CHUNK_COUNT (5) independent Babylon.js thin-instance
 * meshes called "chunks".  Each chunk holds TRACK_CHUNK_SIZE (40) segments.
 * Splitting into multiple meshes lets Babylon frustum-cull chunks that are
 * entirely off-screen, avoiding the all-or-nothing culling of a single mesh.
 *
 * ## Rolling buffer (recycling)
 * `headIdx` is a circular pointer to the oldest segment.  When the player
 * advances past it, `recycleNext()` overwrites that slot with a fresh segment
 * at the current tail, re-uploads only the 16 affected matrix floats to the
 * GPU, then increments `headIdx`.  This is O(1) per frame with zero GC.
 *
 * ## Seeded PRNG
 * `mulberry32(seed)` ensures the same seed produces the identical infinite
 * track on every run, which is useful for replays and leaderboards.
 *
 * @exports TRACK_SEGMENT_LENGTH  Length of one segment along its local Z (m).
 * @exports TRACK_HALF_WIDTH      Half the driveable width (m).
 * @exports TRACK_WINDOW_SIZE     Total live segments in the rolling window.
 * @exports TRACK_CHUNK_COUNT     Number of independent chunk meshes.
 * @exports TRACK_CHUNK_SIZE      Segments per chunk.
 * @exports TRACK_SURFACE_Y       Y of the top surface (used for floor snap).
 * @exports TrackData             Read-only interface shared with PhysicsSystem.
 * @exports TrackBuilder          Stateful infinite-track manager.
 */
import {
  Scene,
  Mesh,
  Matrix,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
} from '@babylonjs/core';
import { GridMaterial } from '@babylonjs/materials';
import type { World } from '../../engine/core/World';

// ── Track constants ──────────────────────────────────────────────────────────

export const TRACK_SEGMENT_LENGTH = 10;

export const TRACK_HALF_WIDTH = 5;
export const TRACK_WINDOW_SIZE = 200;
export const TRACK_CHUNK_COUNT = 5;
export const TRACK_CHUNK_SIZE = 40;
export const TRACK_SURFACE_Y = 0.2;
const TURN_STEP_RAD = 15 * (Math.PI / 180);

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTurn(rng: () => number): number {
  const r = rng();
  return r < 0.2 ? -1 : r < 0.4 ? 1 : 0;
}

export interface TrackData {
  readonly centers:        Float32Array;
  readonly headings:       Float32Array;
  readonly count:          number;
  readonly halfWidth:      number;
  readonly surfaceY:       number;
  readonly segmentHalfLen: number;
  readonly spawnX:         number;
  readonly spawnZ:         number;
  readonly spawnYaw:       number;
  /**
   * Immutable respawn anchor — fixed at segment-0 of the initial generation.
   * Unlike the rolling `centers` / `headings` arrays, these THREE values are
   * NEVER mutated by `recycleNext()`, so they remain valid as a hard respawn
   * destination no matter how many segments have been recycled.
   */
  readonly safeSpawnX:   number;
  readonly safeSpawnZ:   number;
  readonly safeSpawnYaw: number;
}

export class TrackBuilder {
  private readonly _chunks:  Mesh[];
  private readonly _matBufs: Float32Array[];

  headIdx = 0;

  private _tailHeading = 0;
  private _tailX = 0;
  private _tailZ = 0;

  private readonly _td: TrackData;
  private readonly _rng: () => number;

  private readonly _scratchM  = Matrix.Identity();
  private readonly _scratchTx = new Vector3(0, 0, 0);

  private constructor(
    chunks:      Mesh[],
    matBufs:     Float32Array[],
    td:          TrackData,
    rng:         () => number,
    tailX:       number,
    tailZ:       number,
    tailHeading: number,
  ) {
    this._chunks      = chunks;
    this._matBufs     = matBufs;
    this._td          = td;
    this._rng         = rng;
    this._tailX       = tailX;
    this._tailZ       = tailZ;
    this._tailHeading = tailHeading;
  }

  get trackData(): TrackData { return this._td; }

  static readonly RECYCLE_TRIGGER = TRACK_SEGMENT_LENGTH * 1.5;

  static create(
    _world: World,
    scene:  Scene,
    seed    = 12345,
  ): TrackBuilder {
    const rng  = mulberry32(seed);
    const N    = TRACK_WINDOW_SIZE;
    const HALF = TRACK_SEGMENT_LENGTH * 0.5;

    const centers  = new Float32Array(N * 2);
    const headings = new Float32Array(N);

    let startX  = 0;
    let startZ  = 0;
    let heading = 0;

    for (let i = 0; i < N; i++) {
      heading += randomTurn(rng) * TURN_STEP_RAD;

      const sinH = Math.sin(heading);
      const cosH = Math.cos(heading);

      centers[i * 2]     = startX + sinH * HALF;
      centers[i * 2 + 1] = startZ + cosH * HALF;
      headings[i]        = heading;

      startX += sinH * TRACK_SEGMENT_LENGTH;
      startZ += cosH * TRACK_SEGMENT_LENGTH;
    }
    // After loop: heading = heading of segment N-1, startX/Z = tail edge

    const buildM  = Matrix.Identity();
    const buildTx = new Vector3(0, 0, 0);

    const chunks:  Mesh[]         = [];
    const matBufs: Float32Array[] = [];

    for (let c = 0; c < TRACK_CHUNK_COUNT; c++) {
      const buf = new Float32Array(TRACK_CHUNK_SIZE * 16);

      for (let li = 0; li < TRACK_CHUNK_SIZE; li++) {
        const gi = c * TRACK_CHUNK_SIZE + li;
        buildTx.set(centers[gi * 2], 0, centers[gi * 2 + 1]);
        Matrix.RotationYToRef(headings[gi], buildM);
        buildM.setTranslation(buildTx);
        buildM.copyToArray(buf, li * 16);
      }

      const mesh = MeshBuilder.CreateBox(`track_chunk_${c}`, {
        width:  TRACK_HALF_WIDTH * 2,
        height: 0.4,
        depth:  TRACK_SEGMENT_LENGTH,
      }, scene);

      try {
        const mat              = new GridMaterial(`track_mat_${c}`, scene);
        mat.majorUnitFrequency  = 5;
        mat.minorUnitVisibility = 0.45;
        mat.gridRatio           = 1;
        mat.mainColor           = new Color3(0.07, 0.08, 0.09);
        mat.lineColor           = new Color3(0.25, 0.85, 0.45);
        mat.backFaceCulling     = false;
        mesh.material           = mat;
      } catch {
        const mat        = new StandardMaterial(`track_fallback_${c}`, scene);
        mat.diffuseColor = new Color3(0.1, 0.1, 0.12);
        mesh.material    = mat;
      }

      // staticBuffer = false → dynamic, allows thinInstanceBufferUpdated()
      mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
      mesh.thinInstanceCount        = TRACK_CHUNK_SIZE;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.isPickable               = false;
      mesh.position.y               = -1000;  // park prototype off-screen

      chunks.push(mesh);
      matBufs.push(buf);
    }

    // Safe spawn = the CENTER of segment 0 (the tile the car is actually on at
    // startup). Using (0,0) would point to the leading edge of the first tile,
    // which after an initial random-turn heading is off-centre — causing the
    // "dropped but not on track" symptom.
    const td: TrackData = {
      centers,
      headings,
      count:          N,
      halfWidth:      TRACK_HALF_WIDTH,
      surfaceY:       TRACK_SURFACE_Y,
      segmentHalfLen: HALF,
      spawnX:         centers[0],
      spawnZ:         centers[1],
      spawnYaw:       headings[0],
      safeSpawnX:     centers[0],
      safeSpawnZ:     centers[1],
      safeSpawnYaw:   headings[0],
    };

    return new TrackBuilder(chunks, matBufs, td, rng, startX, startZ, heading);
  }

  /**
   * Move the oldest (head) segment to a new position at the current tail.
   *
   * Called by TrackSystem every time the player passes the head segment.
   * Zero-GC: only scalar math + writes into pre-allocated buffers.
   */
  recycleNext(): void {
    const td   = this._td;
    const slot = this.headIdx;
    const HALF = TRACK_SEGMENT_LENGTH * 0.5;

    const newHeading = this._tailHeading + randomTurn(this._rng) * TURN_STEP_RAD;
    const sinH       = Math.sin(newHeading);
    const cosH       = Math.cos(newHeading);

    const cx = this._tailX + sinH * HALF;
    const cz = this._tailZ + cosH * HALF;

    td.centers[slot * 2]     = cx;
    td.centers[slot * 2 + 1] = cz;
    td.headings[slot]        = newHeading;

    this._tailX      += sinH * TRACK_SEGMENT_LENGTH;
    this._tailZ      += cosH * TRACK_SEGMENT_LENGTH;
    this._tailHeading = newHeading;

    const chunkIdx = Math.floor(slot / TRACK_CHUNK_SIZE);
    const localIdx = slot % TRACK_CHUNK_SIZE;

    this._scratchTx.set(cx, 0, cz);
    Matrix.RotationYToRef(newHeading, this._scratchM);
    this._scratchM.setTranslation(this._scratchTx);
    this._scratchM.copyToArray(this._matBufs[chunkIdx], localIdx * 16);

    this._chunks[chunkIdx].thinInstanceBufferUpdated('matrix');

    this.headIdx = (slot + 1) % TRACK_WINDOW_SIZE;
  }
}


