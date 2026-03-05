import { MeshBuilder, Quaternion } from '@babylonjs/core';
import { BabylonCore }     from './engine/babylon/SceneManager';
import { World }           from './engine/core/World';
import { Loop }            from './engine/core/Loop';
import { gameState }       from './engine/core/GameStateManager';
import { AssetLoader }     from './engine/assets/AssetLoader';
import { MaterialManager } from './engine/babylon/MaterialManager';
import { InputSystem }     from './game/systems/InputSystem';
import { PhysicsSystem }   from './game/systems/PhysicsSystem';
import { CameraSystem }    from './game/systems/CameraSystem';
import { RenderSystem }    from './game/systems/RenderSystem';
import { LevelBuilder }    from './game/world/LevelBuilder';
import { eventBus }        from './engine/core/EventBus';
import { TRANSFORM_STRIDE, Transform, createTransform } from './game/components/Transform';
import { PHYSICS_STRIDE }   from './game/components/Physics';
import { createRenderable } from './game/components/Renderable';

// ---------------------------------------------------------------------------
// App – ECS bootstrapper
// ---------------------------------------------------------------------------

/**
 * App wires the full ECS pipeline and starts the game loop.
 *
 * Boot sequence
 * 1. WebGPU engine + scene  (BabylonCore)
 * 2. ECS World with pre-registered component storages
 * 3. Systems pushed into world (Input → Physics → Camera → Render)
 * 4. Assets + materials
 * 5. Player-input entity  (InputSystem)
 * 6. Level entities       (LevelBuilder)
 * 7. Demo entity          (spinning box – visual smoke-test)
 * 8. EventBus wiring
 * 9. Loop start           (60 Hz fixed + variable render)
 */
class App {
  private loop!:      Loop;
  private world!:     World;
  private readonly babylonCore = BabylonCore.getInstance();
  readonly gameState = gameState;
  readonly eventBus  = eventBus;

