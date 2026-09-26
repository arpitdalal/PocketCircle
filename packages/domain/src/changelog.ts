/**
 * Reading the repository's own `CHANGELOG.md` as released versions.
 *
 * The changelog is the one place PocketCircle's user-facing history is written
 * down, and it is read by two renderers: the app's in-app What's New archive
 * (`apps/web-app/app/routes/whats-new.tsx`, which opens the latest version and
 * records that the User has seen it) and the apex's static What's New page
 * (`apps/site/whats-new.html`, generated from the same file at build time). Two
 * renderers of one document is the whole reason the *parsing* lives here rather
 * than in either of them: a second reader of the same file is a second thing to
 * keep in step, and the two surfaces are already required to agree — the app
 * marks the archive read, the apex publishes it, and they are the same history.
 *
 * What is deliberately not here is the file itself. The markdown is imported
 * with Vite's `?raw`, from the repository root, which is a bundler feature and
 * a path outside this package — so each consumer that is a Vite build reads the
 * file and hands the text to {@link parseChangelog} instead
 * (`apps/web-app/app/lib/changelog.ts` for the app, `apps/site` for the Site).
 * This package is also loaded by the Convex functions and the MCP Worker, which
 * are not Vite builds, so an import it could not resolve would break them.
 *
 * The `./changelog` subpath export exists for the same reason `./origins` does:
 * this module is imported from `apps/site`'s `vite.config.ts`, which plain Node
 * loads rather than a bundler, and Node resolves the `.ts` extension of a
 * directly-named module but not the `.js`-for-`.ts` specifiers this package's own
 * index uses. A consumer that is a bundle imports it from the package index; a
 * consumer that is a toolchain config imports `@pocketcircle/domain/changelog`.
 */
const VERSION_HEADING = /^## \[v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\] - (\d{4}-\d{2}-\d{2})$/;

const CATEGORY_HEADINGS = new Set([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);

function isH2(line: string) {
  return line.startsWith("## ");
}

function isUnreleasedHeading(line: string) {
  return line.startsWith("## [Unreleased]");
}

function parseVersionHeading(line: string) {
  const match = VERSION_HEADING.exec(line);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  const date = match?.[4];
  if (!major || !minor || !patch || !date) {
    return null;
  }
  return { version: `v${major}.${minor}.${patch}`, date };
}

function isCategoryHeading(line: string) {
  return line.startsWith("### ");
}

function categoryHeading(line: string) {
  const heading = line.slice("### ".length).trim();
  if (!CATEGORY_HEADINGS.has(heading)) {
    return null;
  }
  return heading;
}

function isBullet(line: string) {
  return line.trimStart().startsWith("- ");
}

function bulletText(line: string) {
  return line.trimStart().slice(2).trim();
}

function joinWrappedLines(lines: string[]) {
  return lines.map((line) => line.trim()).join(" ");
}

function parseIntro(lines: string[]) {
  const paragraphs: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    paragraphs.push(joinWrappedLines(buffer));
    buffer = [];
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return paragraphs;
}

function parseCategories(lines: string[]) {
  const categories: { heading: string; items: string[] }[] = [];
  let heading: string | null = null;
  let items: string[] = [];
  let currentBullet: string[] | null = null;

  const flushBullet = () => {
    if (!currentBullet || currentBullet.length === 0) {
      return;
    }
    items.push(joinWrappedLines(currentBullet));
    currentBullet = null;
  };

  const flushCategory = () => {
    flushBullet();
    if (heading && items.length > 0) {
      categories.push({ heading, items });
    }
    heading = null;
    items = [];
  };

  for (const line of lines) {
    if (isCategoryHeading(line)) {
      flushCategory();
      heading = categoryHeading(line);
      continue;
    }
    if (!heading) {
      continue;
    }
    if (isBullet(line)) {
      flushBullet();
      currentBullet = [bulletText(line)];
      continue;
    }
    if (currentBullet && line.trim() !== "") {
      currentBullet.push(line);
    }
  }
  flushCategory();
  return categories;
}

function parseVersionBody(heading: { version: string; date: string }, body: string[]) {
  const firstCategoryIndex = body.findIndex(isCategoryHeading);
  const introLines = firstCategoryIndex === -1 ? body : body.slice(0, firstCategoryIndex);
  const categoryLines = firstCategoryIndex === -1 ? [] : body.slice(firstCategoryIndex);

  return {
    version: heading.version,
    date: heading.date,
    intro: parseIntro(introLines),
    categories: parseCategories(categoryLines),
  };
}

function collectVersionBlocks(lines: string[]) {
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (isUnreleasedHeading(line)) {
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next !== undefined && isH2(next)) {
          index -= 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    const heading = parseVersionHeading(line);
    if (!heading) {
      continue;
    }

    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next !== undefined && isH2(next)) {
        index -= 1;
        break;
      }
      if (next !== undefined) {
        body.push(next);
      }
      index += 1;
    }
    blocks.push({ heading, body });
  }

  return blocks;
}

export function parseChangelog(markdown: string) {
  return collectVersionBlocks(markdown.split(/\r?\n/)).map((block) =>
    parseVersionBody(block.heading, block.body),
  );
}
