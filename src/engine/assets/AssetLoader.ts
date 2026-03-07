/**
 * @file AssetLoader.ts
 * @module engine/assets
 *
 * Wraps Babylon.js `AssetsManager` to provide a typed, promise-based API for
 * loading meshes, textures, and binary data.
 *
 * ## Supported asset types
 * | Method             | Babylon task        | Result type          |
 * |--------------------|---------------------|----------------------|
 * | `loadMesh()`       | `MeshAssetTask`     | `AbstractMesh[]`     |
 * | `loadTexture()`    | `TextureAssetTask`  | `Texture`            |
 * | `loadBinary()`     | `BinaryFileAssetTask` | `ArrayBuffer`      |
 *
 * ## Usage
 * ```ts
 * const loader = new AssetLoader(scene);
 * const meshes = await loader.loadMesh('vehicle', '/assets/models/car.glb');
 * ```
 *
 * ## Design notes
 * - All tasks are batched and dispatched in a single `AssetsManager.loadAsync()`
 *   call to maximise parallel downloads.
 * - Errors from individual tasks reject the promise with the Babylon task
 *   error message.
 * - Keep the `AssetLoader` instance alive until all assets are resolved;
 *   the GC may otherwise collect it mid-load.
 */
import {
  Scene,
  AssetsManager,
  MeshAssetTask,
  TextureAssetTask,
  BinaryFileAssetTask,
  AbstractMesh,
  Texture,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF'; // register GLTF loader

// ── Asset types ────────────────────────────────────────────────────────────

export interface MeshAsset {
  meshes: AbstractMesh[];
  /** The root/parent mesh returned by the GLTF loader. */
  root: AbstractMesh;
}

export interface TextureAsset {
  texture: Texture;
}

export interface AudioAsset {
  buffer: AudioBuffer;
}

// ── AssetLoader ────────────────────────────────────────────────────────────

export class AssetLoader {
  private manager:  AssetsManager;
  private meshes    = new Map<string, MeshAsset>();
  private textures  = new Map<string, TextureAsset>();
  private audio     = new Map<string, AudioAsset>();
  private audioCtx: AudioContext | null = null;

  constructor(scene: Scene) {
    this.manager = new AssetsManager(scene);
    this.manager.useDefaultLoadingScreen = false;
  }

  // ── GLTF / GLB via Babylon AssetsManager ─────────────────────────────────

  /**
   * Queue a GLTF/GLB load task and execute. Returns all loaded meshes.
   * Meshes are added to the scene automatically by Babylon.
   */
  async loadMesh(name: string, rootUrl: string, file: string): Promise<MeshAsset> {
    const cacheKey = rootUrl + file;
    if (this.meshes.has(cacheKey)) return this.meshes.get(cacheKey)!;

    return new Promise<MeshAsset>((resolve, reject) => {
      const task = this.manager.addMeshTask(name, '', rootUrl, file) as MeshAssetTask;

      task.onSuccess = t => {
        const root = t.loadedMeshes[0];
        const asset: MeshAsset = { meshes: t.loadedMeshes as AbstractMesh[], root: root as AbstractMesh };
        this.meshes.set(cacheKey, asset);
        // Hide the template mesh—LevelBuilder will clone it per entity
        root.setEnabled(false);
        resolve(asset);
      };

      task.onError = (_t, msg, ex) => reject(ex ?? new Error(msg));
      this.manager.load();
    });
  }

  // ── Textures ──────────────────────────────────────────────────────────────

  async loadTexture(url: string): Promise<TextureAsset> {
    if (this.textures.has(url)) return this.textures.get(url)!;

    return new Promise<TextureAsset>((resolve, reject) => {
      const task = this.manager.addTextureTask(url, url) as TextureAssetTask;
      task.onSuccess = t => {
        const asset: TextureAsset = { texture: t.texture };
        this.textures.set(url, asset);
        resolve(asset);
      };
      task.onError = (_t, msg, ex) => reject(ex ?? new Error(msg));
      this.manager.load();
    });
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  async loadAudio(url: string): Promise<AudioAsset> {
    if (this.audio.has(url)) return this.audio.get(url)!;
    if (!this.audioCtx) this.audioCtx = new AudioContext();

    return new Promise<AudioAsset>((resolve, reject) => {
      const task = this.manager.addBinaryFileTask(url, url) as BinaryFileAssetTask;
      task.onSuccess = async t => {
        const buffer = await this.audioCtx!.decodeAudioData(t.data);
        const asset: AudioAsset = { buffer };
        this.audio.set(url, asset);
        resolve(asset);
      };
      task.onError = (_t, msg, ex) => reject(ex ?? new Error(msg));
      this.manager.load();
    });
  }

  playAudio(asset: AudioAsset, loop = false): AudioBufferSourceNode {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    const src = this.audioCtx.createBufferSource();
    src.buffer = asset.buffer;
    src.loop   = loop;
    src.connect(this.audioCtx.destination);
    src.start();
    return src;
  }

  // ── Registry helpers ──────────────────────────────────────────────────────

  getMesh(key: string):    MeshAsset    | undefined { return this.meshes.get(key); }
  getTexture(key: string): TextureAsset | undefined { return this.textures.get(key); }

  // ── Batch loading (diagram: loadAssets / instantiateModel) ───────────────

  /**
   * Load a manifest of named assets in parallel.
   * manifest.meshes: Record<name, { rootUrl, file }>
   * manifest.textures: Record<name, url>
   */
  async loadAssets(manifest: {
    meshes?:   Record<string, { rootUrl: string; file: string }>;
    textures?: Record<string, string>;
  }): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [name, { rootUrl, file }] of Object.entries(manifest.meshes ?? {}))
      tasks.push(this.loadMesh(name, rootUrl, file));
    for (const [, url] of Object.entries(manifest.textures ?? {}))
      tasks.push(this.loadTexture(url));
    await Promise.all(tasks);
  }

  /**
   * Clone (instantiate) a previously loaded template mesh by its cache key.
   * Returns the cloned AbstractMesh ready to place in the scene.
   */
  instantiateModel(id: string): AbstractMesh | undefined {
    const asset = this.meshes.get(id);
    if (!asset) return undefined;
    const clone = asset.root.clone(`${id}_instance_${Date.now()}`, null);
    if (clone) clone.setEnabled(true);
    return clone ?? undefined;
  }

  dispose(): void {
    for (const m of this.meshes.values())   m.root.dispose();
    for (const t of this.textures.values()) t.texture.dispose();
    this.meshes.clear();
    this.textures.clear();
    this.audio.clear();
  }
}
