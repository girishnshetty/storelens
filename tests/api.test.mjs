import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { fixtureClient, fixtureOrigin } from './fixtures.mjs';
import { dependency } from '../lib/dependencies.mjs';
const JSZip=dependency('jszip'),{PDFDocument}=dependency('pdf-lib');
test('API: scan → exact findings → approvals → upload → five independent report formats',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'storelens-api-')),app=createApp({directory:dir,token:'test-workspace',clientFactory:()=>({policy:async()=>({status:200,sitemaps:[fixtureOrigin+'/sitemap.xml']}),get:async url=>(await fixtureClient()).get(url)})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=(path,options={})=>fetch(base+'/api'+path,{...options,headers:{'content-type':'application/json',authorization:'Bearer test-workspace',...options.headers}});
 try {
  assert.equal((await fetch(base+'/api/scans')).status,401);
  assert.equal((await call('/scans',{headers:{origin:'https://evil.example.com'}})).status,403);
  assert.equal((await call('/scans',{method:'POST',body:JSON.stringify({url:'http://127.0.0.1/'})})).status,400);
  const created=await call('/scans',{method:'POST',body:JSON.stringify({url:fixtureOrigin,modules:['seo','images','catalog'],config:{maxPages:5,maxImages:2}})});assert.equal(created.status,202);const {scan}=await created.json();let data;
  for(let i=0;i<100;i++){data=await (await call('/scans/'+scan.id)).json();if(data.scan.status==='completed')break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(data.scan.status,'completed');assert.equal(data.scan.analyzed,2);assert.ok(data.issues.length>0);
  const products=await (await call(`/scans/${scan.id}/products?search=textile&status=inspected`)).json();assert.equal(products.total,2);assert.equal(products.rows.length,2);assert.equal(products.pageSize,30);
  const issue=data.issues.find(i=>i.rule==='meta-description');assert.equal((await call(`/scans/${scan.id}/issues/${issue.id}`,{method:'PATCH',body:JSON.stringify({proposed:'Verified local editorial suggestion.',approval:'approved'})})).status,200);
  const ds='sku,name,category,stock,reserved,on_order,units_30,price,margin_percent,visits_30,orders_30\nA,Textile,Handloom,20,0,0,60,750,45,200,1\nB,Second textile,Handloom,10,0,0,0,500,20,20,0';
  assert.equal((await call(`/scans/${scan.id}/upload`,{method:'POST',body:JSON.stringify({filename:'authorized-test.csv',base64:Buffer.from(ds).toString('base64'),asOf:'2026-10-15',authorized:true})})).status,200);
  const inventoryOnly=await (await call(`/scans/${scan.id}/analyze-upload`,{method:'POST',body:JSON.stringify({module:'inventory',settings:{leadTime:7,targetDays:30,safetyStock:5,window:30}})})).json();assert.equal(inventoryOnly.inventory.length,2);assert.equal(inventoryOnly.merchandising.length,0);
  const analysis=await (await call(`/scans/${scan.id}/analyze-upload`,{method:'POST',body:JSON.stringify({settings:{leadTime:7,targetDays:30,safetyStock:5,window:30}})})).json();assert.equal(analysis.inventory[0].daily,2);assert.ok(analysis.merchandising.length>0);
  for(const module of ['seo','images','catalog','inventory','merchandising'])for(const format of ['csv','xlsx','pdf']){const response=await call(`/scans/${scan.id}/export/${module}.${format}`);assert.equal(response.status,200,`${module}.${format}`);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>100);if(format==='xlsx'){const zip=await JSZip.loadAsync(bytes);assert.ok(zip.file('xl/worksheets/sheet1.xml'));assert.ok(zip.file('xl/worksheets/sheet2.xml'));}if(format==='pdf'){assert.ok((await PDFDocument.load(bytes)).getPageCount()>=1);}if(format==='csv')assert.match(bytes.toString(),/Scan ID/);}
  const chosen=await (await call(`/scans/${scan.id}/export/seo.csv?ids=${issue.id}`)).text();assert.match(chosen,/Verified local editorial suggestion/);assert.match(chosen,/1 selected findings/);
  for(const scope of ['out-of-stock','fast-moving','slow-moving','stock-updates']){const scoped=await call(`/scans/${scan.id}/export/inventory.csv?scope=${scope}`);assert.equal(scoped.status,200);assert.match(await scoped.text(),new RegExp(scope));}
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
