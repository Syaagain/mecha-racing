/**
 * InputComponent – ECS data written by InputSystem each frame.
 *
 * throttle:  -1 (full brake/reverse) .. 0 .. +1 (full gas)
 * steering:  -1 (full left)          .. 0 .. +1 (full right)
 * handbrake:  0 = off,                         1 = engaged (Space)
 * actions:   Uint8Array bitfield – bit 0 = boost (ShiftLeft)
 */
export interface InputComponent {
  throttle:  number;
  steering:  number;
  handbrake: number;
  actions:   Uint8Array;
}

export function createInput(): InputComponent {
  return { throttle: 0, steering: 0, handbrake: 0, actions: new Uint8Array(1) };
}
