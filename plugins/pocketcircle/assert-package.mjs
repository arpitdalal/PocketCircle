#!/usr/bin/env node
/**
 * Guards #365 packaging invariants: stable id, relative paths, real connection
 * mapping, marketplace entry. No network.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = join(root, "plugins/pocketcircle");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(cond, message) {
  if (!cond) {
    console.error(`assert-package: ${message}`);
    process.exitCode = 1;
  }
}

function assertRelativeDotPath(value, label) {
  assert(typeof value === "string" && value.startsWith("./"), `${label} must be ./relative`);
  const target = join(pluginRoot, value);
  assert(existsSync(target), `${label} missing on disk: ${value}`);
}

const manifestPath = join(pluginRoot, ".codex-plugin/plugin.json");
const appPath = join(pluginRoot, ".app.json");
const mcpPath = join(pluginRoot, ".mcp.json");
const marketplacePath = join(root, ".agents/plugins/marketplace.json");
const skillPath = join(pluginRoot, "skills/browse-authorized-records/SKILL.md");

assert(existsSync(manifestPath), "missing .codex-plugin/plugin.json");
assert(existsSync(appPath), "missing .app.json");
assert(existsSync(mcpPath), "missing .mcp.json");
assert(existsSync(marketplacePath), "missing .agents/plugins/marketplace.json");
assert(existsSync(skillPath), "missing browse-authorized-records skill");

const manifest = readJson(manifestPath);
assert(manifest.name === "pocketcircle", "manifest.name must be pocketcircle");
assert(manifest.interface?.displayName === "PocketCircle", "displayName must be PocketCircle");
assertRelativeDotPath(manifest.skills, "skills");
assertRelativeDotPath(manifest.mcpServers, "mcpServers");
assertRelativeDotPath(manifest.apps, "apps");
assertRelativeDotPath(manifest.interface.logo, "logo");
assertRelativeDotPath(manifest.interface.composerIcon, "composerIcon");

for (const urlKey of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL", "supportURL"]) {
  const url = manifest.interface[urlKey];
  assert(
    typeof url === "string" && url.startsWith("https://pocketcircle.app"),
    `${urlKey} must be https://pocketcircle.app…`,
  );
}

assert(
  /read-only/i.test(manifest.interface.longDescription) === false ||
    /not read-only|write tools/i.test(manifest.interface.longDescription),
  "longDescription must not claim a read-only product",
);

const apps = readJson(appPath);
const appId = apps.apps?.pocketcircle?.id;
assert(
  typeof appId === "string" && /^asdk_app_[a-f0-9]+$/i.test(appId),
  "apps.pocketcircle.id must be a real asdk_app_… id",
);
assert(
  appId === "asdk_app_6a9dcb9c8df0819196049b1b4a6aebc5",
  "apps.pocketcircle.id must match the registered ChatGPT App Id (not invented)",
);

const mcp = readJson(mcpPath);
assert(
  mcp.mcpServers?.pocketcircle?.url === "https://mcp.pocketcircle.app/mcp",
  "mcp URL must be production hosted endpoint",
);
assert(mcp.mcpServers?.pocketcircle?.type === "http", "mcp type must be http");

const marketplace = readJson(marketplacePath);
const entry = marketplace.plugins?.find((p) => p.name === "pocketcircle");
assert(entry, "marketplace must list pocketcircle");
assert(
  entry.source?.path === "./plugins/pocketcircle",
  "marketplace path must be ./plugins/pocketcircle",
);
assert(entry.policy?.installation === "AVAILABLE", "marketplace installation policy");
assert(entry.policy?.authentication === "ON_INSTALL", "marketplace authentication policy");

const skill = readFileSync(skillPath, "utf8");
assert(
  /not claim.*read-only|not read-only|write tools/i.test(skill),
  "skill must stay honest about writes",
);
assert(skill.includes("list_authorized_circles"), "skill must mention list_authorized_circles");
assert(skill.includes("search_transactions"), "skill must mention search_transactions");

if (process.exitCode) {
  console.error("assert-package: failed");
  process.exit(process.exitCode);
}

console.log("assert-package: ok (pocketcircle plugin + marketplace)");
