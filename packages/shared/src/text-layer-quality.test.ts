import { describe, expect, it } from "vitest";

import { assessTextLayer, tokenAgreement, textLayerMatchesOcr } from "./text-layer-quality.js";

const times = (text: string, count: number) => Array.from({ length: count }, () => text).join(" ");

const PROSE = {
  english: times("The committee reviewed the quarterly report and agreed that the new schedule should begin after the winter break, provided that every department confirms its staffing plans.", 4),
  german: times("Der Ausschuss prüfte den Quartalsbericht und beschloss, dass der neue Zeitplan nach den Winterferien beginnen soll, sofern alle Abteilungen ihre Personalplanung bestätigen.", 4),
  french: times("Le comité a examiné le rapport trimestriel et a décidé que le nouveau calendrier commencera après les vacances d’hiver, à condition que chaque service confirme ses effectifs.", 4),
  russian: times("Комитет рассмотрел квартальный отчёт и решил, что новый график должен начаться после зимних каникул, если каждый отдел подтвердит свои планы по персоналу.", 4),
  greek: times("Η επιτροπή εξέτασε την τριμηνιαία έκθεση και αποφάσισε ότι το νέο πρόγραμμα πρέπει να ξεκινήσει μετά τις χειμερινές διακοπές, εφόσον κάθε τμήμα επιβεβαιώσει το προσωπικό του.", 4),
  arabic: times("استعرضت اللجنة التقرير الفصلي واتفقت على أن الجدول الجديد يجب أن يبدأ بعد العطلة الشتوية بشرط أن تؤكد كل الإدارات خطط التوظيف الخاصة بها.", 4),
  chinese: times("委员会审议了季度报告，并同意在冬季休假之后开始执行新的时间表，前提是每个部门都确认其人员安排。", 6),
  japanese: times("委員会は四半期報告書を検討し、すべての部門が人員計画を確認することを条件に、冬休みの後に新しい日程を開始することで合意した。", 6),
  korean: times("위원회는 분기 보고서를 검토하고 모든 부서가 인력 계획을 확인하는 조건으로 겨울 방학 이후에 새 일정을 시작하기로 합의했다.", 6),
};

describe("assessTextLayer: readable text is ok", () => {
  for (const [name, text] of Object.entries(PROSE)) {
    it(`${name} prose`, () => expect(assessTextLayer(text).verdict).toBe("ok"));
  }

  it("a page of git hashes and a DNA sequence is data, not a broken layer", () => {
    const hashes = Array.from({ length: 30 }, (_, i) => `${(0xabcdef12 + i * 7919).toString(16).padStart(8, "0")}${"0123456789abcdef".repeat(2)}`).join("\n");
    expect(assessTextLayer(hashes).verdict).not.toBe("garbled");
    const dna = Array.from({ length: 20 }, (_, i) => "ACGTTGCAAGCTTAGCCATGCAAGTCCGATAGCTAGGCTAACGT".slice(i % 5) + "ACGGTCA".repeat(3)).join("\n");
    expect(assessTextLayer(dna).verdict).not.toBe("garbled");
    // a log with a few hashes inside prose
    expect(assessTextLayer(`${PROSE.english} commit 9fceb02d0ae598e95dc970b74767f19372d61af8 merged`).verdict).toBe("ok");
  });

  it("source code, a Markdown table and short numeric pages are not flagged", () => {
    const code = times("const total = items.reduce((sum, item) => sum + item.price * item.qty, 0); // sum the cart\nif (total > limit) { throw new Error(`over limit: ${total}`); }", 6);
    expect(assessTextLayer(code).verdict).toBe("ok");
    const table = "| Item | Qty | Price |\n|---|---|---|\n| Bolts | 12 | 3.50 |\n| Nuts | 40 | 1.25 |\n| Washers | 100 | 0.10 |";
    expect(assessTextLayer(table).verdict).toBe("ok");
    expect(assessTextLayer("12").verdict).toBe("ok");
    expect(assessTextLayer("Глава 3. Введение").verdict).toBe("ok");
  });

  it("math with Greek letters and operators is not flagged", () => {
    const math = times("Let ε > 0 and δ = ε/2. Then |f(x) − f(y)| ≤ ∑ᵢ αᵢ|xᵢ − yᵢ| < ε for all x, y with ‖x − y‖ < δ, where μ(A) = ∫_A dμ and σ² = E[(X − μ)²].", 5);
    expect(assessTextLayer(math).verdict).toBe("ok");
  });

  it("an empty layer is empty, not garbled", () => {
    expect(assessTextLayer("  \n ").verdict).toBe("empty");
  });
});

