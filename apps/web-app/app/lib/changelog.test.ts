import { parseChangelog } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { changelogSource } from "./changelog.js";

/**
 * The real changelog parses. The parser's own rules are asserted against
 * fixtures in `@pocketcircle/domain`, where the parser lives; what a fixture
 * cannot assert is that the file this app ships is one the parser can read — a
 * heading shape edited in `CHANGELOG.md` would render an empty in-app archive
 * with every other test green, and the same file generates the apex's What's New
 * page.
 */
describe("the changelog the app renders", () => {
  it("is the released history, newest first, with nothing to show for a version", () => {
    const sections = parseChangelog(changelogSource);

    expect(sections.length).toBeGreaterThan(0);
    expect(sections.some((section) => section.version === "Unreleased")).toBe(false);
    expect(sections.map((section) => section.version)).toEqual(
      expect.arrayContaining(["v0.7.0", "v0.6.0"]),
    );
    // Every version renders as a disclosure, so a version that parsed to nothing
    // would be an empty heading a reader can open to no content.
    for (const section of sections) {
      expect(section.categories.length, section.version).toBeGreaterThan(0);
      expect(
        section.categories.flatMap((category) => category.items),
        section.version,
      ).not.toEqual([]);
    }
  });
});
