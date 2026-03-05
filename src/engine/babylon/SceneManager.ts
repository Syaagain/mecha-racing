import {
  WebGPUEngine,
  Scene,
  Color3,
  Color4,
  HemisphericLight,
  ArcRotateCamera,
  Vector3,
  Material,
} from '@babylonjs/core';

/**
 * BabylonCore – singleton that owns the WebGPU engine, scene, default camera
 * and material registry.
 *
 * ## Initialisation sequence
 * 1. `BabylonCore.getInstance().init(canvas)` — call once from `App.run()`.
 * 2. Creates a `WebGPUEngine` (mandatory per architecture rules).
 * 3. Adds a default **ArcRotateCamera** as a fallback / debug camera.
 *    `CameraSystem` attaches a `FollowCamera` to the active player entity
 *    and makes it the active scene camera; the arc-rotate camera is then
 *    only used when no ECS camera entity exists.
 * 4. Adds a `HemisphericLight` for ambient illumination.
 * 5. Configures scene fog.
 *
 * ## Notes
 * - Do NOT put game logic here.  All logic belongs in Systems.
 * - `registerMaterial` / `getMaterial` hold engine-level shared materials;
 *   game-specific PBR materials are managed by `MaterialManager`.
 */
export class BabylonCore {
  private static _instance: BabylonCore | null = null;

  private _engine!: WebGPUEngine;
  private _scene!: Scene;
  /** Default ArcRotateCamera – active until CameraSystem attaches its own. */
  private _defaultCamera!: ArcRotateCamera;
  private _materials = new Map<string, Material>();

  private constructor() {}

  static getInstance(): BabylonCore {
    if (!BabylonCore._instance) BabylonCore._instance = new BabylonCore();
    return BabylonCore._instance;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    // ── 1. WebGPU engine ────────────────────────────────────────────────────
    this._engine = new WebGPUEngine(canvas, {
      antialias:           true,
      adaptToDeviceRatio:  true,
    });
    await this._engine.initAsync();

    // ── 2. Scene ─────────────────────────────────────────────────────────────
    this._scene = new Scene(this._engine);
    this._scene.clearColor = new Color4(0.05, 0.05, 0.1, 1);

    // ── 3. Default camera (ArcRotate – debug / fallback) ────────────────────
    //    Radius / alpha / beta give a nice top-down-ish overview of the track.
    //    CameraSystem replaces the active camera once a player entity exists.
    this._defaultCamera = new ArcRotateCamera(
      'cam_default',
      -Math.PI / 2,   // alpha  – horizontal orbit angle
      Math.PI  / 3,   // beta   – vertical orbit angle (~60° above horizon)
      30,             // radius – distance from target
      Vector3.Zero(), // target – world origin
      this._scene,
    );
    this._defaultCamera.lowerRadiusLimit  =  5;
    this._defaultCamera.upperRadiusLimit  = 200;
    this._defaultCamera.wheelDeltaPercentage = 0.01;
    // Allow mouse/touch orbit in the browser during development.
    this._defaultCamera.attachControl(canvas, true);

    // ── 4. Ambient light ─────────────────────────────────────────────────────
    const ambient = new HemisphericLight(
      'light_ambient',
      new Vector3(0, 1, 0),
      this._scene,
    );
    ambient.intensity   = 0.6;
    ambient.diffuse     = new Color3(0.8, 0.8, 1.0);
    ambient.groundColor = new Color3(0.2, 0.1, 0.3);

    // ── 5. Scene-level fog ────────────────────────────────────────────────────
    this._scene.fogMode    = Scene.FOGMODE_EXP;
    this._scene.fogColor   = new Color3(0.05, 0.05, 0.1);
    this._scene.fogDensity = 0.004;

    window.addEventListener('resize', () => this._engine.resize());
  }

  // ── Material registry ─────────────────────────────────────────────────────

  /** Register a shared engine-level material by ID. */
  registerMaterial(id: string, mat: Material): void {
    this._materials.set(id, mat);
  }

  /** Retrieve a cached engine-level material by ID. */
  getMaterial(id: string): Material | undefined {
    return this._materials.get(id);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get engine(): WebGPUEngine        { return this._engine; }
  get scene():  Scene               { return this._scene; }
  get defaultCamera(): ArcRotateCamera { return this._defaultCamera; }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    this._scene.dispose();
    this._engine.dispose();
    BabylonCore._instance = null;
  }
}

/** Backward-compat alias – prefer BabylonCore in new code. */
export { BabylonCore as SceneManager };
