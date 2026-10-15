import { describe, expect, it } from "vitest";

import {
  sanitizeArtifactHtml,
  trimPreview,
  wrapSanitizedHtmlDocument
} from "../services/artifact-security.js";

describe("sanitizeArtifactHtml", () => {
  it("removes executable tags and inline event handlers", () => {
    const html = `
      <div onclick="alert('xss')">safe</div>
      <script>alert('xss')</script>
      <iframe src="https://evil.example"></iframe>
      <a href="javascript:alert('xss')">bad</a>
      <img src="https://evil.example/pixel.png" onerror="alert('xss')" />
    `;

    const sanitized = sanitizeArtifactHtml(html);

    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("<iframe");
    expect(sanitized).not.toContain("onclick=");
    expect(sanitized).not.toContain("onerror=");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).toContain('href="#"');
    expect(sanitized).toContain('src="#"');
  });
});

describe("wrapSanitizedHtmlDocument", () => {
  it("wraps sanitized content in a locked down html document", () => {
    const wrapped = wrapSanitizedHtmlDocument("<h1>Hello</h1><script>alert(1)</script>");

    expect(wrapped).toContain("<!doctype html>");
    expect(wrapped).toContain("Content-Security-Policy");
    expect(wrapped).toContain("<h1>Hello</h1>");
    expect(wrapped).not.toContain("<script>");
  });
});

describe("trimPreview", () => {
  it("marks previews as truncated when they exceed the max length", () => {
    const preview = trimPreview("abcdef", 4);

    expect(preview.truncated).toBe(true);
    expect(preview.content).toContain("[preview truncated]");
  });

  it("preserves previews within the limit", () => {
    expect(trimPreview("abc", 10)).toEqual({
      content: "abc",
      truncated: false
    });
  });
});
