/**
 * @file LevelBuilder.ts
 * @module game/world
 *
 * Factory class that assembles a playable level inside the ECS World.
 *
 * ## Responsibilities
 * - `spawnVehicle()` — creates a vehicle entity with Transform, Physics,
 *   Renderable, Input, and Collider components and a placeholder box mesh.
 * - `spawnTile()` — creates a static tile entity (reserved for future use).
 * - `spawnCamera()` — creates a Babylon FollowCamera entity that tracks the
 *   vehicle and registers it as the active scene camera.
 * - `build()` — the single entry-point called by `App.run()`.  Spawns the
 *   vehicle, calls `TrackBuilder.create()` to generate the infinite
 *   procedural course, places a debug magenta spawn marker, attaches the
 *   camera, and returns the `TrackBuilder` instance so the caller can wire it
 *   into `PhysicsSystem` and `TrackSystem`.
 *
 * ## Debug aids
 * A 0.5 m magenta cube is placed at the track spawn point.  Remove the
 * "Debug spawn marker" block in `build()` once the track is verified.
 */
import { Scene, FollowCamera, Vector3, MeshBuilder, Quaternion, StandardMaterial, Color3 } from '@babylonjs/core';
import { GridMaterial }   from '@babylonjs/materials';
import { World }           from '../../engine/core/World';
import { createTransform } from '../components/Transform';
import { createPhysics }  from '../components/Physics';
import { createRenderable } from '../components/Renderable';
import { createCamera }   from '../components/Camera';
import { createAABB }     from '../components/Collider';
import { createInput }    from '../components/Input';
import { TrackBuilder }   from './TrackBuilder';

export class LevelBuilder {
  private world: World;
  private scene: Scene;

  constructor(world: World, scene: Scene) {
    this.world = world;
    this.scene = scene;
  }

  /**
   * Spawn a vehicle entity, clone a Babylon mesh into the scene,
   * and link it to the Renderable component.
   */
  spawnVehicle(templateMesh: import('@babylonjs/core').AbstractMesh | null): number {
    const id = this.world.createEntity();
    const t  = createTransform();
    t[1] = 2; // spawn 2 m above track surface so vehicle drops onto it cleanly

    this.world.addComponent(id, 'transform',  t);
    this.world.addComponent(id, 'physics',    createPhysics(
      /* engineForce        */ 60,
      /* brakingForce       */ 120,
      /* topSpeed           */ 80,     // m/s ≈ 288 km/h
      /* dragCoefficient    */ 0.03,
      /* rollingResistance  */ 0.10,
      /* steerSpeed         */ 2.0,    // rad/s at v→0
      /* gripStatic         */ 0.98,
      /* gripDynamic        */ 0.45,   // handbrake drift
      /* turnRadius         */ 8,
      /* gravity            */ 25,
      /* downforce          */ 0.001,
      /* suspensionStiffness*/ 0.6,
      /* mass               */ 1200,
    ));
    this.world.addComponent(id, 'collider',   createAABB(1, 0.5, 2, 1));
    this.world.addComponent(id, 'input',      createInput());

    const rdr = createRenderable();
    if (templateMesh) {
      const clone = templateMesh.clone(`vehicle_${id}`, null)!;
      clone.setEnabled(true);
      rdr.mesh = clone;
    } else {
      // Fallback placeholder box
      rdr.mesh = MeshBuilder.CreateBox(`vehicle_${id}`, { width: 2, height: 1, depth: 4 }, this.scene);
    }
    // Pre-initialise quaternion mode so Babylon never falls back to Euler rotation.
    rdr.mesh.rotationQuaternion = Quaternion.Identity();
    this.world.addComponent(id, 'renderable', rdr);

    return id;
  }

  /**
   * Spawn a static track tile entity with a Babylon mesh.
   *
   * @param chx  AABB half-extent X (default 5)
   * @param chy  AABB half-extent Y (default 0.25)
   * @param chz  AABB half-extent Z (default 5)
   */
  spawnTile(
    x: number, y: number, z: number,
    templateMesh: import('@babylonjs/core').AbstractMesh | null = null,
    chx = 5, chy = 0.25, chz = 5,
  ): number {
    const id = this.world.createEntity();
    const t  = createTransform();
    t[0] = x; t[1] = y; t[2] = z;

    this.world.addComponent(id, 'transform', t);
    this.world.addComponent(id, 'collider',  createAABB(chx, chy, chz));

    const rdr = createRenderable();
    if (templateMesh) {
      const clone = templateMesh.clone(`tile_${id}`, null)!;
      clone.setEnabled(true);
      clone.setParent(null);          // guarantee no inherited transform
      clone.position.set(x, y, z);
      rdr.mesh = clone;
    } else {
      rdr.mesh = MeshBuilder.CreateGround(`tile_${id}`, { width: 200, height: 200, subdivisions: 2 }, this.scene);
      rdr.mesh.setParent(null);       // guarantee no inherited transform
      rdr.mesh.position.set(x, y, z);

      // ── Grid material ───────────────────────────────────────────────────
      // GridMaterial renders a procedural grid pattern without a texture
      // asset, keeping the project asset-free for the MVP.  Allocated once
      // per tile; no per-frame allocation.
      let gridMat: GridMaterial;
      try {
        gridMat = new GridMaterial(`tile_grid_${id}`, this.scene);
        gridMat.majorUnitFrequency  = 10;   // thick line every 10 units
        gridMat.minorUnitVisibility = 0.35; // faint sub-grid
        gridMat.gridRatio            = 1;   // one cell = 1 unit
        gridMat.mainColor            = new Color3(0.12, 0.12, 0.14);
        gridMat.lineColor            = new Color3(0.4, 0.8, 1.0);
        gridMat.backFaceCulling      = false;
        rdr.mesh.material = gridMat;
      } catch {
        // Fallback to a plain dark material if GridMaterial is unavailable.
        const mat = new StandardMaterial(`tile_mat_${id}`, this.scene);
        mat.diffuseColor = new Color3(0.15, 0.15, 0.18);
        rdr.mesh.material = mat;
      }
    }
    // Pre-initialise quaternion mode so Babylon never falls back to Euler rotation.
    rdr.mesh.rotationQuaternion = Quaternion.Identity();
    this.world.addComponent(id, 'renderable', rdr);

    return id;
  }

