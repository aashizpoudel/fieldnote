import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// #region agent log
function debugLogPlugin(): Plugin {
  const logPath = path.resolve(__dirname, "../.cursor/debug-7f8a2c.log");
  return {
    name: "debug-log-ingest",
    configureServer(server) {
      server.middlewares.use("/__debug_log", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, Buffer.concat(chunks).toString("utf8").trim() + "\n");
            res.statusCode = 204;
            res.end();
          } catch (error) {
            res.statusCode = 500;
            res.end(String(error));
          }
        });
      });
    },
  };
}
// #endregion

export default defineConfig({
  plugins: [react(), debugLogPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
