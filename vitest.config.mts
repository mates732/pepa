import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition. Tests run in
      // plain Node, so point it at the package's empty entry.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // .tsx is included so component regressions can be covered with
    // renderToStaticMarkup, which needs no DOM environment and no extra deps.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});