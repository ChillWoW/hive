import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        tailwindcss(),
        react(),
        babel({ presets: [reactCompilerPreset()] })
    ],
    clearScreen: false, // don't wipe Rust's compiler output
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url))
        }
    },
    build: {
        outDir: "build",
        // File icons stay files, loaded the first time one is drawn, rather
        // than ~1,200 data URLs in the main chunk.
        assetsInlineLimit: (file) =>
            file.includes("material-icon-theme") ? false : undefined
    },
    server: {
        port: 1421,
        strictPort: true, // fail loudly instead of shifting ports
        // Backend changes shouldn't trigger HMR, and Cargo's locked build
        // artifacts in `target/` crash the watcher on Windows.
        watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] }
    }
});
