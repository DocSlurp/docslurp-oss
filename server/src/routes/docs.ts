import { Hono } from "hono";

import { buildOpenApiDocument } from "../lib/openapi.js";
import { env } from "../config.js";

function docsHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DocSlurp API Docs</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      }
      body {
        margin: 0;
        background: #f6f2e7;
        color: #1f2116;
      }
      main {
        width: min(1120px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 2rem 0 4rem;
      }
      .hero, .card {
        background: rgba(255, 252, 245, 0.92);
        border: 1px solid #c8bca2;
        border-radius: 28px;
        box-shadow: 0 20px 40px rgba(31, 33, 22, 0.08);
      }
      .hero {
        padding: 2rem;
      }
      .grid {
        display: grid;
        gap: 1rem;
        margin-top: 1.5rem;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .card {
        padding: 1.25rem;
      }
      code, pre {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #f1ebda;
        padding: 1rem;
        border-radius: 18px;
        font-size: 12px;
      }
      a {
        color: #c45e2d;
      }
      .muted {
        color: #71765b;
      }
      .path {
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="muted path">OpenAPI 3.1</p>
        <h1>DocSlurp API docs</h1>
        <p class="muted">Debug-first ingestion, retrieval, artifact, and webhook endpoints.</p>
        <p><a href="${specUrl}">Download raw spec</a></p>
      </section>
      <section class="grid" id="paths"></section>
    </main>
    <script>
      const specUrl = ${JSON.stringify(specUrl)};
      const container = document.getElementById("paths");
      fetch(specUrl)
        .then((response) => response.json())
        .then((spec) => {
          const paths = Object.entries(spec.paths || {});
          for (const [path, operations] of paths) {
            const card = document.createElement("article");
            card.className = "card";
            const heading = document.createElement("div");
            heading.className = "path";
            heading.textContent = path;
            card.appendChild(heading);
            for (const [method, meta] of Object.entries(operations)) {
              const p = document.createElement("p");
              const strong = document.createElement("strong");
              strong.textContent = method.toUpperCase();
              const code = document.createElement("code");
              code.textContent = path;
              const span = document.createElement("span");
              span.className = "muted";
              span.textContent = meta.summary || "";
              p.append(strong, " ", code, document.createElement("br"), span);
              card.appendChild(p);
            }
            container.appendChild(card);
          }

          const raw = document.createElement("section");
          raw.className = "card";
          raw.style.marginTop = "1rem";
          const h2 = document.createElement("h2");
          h2.textContent = "Raw spec";
          const pre = document.createElement("pre");
          pre.textContent = JSON.stringify(spec, null, 2);
          raw.append(h2, pre);
          document.querySelector("main").appendChild(raw);
        })
        .catch((error) => {
          const fallback = document.createElement("article");
          fallback.className = "card";
          const message = document.createElement("p");
          message.textContent = "We couldn’t load the API documentation. Please refresh and try again.";
          fallback.appendChild(message);
          container.replaceChildren(fallback);
        });
    </script>
  </body>
</html>`;
}

export const docsRoutes = new Hono()
  .get("/openapi.json", (c) => {
    const requestUrl = new URL(c.req.url);
    const baseUrl = requestUrl.origin;
    return c.json(buildOpenApiDocument(baseUrl));
  })
  .get("/docs", (c) => {
    const requestUrl = new URL(c.req.url);
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(docsHtml(new URL("/openapi.json", requestUrl).toString()));
  });
