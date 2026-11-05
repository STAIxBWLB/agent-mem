import { expect, test } from "bun:test";
import { timeoutDescendantReceipt, timeoutOwnedGroupsGone } from "./fakes/hooks-timeout-probe.ts";

test("timeout descendant receipts distinguish complete, incomplete and empty positive-PID lists", () => {
  expect(timeoutDescendantReceipt("12\n34\n", 2)).toEqual({ pids: [12, 34], valid: true, complete: true, incomplete: false });
  expect(timeoutDescendantReceipt("12\n", 2)).toEqual({ pids: [12], valid: true, complete: false, incomplete: true });
  expect(timeoutDescendantReceipt(" \n", 2)).toEqual({ pids: [], valid: true, complete: false, incomplete: true });
  expect(timeoutDescendantReceipt("12 34 56", 2).incomplete).toBe(false);
});

test("malformed timeout PID tokens never qualify as incomplete or reach alive/cleanup probes", () => {
  for (const token of ["0", "-12", "+12", "1.2", "1e2", "Infinity", "NaN", "9007199254740992", "12x"]) {
    const result = timeoutDescendantReceipt(`34 ${token}`, 3);
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.pids).toEqual([34]);
  }
});

test("fresh group census detects an orphan even after its leader and receipted child exit", () => {
  expect(timeoutOwnedGroupsGone(" 1 1\n 99 42\n", [42])).toBe(false);
  expect(timeoutOwnedGroupsGone(" 0 0\n 1 1\n 99 43\n", [42])).toBe(true);
});

test("unknown or malformed process census stays strict", () => {
  for (const table of ["", " \n", "1", "1 2 extra", "-1 2", "1 -1", "9007199254740992 1", "1 9007199254740992"])
    expect(() => timeoutOwnedGroupsGone(table, [42])).toThrow("R1 process table unavailable");
});
