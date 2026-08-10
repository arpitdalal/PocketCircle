import { describe, expect, it } from "vitest";
import { historicalMemberStatusDetail } from "./member-status-label.js";

describe("historicalMemberStatusDetail", () => {
  it("labels removed and deleted distinctly", () => {
    expect(historicalMemberStatusDetail("removed")).toBe("removed");
    expect(historicalMemberStatusDetail("deleted")).toBe("deleted account");
    expect(historicalMemberStatusDetail("active")).toBeUndefined();
  });
});
