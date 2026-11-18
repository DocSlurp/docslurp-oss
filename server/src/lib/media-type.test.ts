import { describe, expect, it } from "vitest";
import { bodyMediaKind, framingDeclaresBody, mediaTypeOf } from "./media-type.js";
import { parseBody } from "hono/utils/body";

describe("one media-type classification", () => {
  it.each<[string | null, ReturnType<typeof bodyMediaKind>]>([
    [null, "none"],
    ["", "none"],
    ["application/json", "json"],
    ["Application/JSON; charset=utf-8", "json"],
    ["application/problem+json", "json"],
    ["text/json", "other"],
    ["application/json; garbage", "other"],
    ["text/plain; x=json", "other"],
    ["application/json-seq", "other"],
    ["text/plain; boundary=multipart/form-data", "other"],
    ["Multipart/Form-Data; boundary=x", "multipart"],
    ["application/x-www-form-urlencoded;charset=UTF-8", "form"],
    ["application/octet-stream", "other"],
  ])("%s → %s", (header, kind) => {
    expect(bodyMediaKind(header)).toBe(kind);
  });

  it("agrees with Hono's multipart reader on which bodies are forms", async () => {
    for (const header of ["Multipart/Form-Data; boundary=x", "multipart/form-data;boundary=x", "text/plain; x=multipart/form-data", "application/x-www-form-urlencoded; charset=utf-8", " APPLICATION/X-WWW-FORM-URLENCODED "]) {
      const form = bodyMediaKind(header);
      const body = form === "multipart" ? "--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--x--\r\n" : "a=1";
      const parsed = await parseBody(new Request("http://localhost/", { method: "POST", headers: { "content-type": header }, body }));
      expect({ header, form: form === "multipart" || form === "form" }).toEqual({ header, form: Object.keys(parsed).length > 0 });
      expect(mediaTypeOf(header)).toBe(header.split(";")[0]!.trim().toLowerCase());
    }
  });

  it("reads body framing from Content-Length and Transfer-Encoding", () => {
    expect(framingDeclaresBody(new Headers())).toBe(false);
    expect(framingDeclaresBody(new Headers({ "content-length": "0" }))).toBe(false);
    expect(framingDeclaresBody(new Headers({ "content-length": "5" }))).toBe(true);
    expect(framingDeclaresBody(new Headers({ "transfer-encoding": "chunked" }))).toBe(true);
  });
});
