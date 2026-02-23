/**
 * InputComponent – ECS data written by InputSystem each frame.
 *
 * throttle: -1 (brake) .. 0 .. +1 (full gas)
 * steering: -1 (left)  .. 0 .. +1 (right)
 * actions:  Uint8Array bitfield – bit 0 = boost
 */
export interface InputComponent {
  throttle: number;
  steering: number;
  actions:  Uint8Array;
}

export function createInput(): InputComponent {
  return { throttle: 0, steering: 0, actions: new Uint8Array(1) };
}
