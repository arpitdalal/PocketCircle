import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globalSecurityHeadersRule } from "./security-headers.js";

/** The policy file both Workers derive their headers from. */
const productHeaders = readFileSync(
  join(import.meta.dirname, "../../web-app/public/_headers"),
  "utf8",
);

describe("the Site's security headers", () => {
  it("are the product's global rule, header for header", () => {
    expect(globalSecurityHeadersRule(productHeaders)).toBe(
      productHeaders.slice(0, productHeaders.indexOf("\n\n") + 1),
    );
  });

  it("drop the product's rules for files the Site does not have", () => {
    // `/push-sw.js` is a product asset. A rule for it would match nothing here.
    expect(globalSecurityHeadersRule(productHeaders)).not.toContain("push-sw");
  });

  it("fail loudly rather than publish a Site with no headers", () => {
    expect(() => globalSecurityHeadersRule("/assets/*\n  Cache-Control: public\n")).toThrow(
      "no /* rule",
    );
  });
});
