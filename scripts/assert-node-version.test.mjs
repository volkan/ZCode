import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("./assert-node-version.mjs", import.meta.url);
const { engines } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const minimum = engines.node.replace(/^>=/u, "");
const [major, minor, patch] = minimum.split(".").map(Number);
const previous = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.99`;

for (const [version, accepted] of [
  [minimum, true],
  [previous, false],
  [`${major - 1}.99.99`, false],
  [`${major}.${minor}.${patch + 1}`, true],
  [`${major + 1}.0.0`, true],
]) {
  test(`CI Node check ${accepted ? "accepts" : "rejects"} ${version} for ${engines.node}`, () => {
    const source = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(scriptUrl.href)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
    });
    assert.equal(result.status, accepted ? 0 : 1, result.stderr);
    assert.match(
      accepted ? result.stdout : result.stderr,
      new RegExp(version.replaceAll(".", "\\.")),
    );
    if (!accepted) assert.ok(result.stderr.includes(engines.node));
  });
}
