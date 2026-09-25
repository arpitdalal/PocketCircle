import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { apexOriginHtmlPlugin } from "./src/apex-origin-html.js";
import { securityHeadersPlugin } from "./src/security-headers.js";

export default defineConfig({
  plugins: [tailwindcss(), apexOriginHtmlPlugin(), securityHeadersPlugin()],
});