  /**
   * Spawn a Babylon FollowCamera entity that chases the given target.
   */
  spawnCamera(targetEntityId: number): number {
    const id  = this.world.createEntity();
    const cfg = createCamera();

    const rdr = this.world.getComponent<{ mesh: import('@babylonjs/core').AbstractMesh | null }>(targetEntityId, 'renderable');
    const targetMesh = rdr?.mesh ?? null;

    const fc = new FollowCamera('follow-cam', new Vector3(0, 5, -12), this.scene, targetMesh);
    fc.radius         = cfg.followDistance;
    fc.heightOffset   = cfg.followHeight;
    fc.rotationOffset = cfg.rotationOffset;
    fc.fov            = cfg.fov;
    fc.minZ           = cfg.near;
    fc.maxZ           = cfg.far;
    // NOTE: do NOT set rotationQuaternion on a FollowCamera.
    // FollowCamera computes its own orientation every frame to face the
    // lockedTarget.  Assigning rotationQuaternion overrides that internal
    // computation and freezes the camera orientation in world space, making
    // the scene appear to rotate/stick as if attached to the camera.
    this.scene.activeCamera = fc;

    cfg.babylonCamera = fc;
    this.world.addComponent(id, 'camera',       cfg);
    this.world.addComponent(id, 'cameraTarget', targetEntityId);

    return id;
  }

  /**
   * Build a default level: one vehicle + ground tile + follow camera.
   * This is the single entry-point called by App.run() (diagram: build(world)).
   */
  /**
   * Build a default level: one vehicle + procedural track + follow camera.
   *
   * The ground/grid tile is **replaced** by a TrackBuilder-generated course
   * rendered as a single WebGPU draw call via Thin Instances.
   *
   * Returns the generated `TrackData` so the caller can pass it to
   * `PhysicsSystem.setTrackData()` for out-of-bounds respawn detection.
   */
  build(world: World): TrackBuilder {
    const vehicleId = this.spawnVehicle(null);

    // ── Infinite procedural track ────────────────────────────────────────────
    const trackBuilder = TrackBuilder.create(world, this.scene);
    const td           = trackBuilder.trackData;

    // ── Place vehicle at the real track segment-0 centre ────────────────────
    // spawnVehicle() can only hardcode (0,0) because TrackBuilder doesn't
    // exist yet.  Now that we have td.safeSpawnX/Z we back-patch the transform
    // so the car drops onto the actual first tile, not the raw world origin.
    const xfm = world.getComponent<Float32Array>(vehicleId, 'transform')!;
    xfm[0] = td.safeSpawnX;     // POS_X
    xfm[1] = td.surfaceY + 2.0; // POS_Y — 2 m drop onto track
    xfm[2] = td.safeSpawnZ;     // POS_Z
    // Sync heading quaternion to spawn yaw (pure Y rotation: q = (cos θ/2, 0, sin θ/2, 0))
    const halfYaw = td.safeSpawnYaw * 0.5;
    xfm[3] = Math.cos(halfYaw); // ROT_W
    xfm[4] = 0;                 // ROT_X
    xfm[5] = Math.sin(halfYaw); // ROT_Y
    xfm[6] = 0;                 // ROT_Z

    // ── Debug spawn marker ──────────────────────────────────────────────────
    const spawnMarker     = MeshBuilder.CreateBox('spawn_debug', { size: 0.5 }, this.scene);
    spawnMarker.position.set(td.safeSpawnX, td.surfaceY + 0.5, td.safeSpawnZ);
    spawnMarker.isPickable = false;
    const markerMat         = new StandardMaterial('spawn_debug_mat', this.scene);
    markerMat.diffuseColor  = new Color3(1, 0, 1);
    markerMat.emissiveColor = new Color3(0.6, 0, 0.6);
    markerMat.backFaceCulling = false;
    spawnMarker.material    = markerMat;

    this.spawnCamera(vehicleId);

    void world;
    return trackBuilder;
  }
}
