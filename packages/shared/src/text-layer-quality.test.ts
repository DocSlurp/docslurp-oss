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

  it("Ukrainian, Belarusian, Serbian and Macedonian prose, capitals and tables are not mojibake", () => {
    const uk = times("Рішення комітету щодо Рівненської області ухвалено в січні; Суми, Сімферополь і Полтава підтвердили свої плани, а Їжак і Єнот сховались.", 4);
    const be = times("Рэспубліка Беларусь прыняла рашэнне аб развіцці сельскай гаспадаркі, а Ўладзімір і Сяргей падрыхтавалі справаздачу.", 4);
    const sr = times("Одлука одбора о Љубомиру, Његошу и Ћирилици усвојена је у Србији; Ђорђе и Џон су потврдили своје планове за Јануар.", 4);
    const mk = times("Одлуката на одборот за Ѓорѓи и Ќирил е донесена во Скопје, а Љубица и Његош ги потврдија своите планови за Јануари.", 4);
    for (const text of [uk, be, sr, mk]) expect(assessTextLayer(text).verdict).toBe("ok");
    const capitals = "РІШЕННЯ КОМІТЕТУ\nСІЧЕНЬ РІВНЕ СУМИ СІМФЕРОПОЛЬ\nРЄСТР СІЛЬСЬКОГО ГОСПОДАРСТВА\nСРІБЛО РІЧКА СІЛЬ";
    expect(assessTextLayer(`${capitals}\n${uk}`).verdict).toBe("ok");
    const cities = ["Рівне", "Суми", "Сімферополь", "Чернігів", "Харків", "Київ", "Львів", "Одеса", "Полтава", "Ужгород"];
    const table = ["| Місто | Населення | Область |", "|---|---|---|", ...cities.map((city, i) => `| ${city} | ${100 + i * 17},${i}00 | Область ${i + 1} |`)].join("\n");
    const tableAssessment = assessTextLayer(table);
    expect(tableAssessment.verdict).not.toBe("garbled");
    expect(tableAssessment.reasons).not.toContain("mojibake");
  });

  it("German prose with an em dash after ß or capitals is not Latin-1 mojibake", () => {
    const assessment = assessTextLayer(times("Die Straße—eine Ödnis—und die Übung—so Ärzte—blieb leer, aber Öl und Äpfel kosten mehr als gestern in der Stadt.", 4));
    expect(assessment.verdict).toBe("ok");
  });

  it("base64 appendices, PEM certificates, JWTs and part-number lists are data, not a glyph shift", () => {
    let seed = 12345;
    const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff));
    const wrap = (text: string, width: number) => text.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
    const base64 = wrap(bytes(900).toString("base64"), 76);
    const pem = `-----BEGIN CERTIFICATE-----\n${wrap(bytes(900).toString("base64"), 64)}\n-----END CERTIFICATE-----`;
    const jwts = Array.from({ length: 6 }, () => `eyJ${bytes(30).toString("base64url")}.${bytes(80).toString("base64url")}.${bytes(32).toString("base64url")}`).join("\n");
    const parts = Array.from({ length: 40 }, (_, i) => `PN-${String(480000 + i * 37).padStart(7, "0")}-AB${String(1000 + i * 13)}-REV${"ABCDEF"[i % 6]}`).join("\n");
    const serials = Array.from({ length: 40 }, () => bytes(12).toString("hex").toUpperCase().replace(/[A-F]/g, (c) => "QWXYZV"[c.charCodeAt(0) % 6]!) + "KJ").join("\n");
    for (const [name, text] of Object.entries({ base64, pem, jwts, parts, serials })) {
      const assessment = assessTextLayer(text);
      expect(assessment.verdict, name).not.toBe("garbled");
      expect(assessment.reasons, name).not.toContain("glyph-shift");
    }
  });

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
    // Mojibake alone is `suspect`: only unmapped glyphs send a page to vision unchecked; the OCR cross-check decides.
    // (Read as Latin-1, Cyrillic also leaves C1 control characters: unmapped-glyph evidence, so it is garbled.)
    const latin1Russian = assessTextLayer(Buffer.from(PROSE.russian, "utf8").toString("latin1"));
    expect(latin1Russian.verdict).toBe("garbled");
    expect(latin1Russian.reasons).toContain("unmapped-glyphs");
    const cases = [
      new TextDecoder("windows-1251").decode(Buffer.from(PROSE.russian, "utf8")),
      new TextDecoder("windows-1251").decode(Buffer.from(times("Рішення комітету щодо Рівненської області ухвалено в січні, Сімферополь підтвердив.", 4), "utf8")),
      new TextDecoder("windows-1252").decode(Buffer.from(PROSE.greek, "utf8")),
    ];
    for (const text of cases) {
      const assessment = assessTextLayer(text);
      expect(assessment.verdict).toBe("suspect");
      expect(assessment.reasons).toContain("mojibake");
    }
  });

  it("a glyph-code shift is flagged for the OCR cross-check whether or not the spaces survive", () => {
    const shift = (text: string) => [...text].map((c) => (c > " " && c < "\x7f" ? String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 29) % 94)) : c)).join("");
    expect(assessTextLayer(shift(PROSE.english)).verdict).not.toBe("ok");
    expect(assessTextLayer(shift(PROSE.english.replace(/ /g, ""))).verdict).not.toBe("ok");
    const shiftedLetters = times("6FDOLQJDWWHQWLRQZLWKRXWORVLQJVLJQDOLVDKDUGSUREOHP 7KHDXWKRUVSURSRVHDQHZDUFKLWHFWXUHIRUORQJFRQWH[WV", 4);
    const assessment = assessTextLayer(shiftedLetters);
    expect(assessment.verdict).toBe("suspect");
    expect(assessment.reasons).toContain("glyph-shift");
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
