import { describe, expect, it } from "vitest";

import { splitTextIntoPagesStrict } from "@docslurp/shared";

import { pageAlignedTexts } from "../lib/page-image-evidence.js";
import { splitFormFeedPages } from "../pipeline/page-facts.js";

/**
 * Three readers of "where are the pages" must agree on text that has reliable page breaks and all refuse text that
 * does not (equal-length slices and `---` rules are not page breaks; `splitTextIntoPages` still falls back to them
 * and is for display only).
 */
const strict = (text: string, pages: number) => splitTextIntoPagesStrict(text, pages);
const aligned = (text: string, pages: number) => pageAlignedTexts(text, pages);
const pdftotext = (text: string, pages: number) => splitFormFeedPages(text.endsWith("\f") ? text : `${text}\f`, pages);

describe("page splitters agree on reliable breaks", () => {
  it.each([
    ["three pages", "one\ftwo\fthree", 3, ["one", "two", "three"]],
    ["an empty page in the middle", "one\f\fthree", 3, ["one", "", "three"]],
    ["an empty last page", "one\ftwo\f", 3, ["one", "two", ""]],
    ["CRLF line ends", "one\r\nline\ftwo", 2, ["one\nline", "two"]],
  ] as Array<[string, string, number, string[]]>)("%s", (_name, text, pages, expected) => {
    expect(strict(text, pages)).toEqual(expected);
    expect(aligned(text, pages)).toEqual(expected);
  });

  it("pdftotext output (a form feed ends every page) splits the same way", () => {
    expect(pdftotext("one\ftwo\fthree", 3)).toEqual(["one", "two", "three"]);
  });
});

describe("page splitters refuse breaks that do not describe the page count", () => {
  it.each([
    ["no form feed in a multi-page document", "Alpha beta gamma. ".repeat(40), 3],
    ["two pages of breaks, three expected", "one\ftwo", 3],
    ["four pages of breaks, three expected", "a\fb\fc\fd", 3],
    ["markdown rules", "first\n\n---\n\nsecond\n\n---\n\nthird", 3],
  ] as Array<[string, string, number]>)("%s", (_name, text, pages) => {
    expect(strict(text, pages)).toBeNull();
    expect(aligned(text, pages)).toBeNull();
  });

  it("a one-page document is that page, whatever it contains", () => {
    expect(strict("only page\fstill it", 1)).toEqual(["only page\nstill it"]);
    expect(aligned("only page", 1)).toEqual(["only page"]);
  });
});
