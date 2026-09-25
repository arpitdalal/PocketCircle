import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "brand",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
