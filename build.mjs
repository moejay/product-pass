import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL(".", import.meta.url);
const out = new URL("dist/", root);
await rm(out, { recursive: true, force: true });

const targets = ["chrome", "firefox"];
for (const target of targets) {
  const dir = new URL(`${target}/`, out);
  await mkdir(new URL("sidebar/", dir), { recursive: true });
  await mkdir(new URL("icons/", dir), { recursive: true });
  await build({
    entryPoints: {
      background: new URL("src/background/index.ts", root).pathname,
      content: new URL("src/content/index.ts", root).pathname,
      "sidebar/index": new URL("src/sidebar/index.ts", root).pathname
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: target === "chrome" ? "chrome116" : "firefox140",
    outdir: dir.pathname,
    sourcemap: false,
    minify: false
  });
  await Promise.all([
    cp(new URL(`src/manifest.${target}.json`, root), new URL("manifest.json", dir)),
    cp(new URL("src/sidebar/index.html", root), new URL("sidebar/index.html", dir)),
    cp(new URL("src/sidebar/index.css", root), new URL("sidebar/index.css", dir)),
    cp(new URL("src/assets/icons", root), new URL("icons", dir), { recursive: true })
  ]);
}
console.log("Built dist/chrome and dist/firefox");
