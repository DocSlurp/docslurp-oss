/**
 * V8 flags for every Node command in the parser VM (council r2 H1, r3 L3): no code generation from strings (`eval`,
 * `new Function`, string timers), in the command and in the worker threads it starts (they take the flag from their
 * process; it cannot be set per worker). Defence in depth inside the VM, which stays the boundary.
 */
export const GUEST_NODE_FLAGS: readonly string[] = ["--disallow-code-generation-from-strings"];
