import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dependency } from '../lib/dependencies.mjs';
const {PDFDocument}=dependency('pdf-lib'),JSZip=dependency('jszip');
const base=process.env.AUDIT_TEST_URL||'http://127.0.0.1:4185',headers=process.env.AUDIT_ACCESS_TOKEN?{authorization:`Bearer ${process.env.AUDIT_ACCESS_TOKEN}`}:{ };
const response=await fetch(base+'/api/scans',{headers});if(!response.ok)throw new Error('Unable to load scans.');
const {scans}=await response.json();const scan=scans.find(s=>s.id===process.argv[2])||scans.find(s=>s.status==='completed');if(!scan)throw new Error('No completed scan available.');
const data=await (await fetch(base+'/api/scans/'+scan.id,{headers})).json();
const output=fileURLToPath(new URL('../../output/store-audit/reports/',import.meta.url));await mkdir(output,{recursive:true});
const verified=[];
for(const module of scan.modules)for(const format of ['csv','xlsx','pdf']){
 const result=await fetch(`${base}/api/scans/${scan.id}/export/${module}.${format}`,{headers});if(!result.ok)throw new Error(`${module}.${format} failed`);const bytes=Buffer.from(await result.arrayBuffer());const path=output+`${module}.${format}`;await writeFile(path,bytes);let evidence=bytes.length+' bytes';
 if(format==='xlsx'){const zip=await JSZip.loadAsync(bytes);if(!zip.file('xl/worksheets/sheet3.xml'))throw new Error('Missing coverage worksheet.');evidence+='; 3 worksheets';}
 if(format==='pdf')evidence+=`; ${(await PDFDocument.load(bytes)).getPageCount()} PDF pages`;
 verified.push({module,format,path,evidence});
}
const summary={scan:{id:scan.id,url:scan.url,createdAt:scan.createdAt,finishedAt:scan.finishedAt,status:scan.status,config:scan.config,discovered:scan.discovered,analyzed:scan.analyzed,score:scan.score,summary:scan.summary,coverage:scan.coverage,notes:scan.notes,errors:scan.errors},pages:data.pages.length,images:{attempted:data.images.length,decoded:data.images.filter(i=>i.result?.width).length,unavailable:data.images.filter(i=>i.result?.error).length},findingCounts:Object.fromEntries(['seo','images','catalog'].map(module=>[module,Object.fromEntries(['Confirmed Issue','Potential Issue','Not Checked','Requires Integration'].map(status=>[status,data.issues.filter(i=>i.module===module&&i.verification===status).length]))])),exports:verified};
await writeFile(output+'validation.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
