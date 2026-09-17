#!/usr/bin/env node
// Bump the version, commit it with our release convention, and cut a matching
// annotated git tag (vX.Y.Z). Run `pnpm publish` afterwards.
//
//   pnpm release patch     -> 0.7.1 -> 0.7.2
//   pnpm release minor     -> 0.7.1 -> 0.8.0
//   pnpm release major     -> 0.7.1 -> 1.0.0
//   pnpm release 1.2.3      -> set an explicit version
//
// Flags:
//   --push   also push the branch + tag to origin
//   --dry    print what would happen without changing anything

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const push = args.includes("--push");
const dry = args.includes("--dry");
const bump = args.find((a) => !a.startsWith("--"));

const ALLOWED = ["major", "minor", "patch"];
const isExplicit = bump && /^\d+\.\d+\.\d+/.test(bump);

if (!bump || (!ALLOWED.includes(bump) && !isExplicit)) {
  console.error(
    `Usage: pnpm release <major|minor|patch|x.y.z> [--push] [--dry]\n` +
      `Got: ${bump ?? "(nothing)"}`,
  );
  process.exit(1);
}

const run = (cmd, cmdArgs, opts = {}) => {
  if (dry) {
    console.log(`[dry] ${cmd} ${cmdArgs.join(" ")}`);
    return "";
  }
  return execFileSync(cmd, cmdArgs, { stdio: "pipe", encoding: "utf8", ...opts });
};

// Preconditions: clean tree, on main, up to date-ish.
const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (status.trim()) {
  console.error("Working tree is not clean. Commit or stash first:\n" + status);
  process.exit(1);
}

const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf8",
}).trim();
if (branch !== "main") {
  console.error(`Refusing to release from "${branch}"; switch to main first.`);
  process.exit(1);
}

const before = JSON.parse(readFileSync("package.json", "utf8")).version;
console.log(`Current version: ${before} (branch ${branch})`);

// `npm version` bumps package.json, commits, and tags in one shot.
// -m keeps our "chore(release): bump version to X.Y.Z" convention; the tag
// defaults to vX.Y.Z.
run("npm", [
  "version",
  bump,
  "-m",
  "chore(release): bump version to %s",
]);

const after = dry
  ? before
  : JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${after}`;
console.log(`\nCut ${tag} (commit + tag created locally).`);

if (push) {
  run("git", ["push", "--follow-tags", "origin", branch]);
  console.log(`Pushed ${branch} and ${tag} to origin.`);
} else {
  console.log(
    `\nNext:\n` +
      `  git push --follow-tags origin main   # publish the tag\n` +
      `  pnpm publish                          # build + release to npm\n` +
      `(or re-run with --push to push automatically)`,
  );
}
