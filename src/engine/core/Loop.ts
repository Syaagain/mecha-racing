/**
 * @file Loop.ts
 * @module engine/core
 *
 * Semi-fixed timestep game loop built on top of the Babylon.js
 * `WebGPUEngine` render loop.
 *
 * ## Timestep strategy
 * The loop uses a **semi-fixed** approach:
 * - A constant `fixedStep` interval (default 1/60 s) is accumulated from
 *   real elapsed time.
 * - Each browser frame, as many fixed ticks as fit into the accumulator are
 *   drained (capped at `MAX_STEPS` to prevent spiral-of-death on slow frames).
 * - The leftover fraction `alpha ∈ [0, 1)` is passed to variable callbacks
 *   for sub-tick interpolation.
 *
 * ## Callback registration
 * | Method          | Called at          | Typical use                      |
 * |-----------------|-------------------|----------------------------------|
 * | `addFixed(cb)`  | Every fixed tick   | Physics, input, ECS `world.tick` |
 * | `addVariable(cb)` | Every frame (with alpha) | Mesh sync + scene.render  |
 *
 * ## Usage
 * ```ts
 * const loop = new Loop(engine);
 * loop.addFixed(dt  => world.tick(dt));
 * loop.addVariable(alpha => { render.sync(alpha, world); scene.render(); });
 * loop.start();
 * ```
 */
import { WebGPUEngine } from '@babylonjs/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback for a fixed-timestep tick (physics, input, collision). */
export type FixedFn = (dt: number) => void;

/** Callback for a variable-timestep frame (render, camera). */
export type VariableFn = (alpha: number) => void;

/** @deprecated Use FixedFn – kept for backward compatibility. */
export type SystemFn = FixedFn;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FIXED_HZ = 60;

/**
 * Maximum frame-time budget consumed per render-loop invocation.
 * Caps the number of fixed steps to prevent the "spiral of death" on slow
 * machines or when the tab regains focus after a long background pause.
 */
const MAX_FRAME_TIME = 0.25; // seconds

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/**
 * Loop – semi-fixed timestep game loop built on top of Babylon's
 * `engine.runRenderLoop()`.
 *
 * ## Timing model
 * ```
 * ┌──────────────────────────────────────────────────────────┐
 * │ browser frame  (variable rate – 60 / 120 / 144 Hz …)    │
 * │   accumulator += frameTime                               │
 * │   while accumulator >= fixedDt:                          │
 * │     fixed callbacks(fixedDt)   ← physics / input 60 Hz  │
 * │     accumulator -= fixedDt                              │
 * │   alpha = accumulator / fixedDt  ← interpolation [0,1)  │
 * │   variable callbacks(alpha)    ← render sync / scene    │
 * └──────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Pause behaviour
 * When paused the accumulator is frozen (no fixed steps fire), but variable
 * callbacks still run so the scene continues to render (HUD, pause menu).
 */
export class Loop {
  // ── Public constants ────────────────────────────────────────────────────
  /** Target rate for fixed steps in Hz. */
  readonly fixedHz: number;
  /** Fixed step duration in seconds (= 1 / fixedHz). */
  readonly fixedDt: number;

  // ── Internals ────────────────────────────────────────────────────────────
  private readonly _fixed:    FixedFn[]    = [];
  private readonly _variable: VariableFn[] = [];
  private readonly _engine:   WebGPUEngine;

  private _accumulator  = 0;
  private _totalElapsed = 0;
  private _paused       = false;

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(engine: WebGPUEngine, fixedHz: number = DEFAULT_FIXED_HZ) {
    this._engine = engine;
    this.fixedHz = fixedHz;
    this.fixedDt = 1 / fixedHz;
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /** Register a callback to fire at the fixed physics rate. */
  addFixed(fn: FixedFn):       void { this._fixed.push(fn); }
  /** Register a callback to fire every browser frame (variable rate). */
  addVariable(fn: VariableFn): void { this._variable.push(fn); }

  // ── Control ───────────────────────────────────────────────────────────────

  /** Freeze the fixed accumulator.  Variable (render) callbacks still run. */
  pause(): void  { this._paused = true;  }
  /** Resume fixed-step execution. */
  resume(): void { this._paused = false; }

  get isPaused():     boolean { return this._paused; }
  /** Total simulated time in seconds (not counting paused intervals). */
  get totalElapsed(): number  { return this._totalElapsed; }

  // ── Main loop ─────────────────────────────────────────────────────────────

  /**
   * Starts Babylon's render loop.  Call once after all callbacks are
   * registered and the scene is ready.
   */
  start(): void {
    this._engine.runRenderLoop(() => {
      // getDeltaTime() returns milliseconds → convert to seconds.
      const frameTime = Math.min(
        this._engine.getDeltaTime() / 1000,
        MAX_FRAME_TIME,
      );

      if (!this._paused) {
        this._accumulator  += frameTime;
        this._totalElapsed += frameTime;

        // Drain the accumulator in fixed steps.
        while (this._accumulator >= this.fixedDt) {
          for (let i = 0; i < this._fixed.length; i++) {
            this._fixed[i](this.fixedDt);
          }
          this._accumulator -= this.fixedDt;
        }
      }

      // alpha ∈ [0, 1) – how far we are into the next fixed step.
      // Used by RenderSystem to interpolate between previous and current
      // transform states (reserved for sub-step interpolation in Phase 4).
      const alpha = this._accumulator / this.fixedDt;
      for (let i = 0; i < this._variable.length; i++) {
        this._variable[i](alpha);
      }
    });
  }

  /** Stop the render loop indefinitely. */
  stop(): void { this._engine.stopRenderLoop(); }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Execute one manual fixed step without going through the render loop.
   * Useful for unit tests and deterministic replay.
   */
  tick(dt: number): void {
    for (let i = 0; i < this._fixed.length; i++) this._fixed[i](dt);
  }
}
