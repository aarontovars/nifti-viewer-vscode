import * as esbuild from "esbuild";
import { copyFileSync } from "fs";

const watch = process.argv.includes("--watch");

/** Extension host bundle (Node CJS) */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  target: "node16",
};

/** Webview bundle (browser IIFE) */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  sourcemap: true,
  target: "es2020",
};

async function main() {
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    copyFileSync("src/webview/styles.css", "dist/styles.css");
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    console.log("Watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
    copyFileSync("src/webview/styles.css", "dist/styles.css");
    console.log("Build complete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
