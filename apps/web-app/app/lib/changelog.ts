import changelogSource from "../../../../CHANGELOG.md?raw";

/**
 * The repository's own `CHANGELOG.md`, as text.
 *
 * Only the file is here. The parsing lives in `@pocketcircle/domain` because the
 * apex's static What's New page parses the same markdown at build time, and one
 * reader of one document is the point — see that module for why the `?raw`
 * import itself cannot be shared.
 */
export { changelogSource };
