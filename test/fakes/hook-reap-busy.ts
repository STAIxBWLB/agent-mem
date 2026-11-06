// No descendants or I/O after readiness: this is the slow-store fixture's CPU-only failure class.
export {};
await Bun.write(Bun.stdout, "ready\n");
for (;;) { Math.sqrt(performance.now()); }
