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

/**
 * App -- bootstrapper; wires all ECS systems and starts the game loop.
 * Matches the diagram's App class with run(): void.
 */
class App {
  private loop!:       Loop;
  private world!:      World;
  private babylonCore = BabylonCore.getInstance();
  readonly gameState   = gameState;
  readonly eventBus    = eventBus;

  async run(): Promise<void> {
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
    if (!canvas) throw new Error('Canvas element #canvas not found');

    // Engine + Scene
    await this.babylonCore.init(canvas);
    const { engine, scene } = this.babylonCore;

    // ECS World + services
    this.world = new World();
    this.world.init();

    const loader    = new AssetLoader(scene);
    const materials = new MaterialManager(scene);
    const input     = new InputSystem();
    const physics   = new PhysicsSystem();
    const camera    = new CameraSystem();
    const render    = new RenderSystem();
    const builder   = new LevelBuilder(this.world, scene);

    // Register systems into the world (used by World.tick)
    this.world.systems.push(input, physics, camera, render);

    materials.createPBR('vehicle', { metallic: 0.8, roughness: 0.3 });

    // Register player input entity
    input.registerPlayerEntity(this.world);

    // Build the level (diagram: LevelBuilder.build(world))
    builder.build(this.world);

    // Events
    eventBus.subscribe<{ a: number; b: number }>('collision', ({ a, b }) =>
      console.debug(`Collision: entity ${a} <-> entity ${b}`)
    );
    eventBus.subscribe('PLAYER_DIED', () => this.gameState.setState('gameover'));

    // Initial game state (diagram: setState(START_MENU))
    this.gameState.setState('menu');

    // Game Loop
    this.loop = new Loop(engine);

    this.loop.addFixed(dt => {
      if (this.gameState.is('racing')) this.world.tick(dt);
    });

    this.loop.addVariable(alpha => {
      render.sync(alpha, this.world);
      scene.render();
    });

    this.loop.start();
    void loader;
  }
}

new App().run().catch(console.error);
