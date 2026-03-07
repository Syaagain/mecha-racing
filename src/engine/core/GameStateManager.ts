/**
 * @file GameStateManager.ts
 * @module engine/core
 *
 * Manages the global game state machine and publishes state-change events.
 *
 * ## States
 * | State       | Description                                         |
 * |-------------|-----------------------------------------------------|
 * | `menu`      | Main/pause menu visible; world tick paused.         |
 * | `racing`    | Active gameplay; `world.tick()` runs each frame.    |
 * | `paused`    | Game loop suspended; UI overlay shown.              |
 * | `gameover`  | End screen; awaiting restart or menu navigation.   |
 *
 * ## Events published via EventBus
 * - `'stateChange'` — `{ from: GameState; to: GameState }` on every
 *   successful `setState()` call.
 *
 * `gameState` is a module-level singleton; import it directly where needed.
 */
import { eventBus } from './EventBus';

export type GameState = 'menu' | 'racing' | 'paused' | 'gameover';

export class GameStateManager {
  private _current: GameState = 'menu';
  private history: GameState[] = [];

  get current(): GameState { return this._current; }

  transition(next: GameState): void {
    if (next === this._current) return;
    this.history.push(this._current);
    this._current = next;
    eventBus.emit('gamestate:change', { from: this.history[this.history.length - 1], to: next });
  }

  /** Go back to the previous state (e.g. unpause). */
  back(): void {
    const prev = this.history.pop();
    if (prev) this.transition(prev);
  }

  is(state: GameState): boolean { return this._current === state; }

  /** Alias for transition() – matches diagram naming. */
  setState(next: GameState): void { this.transition(next); }

  /** Matches diagram's getCurrentState(). */
  getCurrentState(): GameState { return this._current; }
}

export const gameState = new GameStateManager();
