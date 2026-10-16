import { dependency } from './dependencies.mjs';
import { stableId } from './db.mjs';
import { validateURL } from './network.mjs';
const {load}=dependency('cheerio');
export const clean = value => String(value??'').replace(/\s+/g,' ').trim();
export const words = value => clean(value).split(/\s+/).filter(Boolean);
export function absolute(value,base) { if(!value)return null;try {return validateURL(new URL(value,base).href).href;}catch{return null;} }
export function canonicalURL(input,origin) { const u=new URL(input,origin);u.hash='';for(const key of [...u.searchParams.keys()])if(/^utm_|^fbclid$|^gclid$|^variant$/.test(key))u.searchParams.delete(key);if(u.pathname!=='/')u.pathname=u.pathname.replace(/\/+$/,'');return u.href; }
export function kindOf(url) {const path=new URL(url).pathname;return /\/products?\/[^/]+/.test(path)?'product':/\/(collections?|product-category|category)\/[^/]+/.test(path)?'collection':'page';}
function allNodes(node) {if(!node||typeof node!=='object')return [];return [node,...Object.values(node).flatMap(v=>Array.isArray(v)?v.flatMap(allNodes):typeof v==='object'?allNodes(v):[])];}
const typeIs=(obj,type)=>[].concat(obj?.['@type']||[]).some(t=>String(t).split('/').at(-1)===type);
export const plainHTML = html => clean(load(String(html||'')).text());
export function parsePage(html,url,response={}) {
  const $=load(html),base=url,scripts=[];let schemaErrors=0;
  $('script[type="application/ld+json"]').each((_,el)=>{try{scripts.push(JSON.parse($(el).text()));}catch{schemaErrors++;}});
  const nodes=scripts.flatMap(allNodes),product=nodes.find(n=>typeIs(n,'Product'));
  const offer=[].concat(product?.offers||[]).flatMap(o=>o.offers?[o,...[].concat(o.offers)]:[o]).find(o=>o.price!=null||o.lowPrice!=null)||[].concat(product?.offers||[])[0];
  const meta=name=>clean($(`meta[name="${name}"],meta[property="${name}"]`).first().attr('content'));
  const title=clean($('title').first().text()),description=meta('description');
  const links=[...new Set($('a[href]').map((_,el)=>absolute($(el).attr('href'),base)).get().filter(Boolean))];
  const headings=$('h1,h2,h3,h4,h5,h6').map((_,el)=>({level:Number(el.tagName.slice(1)),text:clean($(el).text())})).get().filter(h=>h.text);
  const imgs=$('img').map((_,el)=>{const e=$(el);return {url:absolute(e.attr('data-src')||e.attr('src')||e.attr('data-lazy-src'),base),alt:clean(e.attr('alt')),width:Number(e.attr('width'))||null,height:Number(e.attr('height'))||null};}).get().filter(i=>i.url);
  const schemaImages=[].concat(product?.image||[]).map(i=>({url:absolute(typeof i==='string'?i:i?.url,base),alt:''})).filter(i=>i.url);
  const featured=meta('og:image'),images=[];
  for(const item of [...schemaImages,...(featured?[{url:absolute(featured,base),alt:''}]:[])])if(item.url&&!images.some(i=>i.url===item.url)){const match=imgs.find(i=>new URL(i.url).pathname===new URL(item.url).pathname);images.push({...item,alt:match?.alt||''});}
  const node=$('[itemprop="description"],.product__description,.product-description,.woocommerce-product-details__short-description,.product-single__description').first();
  const productDescription=clean(product?.description?plainHTML(product.description):node.text());
  const availability=offer?.availability?String(offer.availability).split('/').at(-1):null;
  const priceValue=offer?.price??offer?.lowPrice??$('meta[property="product:price:amount"]').attr('content');
  const price=priceValue!=null&&priceValue!==''&&Number.isFinite(Number(priceValue))?Number(priceValue):null;
  const name=clean(product?.name||$('[itemprop="name"]').first().text()||headings.find(h=>h.level===1)?.text||meta('og:title')||title);
  const page={id:stableId(url),url,kind:product?'product':kindOf(url),title,description,h1:headings.filter(h=>h.level===1).map(h=>h.text),headings,canonical:$('link[rel="canonical"]').map((_,el)=>absolute($(el).attr('href'),base)).get(),viewport:meta('viewport'),schemas:nodes.map(n=>n['@type']).flat().filter(Boolean),schemaErrors,productSchema:!!product,breadcrumbSchema:nodes.some(n=>typeIs(n,'BreadcrumbList')),offers:offer?{price,availability,currency:offer.priceCurrency||null}:null,images:imgs,links,bytes:response.bytes?.length??Buffer.byteLength(html),status:response.status||200,redirects:response.chain||[],fetchedAt:new Date().toISOString()};
  return {page,product:page.kind==='product'?{id:stableId(url),url,name,sku:clean(product?.sku||$('[itemprop="sku"],.sku').first().text()),category:clean(product?.category||$('.posted_in a').first().text()||$('[itemprop="category"]').first().text()),description:productDescription,price,currency:offer?.priceCurrency||meta('product:price:currency')||'',availability,images,variants:null,inspected:true,source:'public HTML / structured data',observedAt:page.fetchedAt}:null,platform:/cdn\.shopify\.com|Shopify\.|shopify-section/i.test(html)?'Shopify':/wp-content|woocommerce/i.test(html)?'WooCommerce':'HTML storefront'};
}
export function shopifyProducts(data,origin) {if(!Array.isArray(data?.products))throw new Error('Public product feed did not return a product list.');return data.products.map(p=>{const url=canonicalURL('/products/'+p.handle,origin);return {id:stableId(url),externalId:String(p.id),url,name:clean(p.title),sku:clean(p.variants?.[0]?.sku),category:clean(p.product_type),description:plainHTML(p.body_html),price:p.variants?.[0]?.price!=null?Number(p.variants[0].price):null,currency:'',availability:Array.isArray(p.variants)&&p.variants.length?p.variants.some(v=>v.available===true)?'InStock':p.variants.every(v=>v.available===false)?'OutOfStock':null:null,images:(p.images||[]).map(i=>({url:absolute(i.src,origin),alt:clean(i.alt),width:i.width,height:i.height})).filter(i=>i.url),variants:p.variants?.map(v=>({id:String(v.id),sku:v.sku,price:v.price,available:v.available})),inspected:false,source:'Shopify public product feed',observedAt:new Date().toISOString()};});}
export function parseSitemap(text,base) {const $=load(text,{xml:true});return {sitemaps:$('sitemapindex sitemap loc').map((_,el)=>absolute(clean($(el).text()),base)).get().filter(Boolean),urls:$('urlset url loc').map((_,el)=>absolute(clean($(el).text()),base)).get().filter(Boolean),valid:$('urlset,sitemapindex').length>0};}
