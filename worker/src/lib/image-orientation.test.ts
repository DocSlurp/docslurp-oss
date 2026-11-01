import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {imageOrientationEnabled,normalizeImageOrientation,withOrientationAdmission,reserveOrientationAttempt} from './image-orientation.js';
import {executeDopplerVm} from '../sandbox/providers/modal/doppler-vm.js';
import {SandboxRunError} from '../sandbox/types.js';
vi.mock('../sandbox/providers/modal/doppler-vm.js',()=>({executeDopplerVm:vi.fn(),VM_TIMEOUT_MS:60000,dopplerVmUsage:()=>({costCents:1})}));
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('defaults on, accepts explicit booleans and legacy digits, and refuses invalid flags',()=>{
 vi.stubEnv('DOCSLURP_IMAGE_ORIENTATION',undefined);expect(imageOrientationEnabled()).toBe(true);
 vi.stubEnv('DOCSLURP_IMAGE_ORIENTATION','true');expect(imageOrientationEnabled()).toBe(true);
 vi.stubEnv('DOCSLURP_IMAGE_ORIENTATION','false');expect(imageOrientationEnabled()).toBe(false);
 vi.stubEnv('DOCSLURP_IMAGE_ORIENTATION','0');expect(imageOrientationEnabled()).toBe(false);
 vi.stubEnv('DOCSLURP_IMAGE_ORIENTATION','1');expect(imageOrientationEnabled()).toBe(true);
 vi.stubEnv('DOCSLURP_IMAGE_ORIENTATION','yes');expect(()=>imageOrientationEnabled()).toThrow();
});
it('uses a distinct derivative, accounts for VM cost and cleans it without changing original',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'orientation-helper-'));const input=path.join(dir,'source');await writeFile(input,'original');
 const usage={provider:'modal',model:'vm',metric:'sandbox_compute',amount:1,unit:'cent',costCents:1};
 vi.mocked(executeDopplerVm).mockImplementation(async job=>{await writeFile(job.output,'derivative');return {stdout:JSON.stringify({orientation:{status:'corrected'}}),stderr:'',exitCode:0,usage};});
 try {const record=vi.fn();const result=await normalizeImageOrientation(input,record);expect(record).toHaveBeenCalledExactlyOnceWith(usage);expect(result.path).not.toBe(input);await result.release();await expect(access(result.path)).rejects.toThrow();await expect(access(input)).resolves.toBeUndefined();}finally{await rm(dir,{recursive:true,force:true});}
});
it('records failed VM spend and never falls back to an unconfined decoder',async()=>{
 const usage={provider:'modal',model:'vm',metric:'sandbox_compute',amount:1,unit:'cent',costCents:1};
 vi.mocked(executeDopplerVm).mockRejectedValue(new SandboxRunError('confinement unavailable',usage));const record=vi.fn();
 await expect(normalizeImageOrientation('/unused/source',record)).rejects.toThrow('confinement unavailable');expect(record).toHaveBeenCalledExactlyOnceWith(usage);
});

it('refused vision admission cannot launch a paid orientation job',async()=>{
 const gate={admit:vi.fn().mockRejectedValue(new Error('org budget exhausted')),unbilled:vi.fn()};
 const prepare=vi.fn();await expect(withOrientationAdmission(gate as never,prepare)).rejects.toThrow('org budget exhausted');
 expect(prepare).not.toHaveBeenCalled();expect(executeDopplerVm).not.toHaveBeenCalled();expect(gate.unbilled).not.toHaveBeenCalled();
});
it('holds admission during preparation and releases the unsent model request on failure',async()=>{
 const events:string[]=[];const gate={admit:vi.fn(async()=>{events.push('admit');}),unbilled:vi.fn(async()=>{events.push('release');return true;})};
 await expect(withOrientationAdmission(gate as never,async()=>{events.push('prepare');throw new Error('VM failure');})).rejects.toThrow('VM failure');
 expect(events).toEqual(['admit','prepare','release']);expect(gate.unbilled).toHaveBeenCalledWith('cancelled');
});

it('bounds attempts including failures and refuses malformed persisted counters',()=>{
 const state={run:{stats:{} as Record<string,unknown>}};
 for(let i=0;i<64;i++)reserveOrientationAttempt(state);
 expect(reserveOrientationAttempt(state)).toBe(false);
 expect(state.run.stats.imageOrientationAttempts).toBe(64);
 for(const value of [-1,NaN,'0',Infinity]){state.run.stats.imageOrientationAttempts=value;expect(()=>reserveOrientationAttempt(state)).toThrow();}
});
