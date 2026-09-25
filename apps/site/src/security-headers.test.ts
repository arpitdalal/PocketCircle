import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const productHeaders = readFileSync(
  join(import.meta.dirname, "../../web-app/public/_headers"),
  "utf8",
);
const siteHeaders = readFileSync(join(import.meta.dirname, "../public/_headers"), "utf8");

/**
 * `_headers` rules, keyed by path. A rule is a path line followed by indented
 * `Name: value` lines; a blank line ends it.
 */
function rules(file: string) {
  const parsed = new Map<string, string[]>();
  for (const block of file.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    const [path, ...headers] = lines;
    if (path && headers.length > 0) {
      parsed.set(
        path.trim(),
        headers.map((header) => header.trim()),
      );
    }
  }
  return parsed;
}

const product = rules(productHeaders);
const site = rules(siteHeaders);

describe("security headers", () => {
  it("the Site serves the same global headers the product does", () => {
    // Two Workers, one policy. The product's file is checked in and its build is
    // out of scope here, so the copy is guarded rather than generated — if the
    // product changes a header, this fails instead of the Site quietly keeping
    // the older policy.
    expect(site.get("/*")).toEqual(product.get("/*"));
  });

  it("covers every path on the Site, not just the homepage", () => {
    expect(site.has("/*")).toBe(true);
  });

  it("parses both files, so an equality above cannot pass on two missing rules", () => {
    expect(product.get("/*")).toBeDefined();
    expect(site.get("/*")).toBeDefined();
  });
});
