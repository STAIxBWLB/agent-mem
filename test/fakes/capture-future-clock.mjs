// Test-only advancing wall clock. Explicit timestamps and performance.now stay unchanged.
// Reapply the preload to Bun children even when a fixture deliberately restricts env.
const installed = Symbol.for('amem.capture-future-clock');
if (!globalThis[installed]) {
  globalThis[installed] = true;
  const NativeDate = Date, offset = 180 * 24 * 60 * 60 * 1000;
  globalThis.Date = new Proxy(NativeDate, {
    get(target, key, receiver) {
      return key === 'now' ? () => NativeDate.now() + offset : Reflect.get(target, key, receiver);
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [NativeDate.now() + offset], newTarget);
    },
    apply() { return new NativeDate(NativeDate.now() + offset).toString(); },
  });
  for (const method of ['spawn', 'spawnSync']) {
    const native = Bun[method].bind(Bun);
    Bun[method] = (command, options) => {
      if (Array.isArray(command) && command[0] === process.execPath) {
        const env = options?.env ?? process.env;
        return native(command, { ...options, env: { ...env,
          BUN_OPTIONS: `${env.BUN_OPTIONS ?? ''} --preload=${JSON.stringify(import.meta.path)}`,
        } });
      }
      return native(command, options);
    };
  }
}
