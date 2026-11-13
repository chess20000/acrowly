import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  accountId: "77f25cd45c154198bacb8415bdf94e03",
  worker: {
    name: "acrowly-site",
    entrypoint,
    compatibilityDate: "2026-11-13",
    compatibilityFlags: ["nodejs_compat"],
    domains: ["acrowly.com"],
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
        persist: true,
      },
      traces: {
        enabled: true,
        headSamplingRate: 1,
        persist: true,
      },
    },
  },
});
