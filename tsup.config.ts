import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  sourcemap: true,
  dts: {
    tsconfig: "tsconfig.build.json",
  },
  splitting: true,
  clean: true,
  format: ["cjs", "esm"],
  external: [/cloudflare:/],
});
