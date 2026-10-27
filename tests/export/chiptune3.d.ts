declare module 'chiptune3/libopenmpt.worklet.js' {
  /** Emscripten factory for libopenmpt. */
  const libopenmpt: () => Promise<Record<string, any>>;
  export default libopenmpt;
}