  async run(): Promise<void> {
    // ── 1. Engine + Scene ───────────────────────────────────────────────────
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
    if (!canvas) throw new Error('Canvas element #canvas not found');

    await this.babylonCore.init(canvas);
    const { engine, scene } = this.babylonCore;

    // ── 2. ECS World ────────────────────────────────────────────────────────
    this.world = new World();

    // Pre-register all component types so storage allocation happens here,
    // not lazily inside the game loop.  Typed (Float32Array) components get
    // a flat SoA buffer; object components get a Map.
    this.world.registerTyped('transform', TRANSFORM_STRIDE);
    this.world.registerTyped('physics',   PHYSICS_STRIDE);
    this.world.registerObject('renderable');
    this.world.registerObject('input');
    this.world.registerObject('camera');
    this.world.registerObject('cameraTarget');
    this.world.registerObject('collider');

    // ── 3. Systems ──────────────────────────────────────────────────────────
    // Order matters: Input → Physics → Camera → Render
    const input   = new InputSystem();
    const physics = new PhysicsSystem();
    const camera  = new CameraSystem();
    const render  = new RenderSystem();
    this.world.systems.push(input, physics, camera, render);

    // ── 4. Assets + materials ───────────────────────────────────────────────
    const loader    = new AssetLoader(scene);
    const materials = new MaterialManager(scene);
    materials.createPBR('vehicle', { metallic: 0.8, roughness: 0.3 });

    // ── 5. Player-input entity ───────────────────────────────────────────────
    // Creates a lightweight entity carrying only the InputComponent.
    // PhysicsSystem reads it via world.getComponent(vehicleId, 'input').
    input.registerPlayerEntity(this.world);

    // ── 6. Level ─────────────────────────────────────────────────────────────
    // Spawns: vehicle entity + ground tile + FollowCamera entity.
    const builder = new LevelBuilder(this.world, scene);
    builder.build(this.world);

    // ── 7. Demo entity – spinning + bobbing box ──────────────────────────────
    //
    // Purpose: visual smoke-test that the ECS → Babylon render bridge works
    // end-to-end without requiring physics / input / assets.
    //
    // The transform is mutated directly in the fixed callback below.
    // No system owns this entity; it is animated manually to prove that
    // writing into the flat Float32Array is immediately reflected by
    // RenderSystem.sync() via the live subarray view.
    const demoId  = this.world.createEntity();
    const demoXfm = createTransform();
    demoXfm[Transform.POS_X] =  4;   // offset right so it doesn't overlap vehicle
    demoXfm[Transform.POS_Y] =  1.5;
    demoXfm[Transform.SCL_X] =  1.5;
    demoXfm[Transform.SCL_Y] =  1.5;
    demoXfm[Transform.SCL_Z] =  1.5;

    const demoRdr = createRenderable();
    demoRdr.mesh  = MeshBuilder.CreateBox('demo_box', { size: 1 }, scene);
    // Pre-initialise quaternion mode immediately so Babylon never uses Euler
    // rotation for this mesh.  Lazy initialisation inside RenderSystem.sync()
    // would leave mesh.rotation active for one frame, causing a brief snap.
    demoRdr.mesh.rotationQuaternion = Quaternion.Identity();

    this.world.addComponent(demoId, 'transform',  demoXfm);
    this.world.addComponent(demoId, 'renderable', demoRdr);

    // Cache the live subarray view once here – no allocation ever inside loop.
    const demoView = this.world.getComponent<Float32Array>(demoId, 'transform')!;
    let demoAngle  = 0;

    // ── 8. Events ────────────────────────────────────────────────────────────
    eventBus.subscribe<{ a: number; b: number }>('collision', ({ a, b }) =>
      console.debug(`[EventBus] collision: entity ${a} ↔ entity ${b}`),
    );
    eventBus.subscribe('PLAYER_DIED', () => this.gameState.setState('gameover'));

    // ── 9. Initial state ──────────────────────────────────────────────────────
    // Start straight into 'racing' so world.tick() runs from frame 1.
    // Switch back to 'menu' once a start screen is implemented.
    this.gameState.setState('racing');

    // ── 10. Game Loop ─────────────────────────────────────────────────────────
    this.loop = new Loop(engine); // default: 60 Hz fixed step

    // Fixed callback – runs at 60 Hz regardless of display refresh rate.
    this.loop.addFixed(dt => {
      // ── Demo entity animation ──────────────────────────────────────────────
      // Spin ~1.5 rad/s around the Y axis and bob vertically with a sine wave.
      // All writes go into the cached Float32Array view – zero allocation.
      // Math.sin/cos accept any value – no modulo needed, avoids a discrete
      // jump at 2π that could theoretically round-trip through Float32 storage
      // as a slightly different quaternion.
      demoAngle += dt * Math.PI * 1.5;

      // Pure Y-axis quaternion: q = (cos(θ/2), 0, sin(θ/2), 0)  →  x=0, y=sin, z=0, w=cos
      const half = demoAngle * 0.5;
      demoView[Transform.ROT_W] = Math.cos(half);
      demoView[Transform.ROT_X] = 0;
      demoView[Transform.ROT_Y] = Math.sin(half);
      demoView[Transform.ROT_Z] = 0;
      // Bob: oscillate Y position between 0.5 and 2.5
      demoView[Transform.POS_Y] = 1.5 + Math.sin(demoAngle) * 1.0;

      // ── ECS world tick (Input → Physics → Camera → Render prep) ───────────
      if (this.gameState.is('racing')) this.world.tick(dt);
    });

    // Variable callback – runs every browser frame (60 / 120 / 144 Hz …)
    this.loop.addVariable(alpha => {
      // Sync all ECS transforms into Babylon mesh properties.
      render.sync(alpha, this.world);
      // Let Babylon submit the draw calls to WebGPU.
      scene.render();
    });

    this.loop.start();

    // Keep loader alive so the GC doesn't collect pending asset tasks.
    void loader;
  }
}

new App().run().catch(console.error);
