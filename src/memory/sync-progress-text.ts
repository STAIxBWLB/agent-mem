import type { PlacementWriterRefusal } from "./sync-placement-refusal-category.ts";

export function writerRefusalText({ causeClass, rootCategory }: PlacementWriterRefusal): string {
  const writerRoot = rootCategory !== "active locator" && rootCategory !== "home floor";
  const renewal = rootCategory === "writer renewal" || (writerRoot && causeClass !== "unavailable");
  return `${renewal ? "writer renewal needed" : "writer proof refused"} (${rootCategory}, ${causeClass})`;
}
