import { combineRssSources, processImageMemory, rssSource, selectHookRss, type HookRssReading, type HookRssSources } from "./hook-resources.ts";

const SOURCES = ["VmHWM", "vmpeak-bound", "platform-rusage", "raw-fallback", "unavailable"] as const;
export const rssSourceCode = (value: HookRssReading): number => SOURCES.indexOf(value.source);
function reading(kb: unknown, raw: unknown, code: unknown): HookRssReading | undefined {
  if (!Number.isSafeInteger(kb) || (kb as number) < 0 || !Number.isSafeInteger(raw) || (raw as number) < 0 || !Number.isSafeInteger(code) || (code as number) < 0 || (code as number) >= SOURCES.length) return;
  const source = SOURCES[code as number]!;
  if ((code as number) < 3 && (kb as number) <= 0) return;
  return { kb: kb as number, rawKB: raw as number, source, known: (code as number) < 3 };
}
type Image = ReturnType<typeof processImageMemory>;
interface Native { pid: number; image?: Image; result?: HookRssReading }

/** Bounded numeric progress survives worker timeout; no native arguments or project data enter it. */
export class HookWorkerRss {
  private entered = false;
  private invalid = false;
  private readonly native = new Map<number, Native>();
  private readonly active = new Set<number>();
  private readonly overlaps: number[][] = [];
  private image: Image = {};
  private self?: HookRssReading;
  constructor(private readonly pid: number) {}
  invalidate(): void { this.invalid = true; }
  frame(value: unknown): void {
    if (!Array.isArray(value)) { this.invalid = true; return; }
    const [kind, id, pid] = value;
    if (kind === 0 && value.length === 1 && !this.entered) { this.entered = true; return; }
    if (!this.entered) { this.invalid = true; return; }
    if (kind === 3 && value.length === 4) {
      const selected = reading(value[1], value[2], value[3]);
      if (!selected) this.invalid = true; else this.self = selected;
      return;
    }
    if (!Number.isSafeInteger(id) || id < 1 || id > 64) { this.invalid = true; return; }
    if (kind === 1 && value.length === 3 && Number.isSafeInteger(pid) && pid >= 0) {
      const prior = this.native.get(id);
      if (!prior && this.native.size < 64 && pid === 0) {
        this.native.set(id, { pid }); this.active.add(id); this.overlaps.push([...this.active]); return;
      }
      if (prior && prior.pid === 0 && !prior.result && pid > 0) { prior.pid = pid; return; }
    }
    if (kind === 2 && value.length === 6) {
      const prior = this.native.get(id), selected = reading(value[2], value[3], value[4]);
      // Reserved final slot must remain zero, so protocol extensions cannot be misread.
      if (prior && !prior.result && selected && value[5] === 0) { prior.result = selected; this.active.delete(id); return; }
    }
    this.invalid = true;
  }
  captureLive(read: typeof processImageMemory = processImageMemory): void {
    const retain = (before: Image | undefined, after: Image): Image => ({
      hwmKB: Math.max(before?.hwmKB ?? 0, after.hwmKB ?? 0) || undefined,
      virtualKB: Math.max(before?.virtualKB ?? 0, after.virtualKB ?? 0) || undefined,
    });
    this.image = retain(this.image, read(this.pid));
    for (const id of this.active) {
      const value = this.native.get(id)!;
      if (value.pid > 0) value.image = retain(value.image, read(value.pid));
    }
  }
  finish(rawWorkerKB: number, platform = process.platform): { rssKB: number; rawRssKB: number; rssSources: HookRssSources } {
    const self = this.self;
    const hwm = Math.max(this.image.hwmKB ?? 0, self?.source === "VmHWM" ? self.kb : 0);
    const virtual = Math.max(this.image.virtualKB ?? 0, self?.source === "vmpeak-bound" ? self.kb : 0);
    const ownRaw = platform !== "linux" && self?.source === "platform-rusage" ? self.kb : rawWorkerKB;
    const own = selectHookRss(platform, hwm, ownRaw, virtual);
    const sources = [rssSource(own)];
    const native = new Map<number, HookRssReading>();
    for (const [id, value] of this.native) {
      const given = value.result;
      const selected = given && !given.known && !value.image?.hwmKB && !value.image?.virtualKB ? given : selectHookRss(platform,
        Math.max(value.image?.hwmKB ?? 0, given?.source === "VmHWM" ? given.kb : 0), given?.rawKB ?? 0,
        Math.max(value.image?.virtualKB ?? 0, given?.source === "vmpeak-bound" ? given.kb : 0));
      native.set(id, selected); sources.push(rssSource(selected));
    }
    let nativeKB = 0;
    for (const group of this.overlaps) {
      nativeKB = Math.max(nativeKB, group.reduce((sum, id) => sum + native.get(id)!.kb, 0));
    }
    const rssSources = combineRssSources(...sources);
    if (this.invalid) rssSources.unavailable++;
    const combined = own.kb + nativeKB;
    return { rssKB: platform === "linux" ? combined : Math.max(combined, rawWorkerKB), rawRssKB: rawWorkerKB, rssSources };
  }
}
