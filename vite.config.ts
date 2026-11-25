import { resolve } from "node:path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  environments: {
    // 複数ページの入口はブラウザ向けのビルドだけに指定する（Worker 側に渡すと HTML を読もうとして失敗する）
    client: {
      build: {
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, "index.html"),
            speaker: resolve(import.meta.dirname, "speaker.html"),
            view: resolve(import.meta.dirname, "view.html"),
            report: resolve(import.meta.dirname, "report.html"),
          },
        },
      },
    },
  },
});
