import { tableChunks } from "../pipeline/table-chunking.js";
import { describe, expect, it } from "vitest";
import { chunkTextWithMeta, chunkText } from "../pipeline/chunking.js";

function records(chunks: string[]) {
  return chunks.flatMap(chunk => chunk.replace(/^\[Table \d+ v2:[^\n]*\n/, "").split("\n\n")).map(record => {
    const split = record.indexOf("\n");
    return { context: record.slice(0, split).replace(/^\[r(\d+) c(\d+)(?: rowspan=(\d+))?(?: colspan=(\d+))?(?: part=(\d+))?\]$/, (_, r, c, rs, cs, part) => `[row ${r} column ${c} rowspan ${rs ?? 1} colspan ${cs ?? 1} part ${part ?? 1}]`), value: JSON.parse(record.slice(split + 1)) as string };
  });
}

describe("HTML table chunks", () => {
  it("budgets growing continuations with combined spans", () => {
    const source = '<table><tr><td rowspan="2" colspan="2048">' + "x".repeat(10_000) + '</td></tr><tr></tr></table>';
    for (const tableIndex of [1, 10, 1000]) {
      const chunks = [...tableChunks(source, 128, tableIndex)];
      expect(chunks.every(c => c.length <= 128 && c.startsWith(`[Table ${tableIndex} `))).toBe(true);
      expect(records(chunks).map(r => r.value).join("")).toBe("x".repeat(10_000));
    }
  });
  it("keeps a small table whole amid long prose and suppresses sliced table overlap", () => {
    const table = '<table><tr><td colspan="2">A &amp; B</td></tr></table>';
    const result = [...chunkTextWithMeta("# Parent\n" + "Before. ".repeat(40) + "\n" + table + "\n" + "After. ".repeat(40), 180, { overlapFraction: 0.2 })];
    expect(result.filter(c => c.text.includes("<table"))).toHaveLength(1);
    expect(result.find(c => c.text.includes("<table"))?.text).toBe(table);
    expect(result.find(c => c.text === table)?.headingPath).toEqual(["Parent"]);
    expect(result.every(c => c.text.length <= 180)).toBe(true);
  });
  it("retains rowspan/colspan ownership and all values exactly once", () => {
    const source = '<table><tr><td rowspan="2">shared</td><td colspan="2">group</td></tr><tr><td>east</td><td>west</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>';
    const result = records([...chunkText(source, 128)]);
    expect(result.map(r => r.value)).toEqual(["shared", "group", "east", "west", "1", "2", "3"]);
    expect(result[0]!.context).toContain("row 1 column 1 rowspan 2 colspan 1");
    expect(result[1]!.context).toContain("row 1 column 2 rowspan 1 colspan 2");
    expect(result[2]!.context).toContain("row 2 column 2");
    expect(result[3]!.context).toContain("row 2 column 3");
  });
  it("preserves huge cells, unicode, entities, whitespace and empty cells", () => {
    const value = "🙂<&\n  text ".repeat(400);
    const escaped = value.replace(/&/g,"&amp;").replace(/</g,"&lt;");
    const source = `<table><tr><td>${escaped}</td><td></td></tr></table>`;
    const chunks = [...chunkText(source, 180)];
    expect(chunks.every(c => c.length <= 180 && !c.includes("<"))).toBe(true);
    const rs = records(chunks);
    expect(rs.filter(r => r.context.includes("column 1")).map(r => r.value).join("")).toBe(value);
    expect(rs.filter(r => r.context.includes("column 2")).map(r => r.value)).toEqual([""]);
  });
  it("does not interpret table content as Markdown headings or fences", () => {
    const table = '<table>\n<tr><td>\n# Cell heading\n```\n' + "value ".repeat(40) + '\n</td></tr>\n</table>';
    const chunks = [...chunkTextWithMeta("# Parent\n" + table + "\n# After\nend", 180)];
    expect(chunks.filter(c => c.text.startsWith("[Table")).every(c => c.headingPath.join() === "Parent")).toBe(true);
    expect(chunks.at(-1)?.headingPath).toEqual(["After"]);
  });
  it("preserves nested, non-cell and active content as explicitly unparsed escaped source", () => {
    for (const source of [
      '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>',
      '<table><tr><td>cell</td></tr>fostered text</table>',
      '<table><tr><td><script>alert(1)</script></td></tr></table>',
      '<table><tr><td rowspan="999999999">span</td></tr></table>',
    ]) {
      const large = source.replace('</table>', '</table>') + ' '.repeat(200) + 'trailing content';
      const rs = records([...chunkText(large, 128)]);
      expect(rs.every(r => r.context.includes("unparsed source"))).toBe(true);
      expect(rs.map(r => r.value).join("")).toBe(large);
    }
  });
  it("retains non-cell captions in oversized tables", () => {
    const table = '<table><caption>Caption</caption><tr><td>' + "a".repeat(200) + '</td></tr></table>';
    const rs = records([...chunkText(table, 128)]);
    expect(rs[0]).toMatchObject({ value: "Caption" });
    expect(rs[0]!.context).toContain("caption");
  });
  it("does not parse table examples in fenced code", () => {
    const source = '```html\n<table><tr><td>example</td></tr></table>\n```';
    expect([...chunkText(source, 100)]).toEqual([source]);
  });
  it("bounds large fallback input and preserves its source", () => {
    const source = '<table><tr><td>' + 'x'.repeat(270_000) + '</td></tr></table>';
    const chunks = [...chunkText(source, 1800)];
    expect(chunks.every(c => c.length <= 1800)).toBe(true);
    expect(records(chunks).map(r => r.value).join("")).toBe(source);
  });
  it("keeps multiline tags and comment/raw-text closing strings protected", () => {
    for (const opening of ['<table title="</table>"\n class="wide">', '<table\n class="wide">', '<table class="wide"\n title="Example">', '<table><!-- </table> -->', '<table><script>"</table>"</script>']) {
      const source = opening + '\n<tr><td>' + 'data '.repeat(50) + '</td></tr>\n</table>';
      const rs = records([...chunkText(source, 128)]);
      expect(rs.map(r => r.value).join("")).toBe(source);
      expect(rs.every(r => r.context.includes("unparsed source"))).toBe(true);
    }
  });
  it("does not infer rowspans across separate row groups", () => {
    const source = '<table><thead><tr><th rowspan="2">group</th><th>value</th></tr></thead><tbody><tr><td>data</td><td>value</td></tr></tbody></table>';
    const rs = records([...chunkText(source, 128)]);
    expect(rs.every(r => r.context.includes("unparsed source"))).toBe(true);
    expect(rs.map(r => r.value).join("")).toBe(source);
  });
  it("preserves CDATA closing strings and reordered row groups without inferred geometry", () => {
    for (const source of [
      '<table><tr><td><svg><![CDATA[x> </table>]]></svg>\n' + 'A'.repeat(180) + '</td></tr>\n</table>',
      '<table><tfoot><tr><td>total amount</td><td>99 units</td></tr></tfoot><tbody><tr><td>detail record</td><td>99 units</td></tr></tbody></table>'
    ]) {
      const rs = records([...chunkText(source, 128)]);
      expect(rs.every(r => r.context.includes("unparsed source"))).toBe(true);
      expect(rs.map(r => r.value).join("")).toBe(source);
    }
  });
  it("rejects invalid budgets instead of looping or losing context", () => {
    for (const max of [0, -1, 1.5, Infinity, NaN]) expect(() => [...chunkText("text", max)]).toThrow(RangeError);
    expect(() => [...chunkText('<table><tr><td>x</td></tr></table>', 50)]).toThrow(RangeError);
  });
});

it('keeps fitting rows together and repeats explicitly labelled header context', () => {
 const source='<table><tr><th>Key</th><th>Value</th></tr>'+Array.from({length:18},(_,i)=>`<tr><td>entry-${i}</td><td>amount-${i}</td></tr>`).join('')+'</table>';
 const chunks=[...chunkText(source,600)];
 expect(chunks.length).toBeGreaterThan(1);
 for (const chunk of chunks) {
  expect(chunk.length).toBeLessThanOrEqual(600);
  expect(chunk).toContain('context row 1 column 1');
  for(let i=0;i<18;i++) if(chunk.includes(`"entry-${i}"`)) expect(chunk).toContain(`"amount-${i}"`);
 }
 const sourceRecords=records(chunks).filter(r=>!r.context.includes(' context '));
 expect(sourceRecords).toHaveLength(38);
 expect(sourceRecords.filter(r=>r.value==='entry-12')).toHaveLength(1);
});
it('keeps all supported budgets valid even when header context nearly fills its allowance',()=>{
 const source='<table><tr><th>A</th></tr>'+ '<tr><td>data</td></tr>'.repeat(12)+'</table>';
 for(let budget=128;budget<=256;budget++){
  const chunks=[...chunkText(source,budget)];expect(chunks.every(c=>c.length<=budget)).toBe(true);
  const values=records(chunks).filter(r=>!r.context.includes(' context ')).map(r=>r.value);
  expect(values).toEqual(['A',...Array(12).fill('data')]);
 }
});
