/**
 * @file MaterialManager.ts
 * @module engine/babylon
 *
 * Central registry for Babylon.js materials used across the project.
 *
 * ## Responsibilities
 * - `createPBR(name, options)` — creates and caches a `PBRMaterial` with
 *   sensible metallic/roughness defaults.  Subsequent calls with the same
 *   name return the cached instance.
 * - `createNode(name, url)` — loads a `NodeMaterial` from a JSON snippet URL
 *   and registers it.  Async; resolves when the material is ready.
 * - `get(name)` — retrieves a previously created material by name, or
 *   `undefined` if not yet created.
 *
 * ## Usage
 * ```ts
 * const materials = new MaterialManager(scene);
 * materials.createPBR('vehicle', { metallic: 0.8, roughness: 0.3 });
 * const mat = materials.get('vehicle'); // PBRMaterial
 * ```
 */
import {
  Scene,
  PBRMaterial,
  NodeMaterial,
  Color3,
  Texture,
} from '@babylonjs/core';

export type MaterialKey = string;

/**
 * MaterialManager – creates and caches Babylon PBRMaterial / NodeMaterial.
 */
export class MaterialManager {
  private pbr  = new Map<MaterialKey, PBRMaterial>();
  private node = new Map<MaterialKey, NodeMaterial>();
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Create (or retrieve cached) a PBRMaterial.
   */
  createPBR(
    key: MaterialKey,
    opts: {
      albedoColor?: Color3;
      albedoTexture?: Texture;
      metallic?: number;
      roughness?: number;
      emissiveColor?: Color3;
    } = {},
  ): PBRMaterial {
    if (this.pbr.has(key)) return this.pbr.get(key)!;

    const mat = new PBRMaterial(key, this.scene);
    if (opts.albedoColor)   mat.albedoColor    = opts.albedoColor;
    if (opts.albedoTexture) mat.albedoTexture  = opts.albedoTexture;
    mat.metallic  = opts.metallic  ?? 0.4;
    mat.roughness = opts.roughness ?? 0.6;
    if (opts.emissiveColor) mat.emissiveColor  = opts.emissiveColor;

    this.pbr.set(key, mat);
    return mat;
  }

  /**
   * Load a NodeMaterial from a NME snippet or JSON URL.
   */
  async loadNodeMaterial(key: MaterialKey, snippetIdOrUrl: string): Promise<NodeMaterial> {
    if (this.node.has(key)) return this.node.get(key)!;

    let mat: NodeMaterial;

    if (snippetIdOrUrl.startsWith('http')) {
      mat = await NodeMaterial.ParseFromFileAsync(key, snippetIdOrUrl, this.scene);
    } else {
      mat = await NodeMaterial.ParseFromSnippetAsync(snippetIdOrUrl, this.scene);
      mat.name = key;
    }

    this.node.set(key, mat);
    return mat;
  }

  getPBR(key: MaterialKey):  PBRMaterial  | undefined { return this.pbr.get(key); }
  getNode(key: MaterialKey): NodeMaterial | undefined { return this.node.get(key); }

  dispose(): void {
    for (const m of this.pbr.values())  m.dispose();
    for (const m of this.node.values()) m.dispose();
    this.pbr.clear();
    this.node.clear();
  }
}
