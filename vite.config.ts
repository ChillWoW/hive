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
        outDir: "build"
    },
    server: {
        port: 1421,
        strictPort: true, // fail loudly instead of shifting ports
        watch: { ignored: ["**/src-tauri/**"] } // Backend changes shouldn't trigger HMR
    }
});
