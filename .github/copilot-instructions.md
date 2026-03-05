# Mecha-Racing Copilot Instructions (ECS Variante 1)

## Architektur-Regeln
- Wir nutzen ein striktes **Entity Component System (ECS)**.
- **Components**: Reine Datenklassen in `src/game/components/`. Verwende `Float32Array` für mathematische Daten (Matrizen, Vektoren).
- **Systems**: Reine Logik in `src/game/systems/`. Sie müssen von `System` erben und die `update(dt, world)` Methode implementieren.
- **Engine-Entkopplung**: Logik darf nicht direkt in Babylon-Dateien stehen, sondern muss über das `RenderSystem` synchronisiert werden.

## WebGPU & Performance
- Nutze für alle Mesh-Wiederholungen **Thin Instances** (`thinInstanceSetBuffer`).
- Vermeide Garbage Collection: Erzeuge keine neuen Vektoren (`new Vector3`) in den `update`-Methoden; nutze stattdessen vorhandene Buffer.
- Bevorzuge `WebGPUEngine` gegenüber der Standard `Engine`.

## Dateistruktur
- Halte dich strikt an die Ordnerstruktur: `src/engine/core`, `src/engine/babylon`, `src/game/components`, `src/game/systems`# Project: Mecha-Racing MVP (WebGPU + Babylon.js)
# Architecture: Entity Component System (ECS) - Variante 1

## Core Principles
- **Data-Oriented Design**: Components are PURE DATA (POJOs or TypedArrays). NO logic inside components.
- **Decoupled Logic**: Systems handle all logic and do not store local entity state. State must reside in Components.
- **WebGPU Performance**: Mandatory use of `WebGPUEngine`. Minimize draw calls via Thin Instances.
- **Memory Management**: Reuse objects/vectors (Pool-Pattern) inside systems to avoid Garbage Collection in the game loop.
- **Strict TypeScript**: Use `readonly` for immutable data, explicit types, and NO `any`.

## Folder Structure (Strict Enforcement)
- `src/engine/core/`: ECS Kernel (World, System, Loop, EventBus, GameStateManager)
- `src/engine/babylon/`: Babylon Setup (BabylonCore/SceneManager, MaterialManager)
- `src/engine/assets/`: AssetLoader (Babylon AssetsManager integration)
- `src/game/components/`: Component schemas (Transform, Physics, Input, Renderable, Collider)
- `src/game/systems/`: Logic (InputSystem, PhysicsSystem, RenderSystem, CameraSystem)
- `src/game/world/`: LevelBuilder (Entity Factory & Scene Population)

## Implementation Details
1. **World.ts**: Centralized entity management. Component storage must use TypedArrays (e.g., Float32Array for Transform matrices) for GPU-buffer compatibility.
2. **System.ts**: Abstract class `System { abstract update(dt: number, world: World): void }`.
3. **RenderSystem**: BRIDGE between ECS and Babylon. Must NOT contain physics. Tasks: Update `thinInstanceSetBuffer` using `TransformComponent` data.
4. **InputSystem**: Translates raw `KeyboardEvent` into `InputComponent` values (Normalized: -1 to 1 for steering, 0 to 1 for throttle).
5. **PhysicsSystem**: Implementation of semi-fixed timestep. Updates `TransformComponent` based on `PhysicsComponent` (velocities/mass).

## Sequence Flow & Rules
1. **Bootstrapping**: `App.ts` initializes `BabylonCore` (WebGPU) -> `World` -> `AssetLoader`.
2. **World Building**: `LevelBuilder` spawns entities only AFTER `AssetLoader` confirms assets are ready.
3. **Loop Execution Order**:
   - `InputSystem` (Reads hardware -> Writes InputComponent)
   - `PhysicsSystem` (Reads Input & Physics -> Writes Transform)
   - `CameraSystem` (Reads Transform -> Updates Babylon Camera)
   - `RenderSystem` (Reads Transform -> Syncs Babylon Meshes/ThinInstances)
4. **Communication**: Use `EventBus` for one-time events (e.g., `COLLISION_EVENT`, `UI_TRIGGER`).
 Never use events for frame-by-frame data.

## Debugging Standards
- **Logging**: Do not log every frame. Use conditional logging (e.g., if entity is player).
- **Assertions**: Use `console.assert` in Systems to catch NaN or Infinity values in TypedArrays early.
- **Visual Helpers**: Every system should have an optional 'debugMode' to render wireframes or velocity vectors.