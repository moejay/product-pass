import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
async function pngSize(file: string): Promise<[number, number]> { const bytes = await readFile(file); assert.deepEqual([...bytes.subarray(1, 4)], [80, 78, 71]); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; }
test("browser manifests reference complete Product Pass PNG icons", async () => {
  const chrome = JSON.parse(await readFile(path.join(root, "src/manifest.chrome.json"), "utf8")); const firefox = JSON.parse(await readFile(path.join(root, "src/manifest.firefox.json"), "utf8"));
  for (const manifest of [chrome, firefox]) for (const size of [16, 32, 48, 128]) { const file = path.join(root, "src/assets", manifest.icons[String(size)]); await stat(file); assert.deepEqual(await pngSize(file), [size, size]); }
  for (const manifest of [chrome, firefox]) for (const size of [16, 32]) assert.equal(manifest.action.default_icon[String(size)], `icons/icon-${size}.png`);
  assert.deepEqual(await readFile(path.join(root, "src/assets/icons/icon-128.png")), await readFile(path.join(root, "store-assets/store-icon-128.png")));
});
