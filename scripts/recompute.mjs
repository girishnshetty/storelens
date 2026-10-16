// Recompute deterministic findings from saved evidence without another crawl.
import { fileURLToPath } from 'node:url';
import { openStore, updateSummary } from '../lib/db.mjs';
import { recorder, auditDuplicates } from '../lib/rules.mjs';
const id=process.argv[2];if(!id)throw new Error('Usage: node scripts/recompute.mjs <scan-id>');
const store=openStore(process.env.AUDIT_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)));
try{
 const scan=store.get(id);if(!scan||scan.status!=='completed')throw new Error('Select a completed scan.');
 // An earlier development rule compared URL-derived labels. Remove those checks;
 // their replacements are based exclusively on inspected product names.
 for(const table of ['checks','issues'])store.db.prepare(`DELETE FROM ${table} WHERE scan_id=? AND json_extract(data,'$.rule')=?`).run(id,'duplicate-product-name');
 const pages=store.rows('pages',id).filter(p=>!p.failed),products=store.rows('products',id);
 auditDuplicates(pages,products,recorder(store,scan),scan.modules);
 scan.notes=scan.notes.filter(n=>!n.startsWith('Public product feed enrichment is sampled'));
 scan.notes.push(`Retained ${products.filter(p=>p.externalId).length} public-feed records from the initial/resumed discovery. These are separate from ${products.filter(p=>p.inspected).length} page inspections. URL-derived labels do not contribute scored name-duplication checks.`);
 updateSummary(store,scan);
 const checks=store.rows('checks',id);for(const issue of store.rows('issues',id)){const relevant=checks.filter(c=>c.module===issue.module&&c.target===issue.url&&['Passed','Confirmed Issue','Potential Issue'].includes(c.status));const total=relevant.reduce((n,c)=>n+c.weight,0);issue.score=total?Math.round(100*relevant.filter(c=>c.status==='Passed').reduce((n,c)=>n+c.weight,0)/total):null;store.putIssue(id,issue);}
 console.log(JSON.stringify({id,status:scan.status,discovered:scan.discovered,analyzed:scan.analyzed,score:scan.score,summary:scan.summary,coverage:scan.coverage}));
}finally{store.close();}
