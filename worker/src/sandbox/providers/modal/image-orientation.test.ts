import {expect,it} from 'vitest';
import {validOrientationEnvelope} from './image-orientation.js';
import {HARDENING_POLICY,MIN_SECCOMP_DENIED} from './doppler-vm.js';
it('requires bounded geometry, confidence, PNG framing and actual hardening',()=>{
 const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(200,16);bytes.writeUInt32BE(300,20);
 const d={protocol:'doppler-vm@5',engine:'orientation',outputBytes:33,hardening:{policy:HARDENING_POLICY,noNewPrivs:true,landlockAbi:4,seccompDenied:MIN_SECCOMP_DENIED},orientation:{model:'PP-LCNet_x1_0_doc_ori',modelSha256:'a'.repeat(64),status:'corrected',inputClockwiseDegrees:90,correctionClockwiseDegrees:270,confidence:.94,margin:.9,width:200,height:300,sourceWidth:300,sourceHeight:200,exifOrientation:1,exifApplied:false,mimeType:'image/png'}};
 expect(validOrientationEnvelope(d,bytes)).toBe(true);
 for(const patch of [{confidence:.2},{width:201},{correctionClockwiseDegrees:90},{status:'upright'},{model:'unknown'},{sourceWidth:16_000_001}]) expect(validOrientationEnvelope({...d,orientation:{...d.orientation,...patch}},bytes)).toBe(false);
 expect(validOrientationEnvelope({...d,hardening:null},bytes)).toBe(false);
 expect(validOrientationEnvelope(d,Buffer.from('evil'))).toBe(false);
});
