import { dependency } from './dependencies.mjs';
const JSZip=dependency('jszip'),{PDFDocument,StandardFonts,rgb}=dependency('pdf-lib');
export const xml=v=>String(v??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const column=n=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
export function csv(rows){return '\uFEFF'+rows.map(row=>row.map(v=>{let value=String(v??'');if(/^[=+\-@\t\r]/.test(value))value="'"+value;return '"'+value.replaceAll('"','""')+'"';}).join(',')).join('\r\n');}
export async function xlsx(sheets){const zip=new JSZip();const content=[],relations=[];let count=0;
  for(const [name,rows]of Object.entries(sheets)){count++;content.push(`<Override PartName="/xl/worksheets/sheet${count}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);relations.push(`<Relationship Id="rId${count}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${count}.xml"/>`);
    const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="30" width="32" customWidth="1"/></cols><sheetData>${rows.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>`<c r="${column(c)}${r+1}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v??'').slice(0,32767))}</t></is></c>`).join('')}</row>`).join('')}</sheetData>${rows.length?`<autoFilter ref="A1:${column((rows[0]?.length||1)-1)}${rows.length}"/>`:''}</worksheet>`;
    zip.file(`xl/worksheets/sheet${count}.xml`,sheet);
  }
  zip.file('[Content_Types].xml',`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${content.join('')}</Types>`);
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/_rels/workbook.xml.rels',`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations.join('')}</Relationships>`);
  zip.file('xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${Object.keys(sheets).map((name,i)=>`<sheet name="${xml(name.slice(0,31))}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
const issueHeaders=['Product ID','SKU','Product / page','URL','Module','Rule','Issue','Severity','Verification','Evidence','Original value','Recommended action','Proposed content','Confidence','Approval status','Source','Observed timestamp','Image URL','Score','Image dimensions','Image bytes','Image error'];
const issueRow=i=>[i.productId,i.sku,i.productName,i.url,i.module,i.rule,i.title,i.severity,i.verification,i.evidence,i.current,i.recommendation,i.proposed,i.confidence,i.approval,i.source,i.createdAt,i.imageUrl,i.score,i.imageMetadata?.width?`${i.imageMetadata.width} × ${i.imageMetadata.height}`:'',i.imageMetadata?.size??'',i.imageMetadata?.error||''];
export async function report(detail,module,format,selected=[],scope='all'){const {scan}=detail;const privateModule=['inventory','merchandising'].includes(module);if(!privateModule&&!scan.modules.includes(module))throw new Error('This module was not run in the selected scan.');if(privateModule&&!detail.dataset)throw new Error('Requires Store Connection: upload authorized data before exporting this module.');
  const issues=detail.issues.filter(i=>i.module===module&&(!selected.length||selected.includes(i.id))).map(i=>({...i,imageMetadata:detail.images.find(img=>img.url===i.imageUrl)?.result}));
  let records=privateModule?detail[module]||[]:issues;
  if(module==='inventory'){const scopes={all:()=>true,'out-of-stock':r=>r.stock===0,'fast-moving':r=>r.classification==='Fast-moving','slow-moving':r=>['Slow-moving','Non-moving'].includes(r.classification),'stock-updates':r=>r.reorder>0};if(!scopes[scope])throw new Error('Unknown inventory analysis scope.');records=records.filter(scopes[scope]);}
  const headers=privateModule?Object.keys(records[0]||{status:'Requires data'}):issueHeaders;
  const table=[headers,...records.map(r=>privateModule?headers.map(k=>r[k]):issueRow(r))];
  const meta=[['Storelens audit metadata','Value'],['Scan ID',scan.id],['Store',scan.url],['Module',module],['Status',scan.status],['Created',scan.createdAt],['Finished',scan.finishedAt],['Exported',new Date().toISOString()],['Page budget',scan.config.maxPages],['Image budget',scan.config.maxImages],['Products discovered',scan.discovered],['Products inspected',scan.analyzed],['Store health',scan.score??'Not available'],['Recorded check coverage',`${scan.coverage.percent}% (${scan.coverage.completed}/${scan.coverage.total||0})`],['Data source',privateModule?detail.dataset.filename:'Public storefront HTML and public product feed'],['Dataset snapshot',detail.dataset?.asOf||'N/A'],['Selection',selected.length?`${selected.length} selected findings`:'All module findings'],['Scoring','100 × passed rule weights / completed rule weights; high=5, medium=3, low=1. Unknown checks excluded.'],['Limitations',scan.notes.join(' | ')],['Errors',scan.errors.join(' | ')],['Publication','No changes have been published to the store.']];
  meta.push(['Analysis scope',scope]);
  if(privateModule&&detail.dataset.settings)meta.push(['Planning settings',JSON.stringify(detail.dataset.settings)]);
  const coverage=[['Rule','Target URL','Status','Weight','Evidence','Timestamp'],...detail.checks.filter(c=>c.module===module).map(c=>[c.rule,c.target,c.status,c.weight,c.evidence,c.createdAt])];
  if(format==='csv')return {bytes:Buffer.from(csv([...meta,[],...table,[],...coverage])),mime:'text/csv; charset=utf-8'};
  if(format==='xlsx')return {bytes:await xlsx({Findings:table,Metadata:meta,Coverage:coverage}),mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  if(format==='pdf')return {bytes:await pdfSummary(module,meta,issues,privateModule?table:null),mime:'application/pdf'};
  throw new Error('Unsupported export format.');
}
// Standard PDF fonts cover Latin-1. Preserve other characters as explicit Unicode
// code points in this compact summary; CSV/XLSX preserve original Unicode text.
const printable=text=>String(text??'').replaceAll('₹','INR ').replace(/[–—→]/g,'-').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[^\x20-\x7e\xa0-\xff\n]/gu,c=>'[U+'+c.codePointAt(0).toString(16).toUpperCase()+']');
async function pdfSummary(module,meta,issues,table){const doc=await PDFDocument.create();doc.setTitle(`Storelens ${module} audit`);const font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);let page,y;
  function next(){page=doc.addPage([595.28,841.89]);y=788;page.drawText('STORELENS / STORE INTELLIGENCE',{x:42,y,font:bold,size:9,color:rgb(.2,.3,.45)});y-=32;}
  function line(text,{size=9,strong=false}={}){const face=strong?bold:font;let value=printable(text);const chunks=value.match(/.{1,100}(?:\s|$)|.{1,100}/g)||[''];for(const chunk of chunks){if(y<50)next();page.drawText(chunk.trim(),{x:42,y,size,font:face,color:rgb(.18,.25,.36)});y-=size+5;}}
  next();line(`${module.toUpperCase()} AUDIT SUMMARY`,{size:18,strong:true});y-=12;
  for(const [k,v]of meta.slice(1))line(`${k}: ${v}`);y-=12;
  line('Findings (up to 100; use Excel or CSV for all rows)',{size:12,strong:true});y-=8;
  if(table){for(const row of table.slice(1,101)){for(let i=0;i<table[0].length;i++)line(`${table[0][i]}: ${row[i]??'unavailable'}`);y-=10;}}
  else if(!issues.length)line('No findings recorded. Review check coverage before interpreting this result.');
  else for(const issue of issues.slice(0,100)){line(`${issue.title} | ${issue.severity} | ${issue.verification}`,{strong:true});line(`${issue.productName} / SKU ${issue.sku||'not exposed'}`);line(issue.url);line(`Evidence: ${issue.evidence}`);line(`Original: ${issue.current}`);line(`Recommended action: ${issue.recommendation}`);line(`Proposed: ${issue.proposed}`);line(`Observed: ${issue.createdAt}; confidence: ${issue.confidence}; approval: ${issue.approval}`);y-=12;}
  for(const [i,p]of doc.getPages().entries())p.drawText(`${i+1} / ${doc.getPageCount()} - Storelens - Read-only audit`,{x:42,y:27,size:8,font,color:rgb(.5,.55,.62)});
  return Buffer.from(await doc.save());
}
