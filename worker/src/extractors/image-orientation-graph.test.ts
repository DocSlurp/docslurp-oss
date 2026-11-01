import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dopplerImageGraph } from './doppler-image-graph.js';
import { encodeImageBundle } from '../sandbox/providers/modal/doppler-images.js';
import { normalizeImageOrientation, reserveOrientationAttempt } from '../lib/image-orientation.js';
vi.mock('../lib/image-orientation.js',async importOriginal=>({...await importOriginal<typeof import('../lib/image-orientation.js')>(),imageOrientationEnabled:()=>true,normalizeImageOrientation:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
const bytes=Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqCrUsv+BiOh/AAA=','base64');
const sha256=createHash('sha256').update(bytes).digest('hex');
it.each(['corrected','exif','mask','budget','limit'])('preserves originals and handles %s',async mode=>{
 const dir=await mkdtemp(path.join(tmpdir(),'orientation-graph-'));
 try {
  const input=path.join(dir,'bundle'),output=path.join(dir,'prepared.png');await writeFile(output,'validated guest derivative');
  const release=vi.fn();vi.mocked(normalizeImageOrientation).mockResolvedValue({path:output,release,metadata:{status:mode==='exif'?'uncertain':'corrected',exifApplied:mode==='exif'} as any});
  await writeFile(input,encodeImageBundle({pageCount:1,first:1,last:1,assets:[{sha256,width:2,height:3,mediaType:'image/webp',bytes}],placements:[{sha256,width:2,height:3,pageNumber:1,occurrence:0,role:'image'},...(mode==='mask'?[{sha256,width:2,height:3,pageNumber:1,occurrence:1,role:'smask' as const,maskOf:0}]:[])]}));
  const run=()=>dopplerImageGraph({bundlePath:input,sourcePath:'source.pdf',sourceDocumentId:'doc-a',sourceHash:'a'.repeat(64),pageCount:1,targets:['document/media-map'],scratchDir:dir,recordUsage:vi.fn(),canContinue:()=>mode!=='budget',reserveOrientation:()=>reserveOrientationAttempt({run:{stats:{imageOrientationAttempts:mode==='limit'?64:0}}})});
  if(mode==='budget'){await expect(run()).rejects.toThrow('cost cap');expect(normalizeImageOrientation).not.toHaveBeenCalled();return;}
  const result=await run();const original=result.artifacts.find(a=>a.mediaType==='image/webp')!;expect(await readFile(original.uri)).toEqual(bytes);
  const map=JSON.parse(await readFile(result.artifacts.find(a=>a.kind==='document/media-map')!.uri,'utf8'));
  if(mode==='limit'){expect(normalizeImageOrientation).not.toHaveBeenCalled();expect(map.images[0].orientation.status).toBe('skipped-limit');expect(result.artifacts.filter(a=>a.mediaType==='image/png')).toHaveLength(0);}
  else if(mode==='mask'){expect(normalizeImageOrientation).not.toHaveBeenCalled();expect(map.images[0].orientation.status).toBe('skipped-linked-mask');}
  else {const derivative=result.artifacts.find(a=>a.mediaType==='image/png')!;expect(derivative.derivedFrom).toEqual([original.id]);expect(map.images[0].artifactId).toBe(original.id);expect(map.images[0].orientation.artifactId).toBe(derivative.id);expect(release).toHaveBeenCalledOnce();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
