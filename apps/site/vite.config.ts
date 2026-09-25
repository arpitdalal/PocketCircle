import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { apexOriginHtmlPlugin } from "./src/apex-origin-html.js";

export default defineConfig({
  plugins: [tailwindcss(), apexOriginHtmlPlugin()],
});
