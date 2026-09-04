import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifests = await Promise.all(["chrome", "firefox"].map(async target => JSON.parse(await readFile(new URL(`src/manifest.${target}.json`, root), "utf8"))));
if (manifests.some(manifest => manifest.version !== pkg.version)) throw new Error("package.json and manifest versions must match.");

const release = new URL("release/", root); await rm(release, { recursive: true, force: true }); await mkdir(release);
await exec("npm", ["run", "build"], { cwd: root });
for (const target of ["chrome", "firefox"]) {
  await exec("zip", ["-qr", new URL(`product-pass-${pkg.version}-${target}.zip`, release).pathname, "."], { cwd: new URL(`dist/${target}/`, root) });
}
await exec("zip", ["-qr", new URL(`product-pass-${pkg.version}-source.zip`, release).pathname, ".", "-x", ".git/*", "node_modules/*", "dist/*", "release/*", "*.log"], { cwd: root });
const names = [`product-pass-${pkg.version}-chrome.zip`, `product-pass-${pkg.version}-firefox.zip`, `product-pass-${pkg.version}-source.zip`];
const sums = [];
for (const name of names) sums.push(`${createHash("sha256").update(await readFile(new URL(name, release))).digest("hex")}  ${name}`);
await writeFile(new URL("SHA256SUMS", release), `${sums.join("\n")}\n`);
console.log(`Packaged ${names.join(", ")}`);
