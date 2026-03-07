/**
 * @file index.ts
 * @module root
 *
 * Application entry point for MechaRacing.
 *
 * ## Boot sequence
 * 1. **Engine + Scene** — `BabylonCore.init()` creates the WebGPU engine and
 *    Babylon scene bound to the `#canvas` element.
 * 2. **ECS World** — component storages are pre-registered (typed SoA
 *    `Float32Array` for transform/physics, object `Map` for everything else).
 * 3. **Systems** — `InputSystem → TrackSystem → PhysicsSystem → CameraSystem
 *    → RenderSystem` pushed into `world.systems` in update order.
 * 4. **Assets + materials** — `AssetLoader` and `MaterialManager` prepared;
 *    PBR vehicle material registered.
 * 5. **Level** — `LevelBuilder.build()` spawns the vehicle entity, generates
 *    the infinite procedural track via `TrackBuilder`, places the camera, and
 *    returns the `TrackBuilder` instance.  `PhysicsSystem.setTrackData()` and
 *    `TrackSystem.setBuilder()` are called to link them.
 * 6. **EventBus** — collision and player-death subscriptions registered.
 * 7. **Loop** — fixed 60 Hz tick (ECS `world.tick`) + variable render callback
 *    (`RenderSystem.sync` + `scene.render`).
 */
import { BabylonCore }     from './engine/babylon/SceneManager';
import { World }           from './engine/core/World';

/**
 * Duration of the fade-to-black transition that hides the respawn teleport.
 * Keep in sync with FADE_DURATION_S in PhysicsSystem.ts (300 ms = 0.3 s).
 */
const FADE_DURATION_MS = 300;
import { Loop }            from './engine/core/Loop';
import { gameState }       from './engine/core/GameStateManager';
import { AssetLoader }     from './engine/assets/AssetLoader';
import { MaterialManager } from './engine/babylon/MaterialManager';
import { InputSystem }     from './game/systems/InputSystem';
import { PhysicsSystem }   from './game/systems/PhysicsSystem';
import { CameraSystem }    from './game/systems/CameraSystem';
import { RenderSystem }    from './game/systems/RenderSystem';
import { TrackSystem }     from './game/systems/TrackSystem';
import { LevelBuilder }    from './game/world/LevelBuilder';
import { eventBus }        from './engine/core/EventBus';
import { TRANSFORM_STRIDE } from './game/components/Transform';
import { PHYSICS_STRIDE }   from './game/components/Physics';

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
 * 5. Level entities       (LevelBuilder – vehicle + ground + camera)
 * 6. EventBus wiring
 * 7. Loop start           (60 Hz fixed + variable render)
 */
class App {
  private loop!:      Loop;
  private world!:     World;
  private readonly babylonCore = BabylonCore.getInstance();
  readonly gameState = gameState;
  readonly eventBus  = eventBus;

  async run(): Promise<void> {
    // ── 0. Fade-to-black overlay ──────────────────────────────────────────────
    // A fixed full-screen black div that covers the canvas during respawn so
    // the instant position snap is invisible.  Controlled via opacity only;
    // pointer-events are always none so it never blocks input.
    const fadeOverlay = document.createElement('div');
    Object.assign(fadeOverlay.style, {
      position:      'fixed',
      inset:         '0',
      background:    '#000',
      opacity:       '0',
      transition:    `opacity ${FADE_DURATION_MS / 1000}s ease`,
      pointerEvents: 'none',
      zIndex:        '9999',
    });
    document.body.appendChild(fadeOverlay);

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
    const track   = new TrackSystem();
    const physics = new PhysicsSystem();
    const camera  = new CameraSystem();
    const render  = new RenderSystem();
    this.world.systems.push(input, track, physics, camera, render);

    // ── 4. Assets + materials ───────────────────────────────────────────────
    const loader    = new AssetLoader(scene);
    const materials = new MaterialManager(scene);
    materials.createPBR('vehicle', { metallic: 0.8, roughness: 0.3 });

    // ── 5. Level ──────────────────────────────────────────────────────────────
    // Spawns: vehicle entity (Transform + Physics + Renderable + Input) +
    // procedural track (TrackBuilder thin instances) + FollowCamera entity.
    // build() returns TrackData which is handed to PhysicsSystem so it can
    // detect out-of-bounds and teleport the vehicle back to the start.
    const builder      = new LevelBuilder(this.world, scene);
    const trackBuilder = builder.build(this.world);
    physics.setTrackBuilder(trackBuilder);
    track.setBuilder(trackBuilder);

    // ── 6. Events ────────────────────────────────────────────────────────────
    eventBus.subscribe<{ a: number; b: number }>('collision', ({ a, b }) =>
      console.debug(`[EventBus] collision: entity ${a} ↔ entity ${b}`),
    );
    eventBus.subscribe('PLAYER_DIED', () => this.gameState.setState('gameover'));

    // ── Respawn fade ──────────────────────────────────────────────────────────
    // PLAYER_FELL  → car went OOB; fade to black while physics freezes car.
    // PLAYER_RESPAWN → teleport complete; fade back in to reveal new position.
    eventBus.subscribe('PLAYER_FELL',    () => { fadeOverlay.style.opacity = '1'; });
    eventBus.subscribe('PLAYER_RESPAWN', () => { fadeOverlay.style.opacity = '0'; });

    // ── Initial state ─────────────────────────────────────────────────────────
    // Start straight into 'racing' so world.tick() runs from frame 1.
    // Switch back to 'menu' once a start screen is implemented.
    this.gameState.setState('racing');

    // ── 7. Game Loop ──────────────────────────────────────────────────────────
    this.loop = new Loop(engine); // default: 60 Hz fixed step

    // Fixed callback – runs at 60 Hz regardless of display refresh rate.
    // Execution order guaranteed by systems array insertion order (step 3):
    //   InputSystem → PhysicsSystem → CameraSystem → RenderSystem
    this.loop.addFixed(dt => {
      if (this.gameState.is('racing')) {
        // Snapshot pre-tick state so RenderSystem.sync(alpha) can interpolate.
        render.snapshot(this.world);
        this.world.tick(dt);
      }
    });

    // Variable callback – runs every browser frame (60 / 120 / 144 Hz …).
    // render.sync interpolates ECS state into Babylon mesh transforms, then
    // Babylon issues the WebGPU draw calls.
    this.loop.addVariable(alpha => {
      render.sync(alpha, this.world);
      scene.render();
    });

    this.loop.start();

    // Keep loader alive so the GC doesn't collect pending asset tasks.
    void loader;
  }
}

new App().run().catch(console.error);
