import { System }         from '../../engine/core/System';
import type { World }     from '../../engine/core/World';
import { eventBus }       from '../../engine/core/EventBus';
import type { InputComponent } from '../components/Input';
import { createInput }    from '../components/Input';

/**
 * InputSystem – translates keyboard events into ECS InputComponent data.
 * Call init() once on bootstrap to register a player-input entity.
 * update(dt, world) writes throttle/steering/actions for every entity
 * that has an 'input' component.
 */
export class InputSystem extends System {
  /** Map<keyCode, isDown>  */
  readonly keyMap = new Map<string, boolean>();

  constructor() {
    super();
    window.addEventListener('keydown', e => this.handleKeyDown(e));
    window.addEventListener('keyup',   e => this.handleKeyUp(e));
  }

  handleKeyDown(e: KeyboardEvent): void { this.keyMap.set(e.code, true);  }
  handleKeyUp(e: KeyboardEvent):   void { this.keyMap.set(e.code, false); }

  private key(code: string): boolean { return this.keyMap.get(code) ?? false; }

  /**
   * Creates an entity with an InputComponent and registers it in the world.
   * Returns the entity ID.
   */
  registerPlayerEntity(world: World): number {
    const id = world.createEntity();
    world.addComponent<InputComponent>(id, 'input', createInput());
    return id;
  }

  /** Called every fixed step – writes current key state into each input entity. */
  update(_dt: number, world: World): void {
    for (const id of world.query(['input'])) {
      const inp = world.getComponent<InputComponent>(id, 'input')!;
      inp.throttle  = (this.key('KeyW') || this.key('ArrowUp')    ? 1 : 0)
                    - (this.key('KeyS') || this.key('ArrowDown') ? 1 : 0);
      inp.steering  = (this.key('KeyD') || this.key('ArrowRight') ? 1 : 0)
                    - (this.key('KeyA') || this.key('ArrowLeft')  ? 1 : 0);
      inp.actions[0] = this.key('ShiftLeft') ? 1 : 0;
      eventBus.publish('input:change', inp);
    }
  }

  /** Legacy accessor kept for PhysicsSystem compatibility. */
  get state() {
    return {
      forward:  this.key('KeyW') || this.key('ArrowUp'),
      backward: this.key('KeyS') || this.key('ArrowDown'),
      left:     this.key('KeyA') || this.key('ArrowLeft'),
      right:    this.key('KeyD') || this.key('ArrowRight'),
      boost:    this.key('ShiftLeft'),
    };
  }
}
