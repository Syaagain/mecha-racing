import { WebGPUEngine } from '@babylonjs/core';

/**
 * Loop – drives ECS systems via Babylon's engine.runRenderLoop().
 *
 * Fixed systems (physics, collision) are ticked at FIXED_HZ.
 * Variable systems (camera, render sync) run every Babylon frame.
 */
export type SystemFn = (delta: number) => void;
export type VariableFn = (alpha: number) => void;

const FIXED_HZ       = 60;
const FIXED_DT       = 1 / FIXED_HZ;
const MAX_FRAME_TIME = 0.25;

export class Loop {
  private fixedSystems:    SystemFn[]   = [];
  private variableSystems: VariableFn[] = [];
  private accumulator = 0;
  private engine: WebGPUEngine;

  constructor(engine: WebGPUEngine) {
    this.engine = engine;
  }

  addFixed(fn: SystemFn):      void { this.fixedSystems.push(fn); }
  addVariable(fn: VariableFn): void { this.variableSystems.push(fn); }

  start(): void {
    this.engine.runRenderLoop(() => {
      // getDeltaTime() returns milliseconds
      let frameTime = this.engine.getDeltaTime() / 1000;
      if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;

      this.accumulator += frameTime;
      while (this.accumulator >= FIXED_DT) {
        for (const sys of this.fixedSystems) sys(FIXED_DT);
        this.accumulator -= FIXED_DT;
      }

      const alpha = this.accumulator / FIXED_DT;
      for (const sys of this.variableSystems) sys(alpha);
    });
  }

  stop(): void {
    this.engine.stopRenderLoop();
  }

  /**
   * Manually execute one fixed step – useful for testing and diagram-conformant
   * consumers that call Loop.tick(dt) directly.
   */
  tick(dt: number): void {
    for (const sys of this.fixedSystems) sys(dt);
  }
}
