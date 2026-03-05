import { Scene, FollowCamera, Vector3, MeshBuilder, Quaternion } from '@babylonjs/core';
import { World }           from '../../engine/core/World';
import { createTransform } from '../components/Transform';
import { createPhysics }  from '../components/Physics';
import { createRenderable } from '../components/Renderable';
import { createCamera }   from '../components/Camera';
import { createAABB }     from '../components/Collider';

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
    t[1] = 1; // start slightly above ground

    this.world.addComponent(id, 'transform',  t);
    this.world.addComponent(id, 'physics',    createPhysics(1, 200, 0.02));
    this.world.addComponent(id, 'collider',   createAABB(1, 0.5, 2, 1));

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
   */
  spawnTile(
    x: number, y: number, z: number,
    templateMesh: import('@babylonjs/core').AbstractMesh | null = null,
  ): number {
    const id = this.world.createEntity();
    const t  = createTransform();
    t[0] = x; t[1] = y; t[2] = z;

    this.world.addComponent(id, 'transform', t);
    this.world.addComponent(id, 'collider',  createAABB(5, 0.25, 5));

    const rdr = createRenderable();
    if (templateMesh) {
      const clone = templateMesh.clone(`tile_${id}`, null)!;
      clone.setEnabled(true);
      clone.setParent(null);          // guarantee no inherited transform
      clone.position.set(x, y, z);
      rdr.mesh = clone;
    } else {
      rdr.mesh = MeshBuilder.CreateBox(`tile_${id}`, { width: 10, height: 0.5, depth: 10 }, this.scene);
      rdr.mesh.setParent(null);       // guarantee no inherited transform
      rdr.mesh.position.set(x, y, z);
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
  build(world: World): void {
    const vehicleId = this.spawnVehicle(null);
    this.spawnTile(0, -0.5, 0);
    this.spawnCamera(vehicleId);
    void world; // world is already injected via constructor; param kept for diagram conformance
  }
}
