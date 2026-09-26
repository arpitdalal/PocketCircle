import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { securityHeadersPlugin } from "./src/security-headers.js";
import { shareImagePlugin } from "./src/share-image.js";
import { siteHtmlPlugin } from "./src/site-html.js";

export default defineConfig({
  plugins: [tailwindcss(), siteHtmlPlugin(), securityHeadersPlugin(), shareImagePlugin()],
});
