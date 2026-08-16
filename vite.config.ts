import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const DEV_SERVER_ORIGIN = "http://127.0.0.1:5173";

// The packaged renderer must ship a strict policy. Vite's dev server injects an
// inline refresh preamble and talks over a websocket, so the relaxed policy is
// applied only while serving, never to the built output.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join("; ");

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${DEV_SERVER_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${DEV_SERVER_ORIGIN} ws://127.0.0.1:5173`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "openstrawberry-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        const policy = context.server ? DEVELOPMENT_CSP : PRODUCTION_CSP;
        return html.replace("%CONTENT_SECURITY_POLICY%", policy);
      }
    }
  };
}

// The renderer is loaded from disk in packaged builds, so every asset URL must
// stay relative to index.html rather than resolving against the filesystem root.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "chrome138",
    sourcemap: false
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
