import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export function openStore(directory) {
  if(directory!==':memory:')mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(directory===':memory:'?':memory:':join(directory,'storelens.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products(scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,id TEXT NOT NULL,url TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scan_id,id),UNIQUE(scan_id,url));
    CREATE TABLE IF NOT EXISTS pages(scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scan_id,id));
    CREATE TABLE IF NOT EXISTS images(scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scan_id,id));
    CREATE TABLE IF NOT EXISTS checks(scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,id TEXT NOT NULL,module TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scan_id,id));
    CREATE TABLE IF NOT EXISTS issues(scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,id TEXT NOT NULL,module TEXT NOT NULL,product_id TEXT,data TEXT NOT NULL,PRIMARY KEY(scan_id,id));
    CREATE TABLE IF NOT EXISTS datasets(scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS issues_module ON issues(scan_id,module);
    CREATE INDEX IF NOT EXISTS checks_status ON checks(scan_id,status);
  `);
  const get=id=>{const row=db.prepare('SELECT data FROM scans WHERE id=?').get(id);return row?JSON.parse(row.data):null;};
  const list=()=>db.prepare('SELECT data FROM scans ORDER BY created_at DESC LIMIT 100').all().map(r=>JSON.parse(r.data));
  const save=scan=>db.prepare('INSERT INTO scans VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(scan.id,scan.createdAt,scan.status,JSON.stringify(scan));
  const rows=(table,id)=>db.prepare(`SELECT data FROM ${table} WHERE scan_id=?`).all(id).map(r=>JSON.parse(r.data));
  const findProducts=(id,{page=1,search='',status=''}={})=>{const size=30,term='%'+search.replace(/[\\%_]/g,c=>'\\'+c)+'%';const where=`scan_id=? AND (json_extract(data,'$.name') LIKE ? ESCAPE '\\' OR json_extract(data,'$.sku') LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')${status==='inspected'?" AND json_extract(data,'$.inspected')=1":status==='pending'?" AND json_extract(data,'$.inspected')=0":''}`;const values=[id,term,term,term];const total=db.prepare(`SELECT count(*) AS n FROM products WHERE ${where}`).get(...values).n;return {rows:db.prepare(`SELECT data FROM products WHERE ${where} ORDER BY json_extract(data,'$.inspected') DESC,url LIMIT ? OFFSET ?`).all(...values,size,(page-1)*size).map(r=>JSON.parse(r.data)),total,page,pageSize:size};};
  const put=(table,scanId,item)=>{if(!['pages','images','products'].includes(table))throw new Error('Invalid table');if(table==='products')db.prepare('INSERT INTO products VALUES(?,?,?,?) ON CONFLICT(scan_id,id) DO UPDATE SET data=excluded.data').run(scanId,item.id,item.url,JSON.stringify(item));else db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(scan_id,id) DO UPDATE SET data=excluded.data`).run(scanId,item.id,JSON.stringify(item));};
  const putIssue=(scanId,item)=>db.prepare('INSERT INTO issues VALUES(?,?,?,?,?) ON CONFLICT(scan_id,id) DO UPDATE SET data=excluded.data').run(scanId,item.id,item.module,item.productId||null,JSON.stringify(item));
  const record=(scanId,check,issue)=>{db.prepare('INSERT INTO checks VALUES(?,?,?,?,?) ON CONFLICT(scan_id,id) DO UPDATE SET status=excluded.status,data=excluded.data').run(scanId,check.id,check.module,check.status,JSON.stringify(check));if(issue){const old=db.prepare('SELECT data FROM issues WHERE scan_id=? AND id=?').get(scanId,issue.id);if(old){const previous=JSON.parse(old.data);if(previous.approval==='approved'){issue.proposed=previous.proposed;issue.approval='approved';issue.source=previous.source;}}putIssue(scanId,issue);}else db.prepare('DELETE FROM issues WHERE scan_id=? AND id=?').run(scanId,check.id);};
  const dataset=id=>{const row=db.prepare('SELECT data FROM datasets WHERE scan_id=?').get(id);return row?JSON.parse(row.data):null;};
  const saveDataset=(id,data)=>db.prepare('INSERT INTO datasets VALUES(?,?) ON CONFLICT(scan_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(data));
  const detail=id=>{const scan=get(id);if(!scan)return null;const ds=dataset(id);return {scan,products:rows('products',id),pages:rows('pages',id),images:rows('images',id),checks:rows('checks',id),issues:rows('issues',id),dataset:ds?{filename:ds.filename,count:ds.rows.length,asOf:ds.asOf,uploadedAt:ds.uploadedAt,settings:ds.settings,analyzedAt:ds.analyzedAt}:null,inventory:ds?.inventory||[],merchandising:ds?.merchandising||[]};};
  for(const scan of list())if(['running','queued'].includes(scan.status)){scan.status='interrupted';scan.stage='Server restarted; resume to continue from saved pages.';save(scan);}
  return {db,get,list,save,rows,findProducts,put,record,putIssue,dataset,saveDataset,detail,close:()=>db.close()};
}
export const stableId=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
export function newScan(url,modules,config) { return {id:randomUUID(),url,modules:[...modules].sort(),config,status:'queued',createdAt:new Date().toISOString(),finishedAt:null,stage:'Waiting for scanner',step:0,progress:0,discovered:0,analyzed:0,platform:'Detecting',errors:[],notes:[],score:null,summary:{},coverage:{completed:0,passed:0,issues:0,percent:0},checkpoint:{urls:[],sitemaps:[],feedPage:1,discoveryDone:false}}; }
export function updateSummary(store,scan) {
  const checks=store.rows('checks',scan.id),issues=store.rows('issues',scan.id),products=store.rows('products',scan.id);
  const completed=checks.filter(c=>['Passed','Confirmed Issue','Potential Issue'].includes(c.status));
  const passed=completed.filter(c=>c.status==='Passed');
  const weights=completed.reduce((a,c)=>a+c.weight,0);
  scan.score=weights&&completed.some(c=>!['robots-access','sitemap'].includes(c.rule))?Math.round(passed.reduce((a,c)=>a+c.weight,0)/weights*100):null;
  scan.coverage={completed:completed.length,passed:passed.length,issues:completed.length-passed.length,percent:checks.length?Math.round(completed.length/checks.length*100):0,total:checks.length};
  scan.summary=Object.fromEntries(['seo','images','catalog'].map(m=>[m,new Set(issues.filter(i=>i.module===m&&['Confirmed Issue','Potential Issue'].includes(i.verification)).map(i=>i.productId||i.url)).size]));
  scan.summary.outOfStock=products.filter(p=>p.availability==='OutOfStock').length;
  scan.summary.availabilityKnown=products.filter(p=>['InStock','OutOfStock','PreOrder','BackOrder','LimitedAvailability','SoldOut','Discontinued'].includes(p.availability)).length;
  scan.analyzed=products.filter(p=>p.inspected).length;
  store.save(scan);
}
