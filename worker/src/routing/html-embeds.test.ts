import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectHtmlEmbeds } from "./html-embeds.js";

describe("detectHtmlEmbeds", () => {
  it("is empty for plain HTML and ignores commented-out markup and data scripts", () => {
    const r = detectHtmlEmbeds(`<p>hi</p><!-- <iframe src="x"></iframe> --><script type="application/ld+json">{"a":1}</script>`);
    expect(r.items).toEqual([]);
    expect(r.needsAttention).toBe(false);
  });

  it("lists each embedded element with its source", () => {
    const r = detectHtmlEmbeds(`
      <iframe src="https://a.example/x"></iframe><iframe srcdoc="&lt;p&gt;hi&lt;/p&gt;"></iframe>
      <embed src='b.pdf'><object data="c.svg">fallback</object>
      <video src="v.mp4"></video><audio src=a.mp3></audio><canvas id="c"></canvas>
      <script src="app.js"></script><script>document.getElementById('r').innerHTML = 'x'</script>
      <svg><foreignObject><div>x</div></foreignObject></svg>`);
    expect(r.counts).toEqual({
      iframe: 1, "iframe-srcdoc": 1, embed: 1, object: 1, video: 1, audio: 1, canvas: 1, "script-external": 1, "script-rendered": 1, "svg-foreign-object": 1,
    });
    expect(r.items.find((i) => i.kind === "embed")!.src).toBe("b.pdf");
    expect(r.items.find((i) => i.kind === "audio")!.src).toBe("a.mp3");
    expect(r.needsAttention).toBe(true);
  });

  const dir = "/path/to/eval-data/eval-suite/inputs";
  it.skipIf(!existsSync(`${dir}/unusual-html-iframe.html`))("flags the 4 eval-suite HTML cases", () => {
    const kinds = (f: string) => Object.keys(detectHtmlEmbeds(readFileSync(`${dir}/${f}`, "utf8")).counts).sort();
    expect(kinds("unusual-html-iframe.html")).toEqual(["iframe"]);
    expect(kinds("unusual-html-iframe-srcdoc.html")).toEqual(["iframe-srcdoc"]);
    expect(kinds("unusual-html-embed-object.html")).toEqual(["embed", "object"]);
    expect(kinds("unusual-html-video.html")).toEqual(["video"]);
  });
});
