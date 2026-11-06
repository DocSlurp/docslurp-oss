import { expect, it } from "vitest";
import { readTableCells } from "./table-cells-guest.js";
it("preserves all cells of 5,000 data rows by 20 columns plus headers", () => {
 const header="<tr>"+Array.from({length:20},(_,c)=>`<th>Column ${c+1}</th>`).join("")+"</tr>";
 const rows=Array.from({length:5000},(_,r)=>"<tr>"+Array.from({length:20},(_,c)=>`<td>r${r+1}c${c+1}</td>`).join("")+"</tr>").join("");
 const cells=readTableCells(`<table><thead>${header}</thead><tbody>${rows}</tbody></table>`);
 expect(cells).toHaveLength(100020);
 expect(cells?.at(-1)).toMatchObject({label:"row 5001 column 20 rowspan 1 colspan 1",value:"r5000c20"});
});
