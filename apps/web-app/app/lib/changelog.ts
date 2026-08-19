import changelogSource from "../../../../CHANGELOG.md?raw";

export { changelogSource };

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
