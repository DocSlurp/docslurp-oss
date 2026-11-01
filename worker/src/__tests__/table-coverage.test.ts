import { expect,it } from 'vitest';
import { coverage,htmlCells } from '../benchmarks/table-coverage.js';
it('scores cell values, ownership, spans and extra cells separately',()=>{
 const gold=[{table:1,row:1,column:1,rowspan:2,colspan:1,value:'A'},{table:1,row:1,column:2,rowspan:1,colspan:1,value:'B'},{table:1,row:2,column:2,rowspan:1,colspan:1,value:'C'}];
 const cells=htmlCells('<table><tr><th rowspan="2">A</th><th>B</th></tr><tr><td>C</td></tr></table>');
 expect(cells).toEqual(gold);expect(coverage(gold,cells)).toMatchObject({valueRecall:1,topologyRecall:1,extras:0});
 expect(coverage(gold,[...cells,{...cells[0]!}])).toMatchObject({extras:1,precision:0.75});
 expect(coverage(gold,cells.map(c=>({...c,rowspan:1})))).toMatchObject({valueRecall:1,topologyRecall:2/3});
 expect(coverage(gold,[])).toMatchObject({valueRecall:0,topologyRecall:0});
});
it('rejects nested cells rather than hiding extra cells in a perfect score',()=>{
 expect(()=>htmlCells('<table><tr><td>A<table><tr><td></td></tr></table></td></tr></table>')).toThrow('Nested tables');
});
