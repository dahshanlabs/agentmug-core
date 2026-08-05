import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(tmpdir(), `llm-gemini-test-${process.pid}.mjs`);

await build({
  entryPoints: ["src/adapters/llm-gemini.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "warning",
  plugins: [
    {
      name: "google-genai-capture",
      setup(build) {
        build.onResolve({ filter: /^@google\/genai$/ }, () => ({
          path: "@google/genai",
          namespace: "gemini-test-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "gemini-test-stub" }, () => ({
          loader: "js",
          contents: `
            export class GoogleGenAI {
              constructor() {
                this.models = {
                  generateContentStream: async (request) => {
                    globalThis.__geminiTestRequests.push(request);
                    const response = globalThis.__geminiTestResponses.shift();
                    return {
                      async *[Symbol.asyncIterator]() {
                        if (response) yield response;
                      },
                    };
                  },
                };
              }
            }
          `,
        }));
      },
    },
  ],
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(outfile, { force: true }).catch(() => {});
}
