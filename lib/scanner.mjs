import { SafeClient, validateURL } from './network.mjs';
import { stableId, updateSummary } from './db.mjs';
import { parsePage, parseSitemap, shopifyProducts, canonicalURL, kindOf } from './extract.mjs';
import { recorder, auditPage, auditDuplicates } from './rules.mjs';
import { auditImages } from './images.mjs';

class Paused extends Error {}
export function createQueue(store,{clientFactory=()=>new SafeClient()}={}) {
  const queue=[];let active=null,closed=false,currentRun=null;
  function enqueue(id){if(closed)throw new Error('Scanner is shutting down.');if(active===id||queue.includes(id))return;queue.push(id);setImmediate(pump);}
  async function pump(){if(active||closed||!queue.length)return;active=queue.shift();try{currentRun=runScan(store,active,clientFactory());await currentRun;}catch(error){console.error(JSON.stringify({event:'scanner_storage_failure',scan:active,message:error.message}));}finally{currentRun=null;active=null;setImmediate(pump);}}
  return {enqueue,get active(){return active;},get pending(){return queue.length;},async close(){closed=true;if(active){const s=store.get(active);if(s){s.status='interrupted';s.stage='Scanner stopped; resume to continue.';store.save(s);}}await currentRun;}};
}
export async function runScan(store,id,client) {
  const scan=store.get(id);if(!scan||scan.status==='cancelled')return;
  scan.status='running';scan.finishedAt=null;scan.errors=[];scan.stage='Reading crawl access policy';scan.step=0;store.save(scan);
  const check=recorder(store,scan),origin=new URL(scan.url).origin;
  const productMap=new Map(store.rows('products',id).map(p=>[p.url,p]));
  const putProduct=p=>{productMap.set(p.url,p);store.put('products',id,p);};
  const checkpoint=()=>{const persisted=store.get(id);if(['cancelled','interrupted'].includes(persisted?.status)){scan.status=persisted.status;scan.stage=persisted.stage;throw new Paused();}};
  const note=message=>{if(!scan.notes.includes(message))scan.notes.push(message);store.save(scan);};
  const addURL=(input)=>{try{const u=validateURL(input);if(u.origin!==origin||/\.(jpg|png|webp|gif|pdf|zip|css|js|xml)$/i.test(u.pathname)||/\/(cart|checkout|account|search|wp-admin)(\/|$)/.test(u.pathname))return;
    if([...u.searchParams.keys()].some(k=>!['page','paged'].includes(k)))return;
    let url=canonicalURL(u.href,origin);if(scan.platform==='Shopify'&&/\/collections\/[^/]+\/products\//.test(new URL(url).pathname))url=origin+'/products/'+new URL(url).pathname.split('/products/')[1];
    if(!scan.checkpoint.urls.includes(url)&&scan.checkpoint.urls.length<20000)scan.checkpoint.urls.push(url);
    if(kindOf(url)==='product'&&!productMap.has(url))putProduct({id:stableId(url),url,name:new URL(url).pathname.split('/').at(-1).replaceAll('-',' '),sku:'',description:'',category:'',price:null,availability:null,images:[],inspected:false,source:'URL discovery'});
  }catch{}};
  const saveCounts=()=>{scan.discovered=store.rows('products',id).length;updateSummary(store,scan);};
  try {
    const policy=await client.policy(origin);checkpoint();
    if(scan.modules.includes('seo'))check('seo','robots-access',{url:scan.url,kind:'page',name:'Store crawl access'},'Passed',`robots.txt HTTP ${policy.status}. Crawl rules applied.`,{severity:'high'});
    let homepage=store.rows('pages',id).find(p=>p.url===scan.url);
    if(!homepage) {
      const response=await client.get(scan.url,{allowedOrigin:origin});checkpoint();
      if(response.status!==200)throw new Error(`Store homepage returned HTTP ${response.status}; access restrictions were not bypassed.`);
      const result=parsePage(response.text,response.url,response);homepage=result.page;scan.platform=result.platform;
      store.put('pages',id,homepage);auditPage(homepage,result.product,check,scan.modules);if(result.product)putProduct(result.product);
    }
    addURL(scan.url);homepage.links.forEach(addURL);scan.progress=5;store.save(scan);
    if(!scan.checkpoint.discoveryDone) {
      scan.stage='Discovering product and collection URLs';store.save(scan);
      const sitemapQueue=[...new Set([...(scan.checkpoint.sitemapQueue||[]),...policy.sitemaps,origin+'/sitemap.xml'])];scan.checkpoint.sitemapQueue=sitemapQueue;let validSitemaps=0;
      for(let i=0;i<sitemapQueue.length&&i<80;i++) {
        checkpoint();const url=sitemapQueue[i];if(scan.checkpoint.sitemaps.includes(url))continue;
        try{if(new URL(url).origin!==origin)continue;const r=await client.get(url,{maxBytes:8000000,allowedOrigin:origin});if(r.status!==200){note(`Sitemap ${url} returned HTTP ${r.status}.`);continue;}const parsed=parseSitemap(r.text,url);if(parsed.valid)validSitemaps++;for(const next of parsed.sitemaps)if(!sitemapQueue.includes(next)&&sitemapQueue.length<80)sitemapQueue.push(next);parsed.urls.forEach(addURL);
          scan.checkpoint.sitemaps.push(url);scan.checkpoint.sitemapValid=(scan.checkpoint.sitemapValid||0)+(parsed.valid?1:0);saveCounts();
        }catch(error){note(`Sitemap not checked: ${error.message}`);}
      }
      if(scan.modules.includes('seo'))check('seo','sitemap',{url:scan.url,name:'Store sitemap',kind:'page'},scan.checkpoint.sitemapValid?'Passed':'Potential Issue',`${scan.checkpoint.sitemapValid||validSitemaps} valid sitemap files read; budget 80 files / 20,000 URLs.`,{title:'No usable sitemap discovered',recommendation:'Verify the sitemap URL and crawl access. Inaccessible sitemaps are not assumed missing.'});
      const feedPages=Math.max(1,Math.min(40,Math.ceil(scan.config.maxPages/250)));
      if(scan.platform==='Shopify')for(let page=scan.checkpoint.feedPage||1;page<=feedPages;page++) {
        checkpoint();
        try{const r=await client.get(`${origin}/products.json?limit=250&page=${page}`,{allowedOrigin:origin,maxBytes:8000000});if(r.status!==200){note(`Shopify public feed HTTP ${r.status}; discovery continues from public links and sitemaps.`);break;}
          const products=shopifyProducts(JSON.parse(r.text),origin);if(!products.length)break;let added=0;
          for(const p of products){const existing=productMap.get(p.url);if(existing?.source==='Shopify public product feed')continue;addURL(p.url);if(!existing?.inspected)putProduct(p);added++;}
          scan.checkpoint.feedPage=page+1;saveCounts();if(!added||products.length<250)break;
        }catch(error){note(`Public product feed not checked: ${error.message}`);break;}
      }
      if(scan.platform==='Shopify')note(`Public product feed enrichment budget: ${feedPages} pages of 250 records. Resumed jobs retain previously collected feed records. Sitemap discovery is independent; page-level checks only score inspected pages.`);
      scan.checkpoint.discoveryDone=true;saveCounts();
    }
    scan.step=1;scan.progress=15;scan.stage='Inspecting pages';store.save(scan);
    // Prioritize the homepage, a small set of collections, then product pages.
    const urls=scan.checkpoint.urls,collections=urls.filter(u=>kindOf(u)==='collection').slice(0,Math.max(1,Math.min(5,Math.floor(scan.config.maxPages/5))));
    const ordered=[...new Set([scan.url,...collections,...urls.filter(u=>kindOf(u)==='product'),...urls])];
    const attempted=new Set(store.rows('pages',id).map(p=>p.requestedURL||p.url));let done=attempted.size;
    for(let index=0;index<ordered.length&&done<scan.config.maxPages;index++) {
      checkpoint();const url=ordered[index];if(attempted.has(url))continue;
      scan.stage=`Inspecting page ${done+1} of up to ${scan.config.maxPages}`;scan.progress=15+Math.round(done/scan.config.maxPages*60);store.save(scan);
      try{const r=await client.get(url,{allowedOrigin:origin});checkpoint();
        if(r.status!==200){const status=[404,410].includes(r.status)?'Confirmed Issue':'Not Checked';for(const module of scan.modules.filter(m=>m!=='images'))check(module,'page-response',{id:stableId(url),url,name:url,kind:kindOf(url)},status,`Page returned HTTP ${r.status}.`,{title:'Product or page could not be loaded',severity:'high',recommendation:'Verify the URL and access policy. Correct broken pages when confirmed.'});store.put('pages',id,{id:stableId(url),url,status:r.status,kind:kindOf(url),failed:true,requestedURL:url});continue;}
        if(!/html/i.test(r.headers['content-type']||'')&&!/<html|<!doctype/i.test(r.text.slice(0,1000))){note(`Skipped non-HTML page ${url}`);continue;}
        const result=parsePage(r.text,url,r);result.page.requestedURL=url;result.page.finalURL=r.url;const existing=productMap.get(url);let p=result.product;
        if(p){p={...existing,...p,externalId:existing?.externalId,feedAvailability:existing?.availability,sku:p.sku||existing?.sku||'',category:p.category||existing?.category||'',description:p.description||existing?.description||'',price:p.price??existing?.price??null,availability:p.availability||existing?.availability||null,images:(existing?.images?.length?existing.images:p.images).map(img=>{const match=result.page.images.find(i=>new URL(i.url).pathname===new URL(img.url).pathname);return {...img,alt:match?.alt||img.alt||'',altVerified:!!match};}),variants:existing?.variants||p.variants,inspected:true};putProduct(p);}
        store.put('pages',id,result.page);auditPage(result.page,p,check,scan.modules);
        for(const next of result.page.links){addURL(next);if(!ordered.includes(next)&&new URL(next).origin===origin&&(kindOf(next)==='product'||/[?&](page|paged)=|\/page\/\d+/.test(next))&&scan.checkpoint.urls.includes(canonicalURL(next,origin)))ordered.push(canonicalURL(next,origin));}
      }catch(error){if(error instanceof Paused)throw error;scan.errors.push(`${url}: ${error.message}`);for(const module of scan.modules)check(module,'page-response',{id:stableId(url),url,name:url,kind:kindOf(url)},'Not Checked',error.message,{title:'Page inspection unavailable',severity:'high',recommendation:'Resolve access or network errors, then retry this scan.'});}
      finally{done++;attempted.add(url);saveCounts();}
    }
    if(scan.modules.includes('seo'))await auditLinks(store,scan,client,check,checkpoint);
    checkpoint();scan.step=2;scan.progress=80;store.save(scan);
    if(scan.modules.includes('images'))await auditImages({store,scan,client,check,checkpoint});
    checkpoint();scan.step=3;scan.progress=93;scan.stage='Scoring completed checks';store.save(scan);
    auditDuplicates(store.rows('pages',id).filter(p=>!p.failed),store.rows('products',id),check,scan.modules);
    saveCounts();
    // Add per-module product scores to issue rows without treating unrun checks as passes.
    const checks=store.rows('checks',id);for(const issue of store.rows('issues',id)){const relevant=checks.filter(c=>c.module===issue.module&&c.target===issue.url&&['Passed','Confirmed Issue','Potential Issue'].includes(c.status));const total=relevant.reduce((n,c)=>n+c.weight,0);issue.score=total?Math.round(100*relevant.filter(c=>c.status==='Passed').reduce((n,c)=>n+c.weight,0)/total):null;store.putIssue(id,issue);}
    scan.status='completed';scan.step=5;scan.progress=100;scan.stage=`${scan.analyzed} products inspected; ${scan.discovered} discovered. Scan budgets apply.`;scan.finishedAt=new Date().toISOString();note('HTML inspection only. JavaScript-only content, measured performance and private inventory require additional adapters.');updateSummary(store,scan);
  }catch(error){if(error instanceof Paused)return;scan.status='failed';scan.stage='Scan stopped';scan.errors.push(error.message);scan.finishedAt=new Date().toISOString();for(const module of scan.modules)check(module,'crawl-access',{url:scan.url,name:'Store access',kind:'page'},'Not Checked',error.message,{title:'Store crawl access unavailable',severity:'high',recommendation:'Verify robots and public access. Access controls are never bypassed.'});updateSummary(store,scan);}
}
async function auditLinks(store,scan,client,check,checkpoint){let budget=20;const visited=new Map();for(const page of store.rows('pages',scan.id).filter(p=>!p.failed)){checkpoint();const links=page.links.filter(l=>new URL(l).origin===new URL(scan.url).origin&&!/\/(cart|account|checkout|search)/.test(new URL(l).pathname)).slice(0,5);for(const url of links){if(!budget&&!visited.has(url))continue;let result=visited.get(url);if(!result){budget--;try{const r=await client.get(url,{allowedOrigin:new URL(scan.url).origin,maxBytes:1500000});result={status:r.status,chain:r.chain};}catch(e){result={error:e.message};}visited.set(url,result);}check('seo','internal-link:'+stableId(url),{...page,name:page.title},result.error||[401,403,429].includes(result.status)?'Not Checked':[404,410].includes(result.status)?'Confirmed Issue':result.status>=500?'Potential Issue':'Passed',`${url}: ${result.error||'HTTP '+result.status}`,{title:'Internal link needs review',severity:'medium',current:url,recommendation:'Repair confirmed broken destinations and update links to their final URLs.'});}check('seo','internal-link-coverage',{...page,name:page.title},'Not Checked',`At most 5 links per page / 20 unique links per scan. ${page.links.length} page links discovered.`,{title:'Internal link coverage is sampled',severity:'low',recommendation:'Use a full crawl to inspect the remaining link graph.'});}}
