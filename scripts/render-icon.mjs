/**
 * Rasterises resources/icon.svg into the PNG set electron-builder needs.
 *
 * Electron is already a dependency and ships a full renderer, so the icon is
 * rendered with the same engine that draws the app rather than adding an image
 * toolchain. Run with:  pnpm icon
 *
 * Rasterising happens on a canvas inside the page rather than through
 * capturePage. capturePage routes via the compositor, which fails with
 * UnknownVizError on a transparent window and would also bake in whatever the
 * window background happened to be. Canvas gives exact alpha, so the tile keeps
 * the transparent corners an app icon needs.
 */
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = 1024;
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];

function fail(reason) {
  console.error(`icon render failed: ${reason}`);
  app.exit(1);
}

process.on("uncaughtException", (error) => fail(String(error?.stack ?? error)));
setTimeout(() => fail("timed out after 45s"), 45_000).unref?.();

app.whenReady().then(async () => {
  const svg = readFileSync(join(root, "resources", "icon.svg"), "utf8");
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`;

  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true }
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const sizes = JSON.stringify([MASTER, ...LINUX_SIZES]);
  const encoded = await win.webContents.executeJavaScript(`
    (async () => {
      const svgEl = document.querySelector("svg");
      const source = new XMLSerializer().serializeToString(svgEl);
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("svg failed to decode"));
        image.src = url;
      });

      const out = {};
      for (const size of ${sizes}) {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(image, 0, 0, size, size);
        out[size] = canvas.toDataURL("image/png").split(",")[1];
      }
      return out;
    })()
  `);

  const toBuffer = (base64) => Buffer.from(base64, "base64");

  mkdirSync(join(root, "resources", "linux-icons"), { recursive: true });
  writeFileSync(join(root, "resources", "icon.png"), toBuffer(encoded[MASTER]));

  for (const size of LINUX_SIZES) {
    writeFileSync(
      join(root, "resources", "linux-icons", `${size}x${size}.png`),
      toBuffer(encoded[size])
    );
  }

  console.log(
    `rendered resources/icon.png at ${MASTER}x${MASTER} plus ${LINUX_SIZES.length} Linux sizes`
  );

  win.destroy();
  app.exit(0);
});
