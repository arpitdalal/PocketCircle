import { describe, expect, it } from "vitest";
import { changelogSource, parseChangelog } from "./changelog.js";

describe("parseChangelog", () => {
  it("ignores the Keep a Changelog preamble until the first version heading", () => {
    const sections = parseChangelog(`# Changelog

All notable user-facing changes are documented here.

## [v1.0.0] - 2026-01-02

### Added

- First item
`);

    expect(sections).toEqual([
      {
        version: "v1.0.0",
        date: "2026-01-02",
        intro: [],
        categories: [{ heading: "Added", items: ["First item"] }],
      },
    ]);
  });

  it("skips Unreleased and any body until the next version heading", () => {
    const sections = parseChangelog(`## [Unreleased]

### Added

- Secret unreleased work

## [v1.0.0] - 2026-01-02

### Fixed

- Shipped fix
`);

    expect(sections).toEqual([
      {
        version: "v1.0.0",
        date: "2026-01-02",
        intro: [],
        categories: [{ heading: "Fixed", items: ["Shipped fix"] }],
      },
    ]);
  });

  it("keeps newest-first file order and stops each version at the next heading", () => {
    const sections = parseChangelog(`## [v1.1.0] - 2026-02-01

### Added

- Newer

## [v1.0.0] - 2026-01-02

### Added

- Older
`);

    expect(sections.map((section) => section.version)).toEqual(["v1.1.0", "v1.0.0"]);
    expect(sections[0]?.categories[0]?.items).toEqual(["Newer"]);
    expect(sections[1]?.categories[0]?.items).toEqual(["Older"]);
  });

  it("joins wrapped bullet continuation lines with spaces and omits empty groups", () => {
    const sections = parseChangelog(`## [v1.0.0] - 2026-01-02

### Added

- After you sign in, Home now shows a Cash flow report for one currency at a
  time: income, expenses, and net.

### Changed

### Fixed

- Flush the nav
`);

    expect(sections).toEqual([
      {
        version: "v1.0.0",
        date: "2026-01-02",
        intro: [],
        categories: [
          {
            heading: "Added",
            items: [
              "After you sign in, Home now shows a Cash flow report for one currency at a time: income, expenses, and net.",
            ],
          },
          { heading: "Fixed", items: ["Flush the nav"] },
        ],
      },
    ]);
  });

  it("treats pre-category lines as intro paragraphs and ignores unknown headings", () => {
    const sections = parseChangelog(`## [v0.1.0] - 2026-08-16

First public beta of PocketCircle — a place for partners, families, roommates,
and trip groups to track shared spending together.

Second paragraph.

### Added

- Sign in with Google.

### Notes

- Internal only

### Security

- Invite links work once.
`);

    expect(sections).toEqual([
      {
        version: "v0.1.0",
        date: "2026-08-16",
        intro: [
          "First public beta of PocketCircle — a place for partners, families, roommates, and trip groups to track shared spending together.",
          "Second paragraph.",
        ],
        categories: [
          { heading: "Added", items: ["Sign in with Google."] },
          { heading: "Security", items: ["Invite links work once."] },
        ],
      },
    ]);
  });

  it("skips headings that are not stable Keep a Changelog SemVer", () => {
    const sections = parseChangelog(`## [v1.0.0-beta] - 2026-01-01

### Added

- Pre-release

## [1.0.0] - 2026-01-02

### Added

- Missing v prefix

## [v01.0.0] - 2026-01-03

### Added

- Leading zero

## [v1.0.0] - 2026-01-04

### Deprecated

- Real release
`);

    expect(sections).toEqual([
      {
        version: "v1.0.0",
        date: "2026-01-04",
        intro: [],
        categories: [{ heading: "Deprecated", items: ["Real release"] }],
      },
    ]);
  });

  it("returns no sections for Unreleased-only files", () => {
    expect(
      parseChangelog(`# Changelog

## [Unreleased]

### Added

- Not shipped
`),
    ).toEqual([]);
  });

  it("parses the repo CHANGELOG.md without throwing and includes today's released versions", () => {
    const sections = parseChangelog(changelogSource);

    expect(sections.map((section) => section.version)).toEqual(
      expect.arrayContaining(["v0.2.0", "v0.1.0"]),
    );
    expect(sections.some((section) => section.version === "Unreleased")).toBe(false);
    expect(sections.find((section) => section.version === "v0.1.0")?.intro.length).toBeGreaterThan(
      0,
    );
  });
});
