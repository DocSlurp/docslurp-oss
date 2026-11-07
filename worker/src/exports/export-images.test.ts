import { describe, expect, it } from "vitest";
import { exportImagePath, rewriteImageMarkdown, rewriteImageMarkdownStream } from "./export-images.js";

describe("export image paths", () => {
  it("orders by page then occurrence, puts masks beside their image and never collides", () => {
    expect(exportImagePath({ pageNumber: 1, occurrence: 0, role: "image" }, ".webp")).toBe("images/page-0001/image-001.webp");
    expect(exportImagePath({ pageNumber: 12, occurrence: 41, role: "image" }, ".png")).toBe("images/page-0012/image-042.png");
    expect(exportImagePath({ pageNumber: 1, occurrence: 1, role: "smask", maskOf: { occurrence: 0 } }, ".webp")).toBe("images/page-0001/image-001.smask.webp");
    expect(exportImagePath({ pageNumber: 1, occurrence: 2, role: "mask", maskOf: { occurrence: 0 } }, ".webp")).toBe("images/page-0001/image-001.mask.webp");
    // A mask without a known image keeps its own occurrence, which no image on the page can share.
    expect(exportImagePath({ pageNumber: 1, occurrence: 3, role: "stencil" }, ".webp")).toBe("images/page-0001/image-004.stencil.webp");
  });
});

describe("Markdown image references", () => {
  const links = new Map([["p1o0|doc:a.webp", "images/page-0001/image-001.webp"]]);
  const text = "Intro\n![A \\[1\\]](docslurp-artifact:doc:a.webp#p1o0)\fPage two\n![Gone](docslurp-artifact:doc:b.webp#p2o0)\n![](docslurp-artifact:doc:c.webp#p2o1)\n";

  it("links exported files, keeps alt text for the rest and leaves everything else byte for byte", () => {
    expect(rewriteImageMarkdown(text, links, "")).toBe("Intro\n![A \\[1\\]](images/page-0001/image-001.webp)\fPage two\nGone\n\n");
    expect(rewriteImageMarkdown(text, links, "../")).toContain("](../images/page-0001/image-001.webp)");
    // A reference whose artifact id disagrees with the map is not linked.
    expect(rewriteImageMarkdown("![x](docslurp-artifact:doc:z.webp#p1o0)", links, "")).toBe("x");
    expect(rewriteImageMarkdown("plain text", links, "")).toBe("plain text");
  });

  it("streams the same result however the bytes are chunked", async () => {
    const bytes = new TextEncoder().encode(text);
    for (const size of [1, 3, 7, 64]) {
      const chunks = async function* () { for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); };
      let out = "";
      const decoder = new TextDecoder();
      for await (const chunk of rewriteImageMarkdownStream(chunks(), links, "")) out += decoder.decode(chunk, { stream: true });
      expect(out + decoder.decode()).toBe(rewriteImageMarkdown(text, links, ""));
    }
  });
});