describe("assessTextLayer: broken layers", () => {
  it("replacement characters, private-use glyphs and (cid:N) runs are garbled", () => {
    expect(assessTextLayer(PROSE.english.replace(/[aeiou]/g, "�")).verdict).toBe("garbled");
    expect(assessTextLayer(PROSE.english.replace(/[a-z]/g, (c) => String.fromCodePoint(0xe000 + c.charCodeAt(0)))).verdict).toBe("garbled");
    expect(assessTextLayer(times("(cid:72)(cid:101)(cid:108)(cid:108)(cid:111) (cid:87)(cid:111)(cid:114)(cid:108)(cid:100)", 8)).verdict).toBe("garbled");
  });

  it("UTF-8 read as Latin-1 or Windows-1251 is garbled, in Latin and Cyrillic scripts", () => {
    const asLatin1 = Buffer.from(PROSE.german, "utf8").toString("latin1");
    expect(["garbled", "suspect"]).toContain(assessTextLayer(asLatin1).verdict);
    expect(assessTextLayer(Buffer.from(PROSE.russian, "utf8").toString("latin1")).verdict).toBe("garbled");
    expect(assessTextLayer(new TextDecoder("windows-1251").decode(Buffer.from(PROSE.russian, "utf8"))).verdict).toBe("garbled");
    expect(assessTextLayer(new TextDecoder("windows-1252").decode(Buffer.from(PROSE.greek, "utf8"))).verdict).toBe("garbled");
  });

  it("a glyph-code shift is garbled whether or not the spaces survive", () => {
    const shift = (text: string) => [...text].map((c) => (c > " " && c < "\x7f" ? String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 29) % 94)) : c)).join("");
    expect(assessTextLayer(shift(PROSE.english)).verdict).toBe("garbled");
    expect(assessTextLayer(shift(PROSE.english.replace(/ /g, ""))).verdict).toBe("garbled");
    const shiftedLetters = times("6FDOLQJDWWHQWLRQZLWKRXWORVLQJVLJQDOLVDKDUGSUREOHP 7KHDXWKRUVSURSRVHDQHZDUFKLWHFWXUHIRUORQJFRQWH[WV", 4);
    expect(assessTextLayer(shiftedLetters).verdict).toBe("garbled");
  });

  it("a consistent letter substitution is flagged for an OCR cross-check in each alphabetic script", () => {
    const caesar = (text: string, alphabet: string, k: number) =>
      [...text].map((c) => { const i = alphabet.indexOf(c.toLowerCase()); return i < 0 ? c : alphabet[(i + k) % alphabet.length]!; }).join("");
    const latin = "abcdefghijklmnopqrstuvwxyz";
    const cyrillic = "абвгдежзийклмнопрстуфхцчшщъыьэюя";
    const greek = "αβγδεζηθικλμνξοπρστυφχψω";
    expect(assessTextLayer(caesar(PROSE.english, latin, 3)).verdict).not.toBe("ok");
    expect(assessTextLayer(caesar(PROSE.english, latin, 13)).verdict).not.toBe("ok");
    expect(assessTextLayer(caesar(PROSE.german, latin, 5)).verdict).not.toBe("ok");
    expect(assessTextLayer(caesar(PROSE.russian, cyrillic, 7)).verdict).not.toBe("ok");
    expect(assessTextLayer(caesar(PROSE.greek, greek, 4)).verdict).not.toBe("ok");
  });

  it("a Latin unit inside CJK text is not judged as a Latin page", () => {
    expect(assessTextLayer(`${PROSE.korean} 95.84pm 500nm 1000mm H2O`).verdict).toBe("ok");
  });
});

describe("tokenAgreement: text layer against an OCR of the page", () => {
  it("agrees on the same words in the same order", () => {
    const agreement = tokenAgreement(PROSE.english, PROSE.english.replace("committee", "committce"))!;
    expect(textLayerMatchesOcr(agreement)).toBe(true);
  });

  it("rejects a layer whose words are the page's words in another order or another language", () => {
    const words = PROSE.english.split(" ");
    const shuffled = [...words.slice(words.length / 2), ...words.slice(0, words.length / 2)].reverse().join(" ");
    expect(textLayerMatchesOcr(tokenAgreement(shuffled, PROSE.english)!)).toBe(false);
    expect(textLayerMatchesOcr(tokenAgreement(PROSE.german, PROSE.english)!)).toBe(false);
  });

  it("rejects a layer that holds only part of what is visible, and an OCR that holds only part of the layer", () => {
    const half = PROSE.english.split(" ").slice(0, 12).join(" ");
    const padded = `${half} ${PROSE.german}`;
    expect(textLayerMatchesOcr(tokenAgreement(padded, half + " " + PROSE.english.split(" ").slice(12, 14).join(" "))!)).toBe(false);
  });

  it("compares CJK by character pairs and returns null with too little text", () => {
    expect(textLayerMatchesOcr(tokenAgreement(PROSE.chinese, PROSE.chinese)!)).toBe(true);
    expect(tokenAgreement("two words", "two words")).toBeNull();
  });
});
