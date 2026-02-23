import {
  WebGPUEngine,
  Scene,
  Color3,
  Color4,
  HemisphericLight,
  Vector3,
  Material,
} from '@babylonjs/core';

/**
 * BabylonCore – owns the WebGPUEngine, Scene, and material registry.
 * Replaces the old Device + BufferManager + PipelineManager trio.
 */
export class BabylonCore {
  private static _instance: BabylonCore | null = null;

  private _engine!: WebGPUEngine;
  private _scene!: Scene;
  private _materials = new Map<string, Material>();

  private constructor() {}

  static getInstance(): BabylonCore {
    if (!BabylonCore._instance) BabylonCore._instance = new BabylonCore();
    return BabylonCore._instance;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this._engine = new WebGPUEngine(canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
    });
    await this._engine.initAsync();

    this._scene = new Scene(this._engine);
    this._scene.clearColor = new Color4(0.05, 0.05, 0.1, 1);

    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this._scene);
    ambient.intensity   = 0.6;
    ambient.diffuse     = new Color3(0.8, 0.8, 1.0);
    ambient.groundColor = new Color3(0.2, 0.1, 0.3);

    this._scene.fogMode    = Scene.FOGMODE_EXP;
    this._scene.fogColor   = new Color3(0.05, 0.05, 0.1);
    this._scene.fogDensity = 0.004;

    window.addEventListener('resize', () => this._engine.resize());
  }

  /** Register a material by ID for later retrieval. */
  registerMaterial(id: string, mat: Material): void {
    this._materials.set(id, mat);
  }

  /** Retrieve a cached material by ID. */
  getMaterial(id: string): Material | undefined {
    return this._materials.get(id);
  }

  get engine(): WebGPUEngine { return this._engine; }
  get scene(): Scene          { return this._scene; }

  dispose(): void {
    this._scene.dispose();
    this._engine.dispose();
    BabylonCore._instance = null;
  }
}

/** Backward-compat alias – prefer BabylonCore in new code. */
export { BabylonCore as SceneManager };
