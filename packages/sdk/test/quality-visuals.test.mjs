import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetch) => createDocSlurpClient({ apiUrl: "https://example.test/", apiKey: "key", fetch });

test("upload and uploadUrls send quality and visuals in the current names", async () => {
  const pipelines = [];
  const currentNames = client(async (url, init) => {
    if (String(url).endsWith("/url")) pipelines.push(JSON.parse(init.body).pipeline);
    else if (init.body instanceof FormData) pipelines.push(JSON.parse(init.body.get("pipeline")));
    return json({ run: { id: "run", status: "queued" }, documents: [], project: { id: "w", name: "W" } });
  });
  await currentNames.upload({ files: [new File(["text"], "note.txt")], quality: "fastest", visuals: "none" }, { directUpload: false });
  await currentNames.uploadUrls({ urls: ["https://example.test/a.pdf"], quality: "smart", visuals: "charts-ai" });
  assert.deepEqual(pipelines, [{ quality: "fastest", visuals: "none" }, { quality: "smart", visuals: "charts-ai" }]);
});
