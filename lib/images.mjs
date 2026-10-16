import { createHash } from 'node:crypto';
import { dependency } from './dependencies.mjs';
import { stableId } from './db.mjs';
const sharp=dependency('sharp');
export async function inspectPixels(bytes) {
  const image=sharp(bytes,{limitInputPixels:20000000,animated:false,failOn:'error'});
  const metadata=await image.metadata();
  if(!['jpeg','png','webp','avif','heif','gif','tiff'].includes(metadata.format))throw new Error('Unsupported image format; vector and active formats are not decoded.');
  await image.clone().resize(128,128,{fit:'inside'}).raw().toBuffer();
  const {data}=await image.clone().flatten({background:'#fff'}).greyscale().resize(9,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
  let hash=0n;for(let y=0;y<8;y++)for(let x=0;x<8;x++)hash=(hash<<1n)|BigInt(data[y*9+x]>data[y*9+x+1]);
  const stats=await image.clone().resize(128,128,{fit:'inside'}).stats();
  return {width:metadata.width,height:metadata.height,format:metadata.format,size:bytes.length,hash:hash.toString(16).padStart(16,'0'),sha256:createHash('sha256').update(bytes).digest('hex'),blank:stats.channels.every(c=>c.stdev<1.5)};
}
export function hashDistance(a,b){let n=BigInt('0x'+a)^BigInt('0x'+b),bits=0;while(n){bits+=Number(n&1n);n>>=1n;}return bits;}
export async function auditImages({store,scan,client,check,checkpoint}) {
  const products=store.rows('products',scan.id).filter(p=>p.inspected),cache=new Map(store.rows('images',scan.id).filter(i=>i.result).map(i=>[i.url,i.result]));
  let downloaded=cache.size;
  for(const p of products) {
    checkpoint();
    check('images','primary-product-image',p,p.images.length?'Passed':'Potential Issue',`${p.images.length} product images extracted.`,{title:'Primary product image not found',severity:'high',recommendation:'Verify the rendered listing, then add an accurate primary image if it is missing.'});
    check('images','additional-views',p,p.images.length===1?'Potential Issue':'Passed',`${p.images.length} product images discovered.`,{title:'Only one product image found',severity:'low',recommendation:'Consider additional accurate views or detail photographs.'});
    for(const img of p.images.slice(0,25)) {
      checkpoint();const opts={imageUrl:img.url};
      check('images','image-alt',p,img.alt?'Passed':img.altVerified?'Confirmed Issue':'Potential Issue',`Extracted alt text: ${img.alt||'(empty or not exposed)'}`,{...opts,title:'Missing or unverified image alt text',severity:'low',current:img.alt,proposed:p.name,recommendation:'Describe the visible product accurately; verify the rendered image alt attribute.'});
      const filename=decodeURIComponent(new URL(img.url).pathname.split('/').at(-1)||'');
      const suggested=p.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'')+'.'+(filename.split('.').at(-1)||'jpg');
      check('images','filename',p,/^(img|image|dsc|photo|[0-9a-f]{18,})[-_\d.]*/i.test(filename)?'Potential Issue':'Passed',`Filename: ${filename}`,{...opts,title:'Image filename could be more descriptive',severity:'low',current:filename,proposed:suggested,recommendation:'Consider a descriptive filename when replacing an image; preserve existing URLs or redirect them.'});
      let result=cache.get(img.url);
      if(!result&&downloaded>=scan.config.maxImages) {check('images','image-decode',p,'Not Checked',`Image download budget (${scan.config.maxImages}) reached.`,{...opts,title:'Image not inspected',severity:'low',recommendation:'Increase the image budget or run a focused scan.'});continue;}
      if(!result) {
        downloaded++;scan.stage=`Inspecting image ${downloaded} of up to ${scan.config.maxImages}`;store.save(scan);
        try {const response=await client.get(img.url,{maxBytes:10000000});
          if(response.status!==200) result={status:response.status,error:`Image returned HTTP ${response.status}.`};
          else result={status:200,...await inspectPixels(response.bytes)};
        }catch(error){result={status:null,error:error.message};}
        cache.set(img.url,result);store.put('images',scan.id,{id:stableId(img.url),url:img.url,productId:p.id,result,observedAt:new Date().toISOString()});
      }
      if(result.error) {const status=[404,410].includes(result.status)?'Confirmed Issue':result.status&&![401,403,429].includes(result.status)?'Potential Issue':'Not Checked';check('images','image-decode',p,status,result.error,{...opts,title:'Image could not be loaded or decoded',severity:'high',recommendation:status==='Not Checked'?'Verify access and retry. An access failure does not prove the image is broken.':'Review the image response and replace or repair the original URL if necessary.'});continue;}
      check('images','image-decode',p,'Passed',`HTTP 200; decoded ${result.format}.`,opts);
      check('images','image-resolution',p,result.width<scan.config.minWidth||result.height<scan.config.minHeight?'Potential Issue':'Passed',`${result.width} × ${result.height}px; minimum ${scan.config.minWidth} × ${scan.config.minHeight}px.`,{...opts,title:'Image below configured resolution',severity:'medium',current:`${result.width} × ${result.height}`,recommendation:'Check the full-resolution original. Replace with a larger genuine product image if required.'});
      check('images','image-aspect-ratio',p,result.width/result.height>2.5||result.width/result.height<.4?'Potential Issue':'Passed',`Aspect ratio ${(result.width/result.height).toFixed(2)}.`,{...opts,title:'Unusual product image aspect ratio',severity:'low',recommendation:'Check how this image fits the product gallery before changing its crop.'});
      check('images','image-file-size',p,result.size>1500000?'Potential Issue':'Passed',`Downloaded image: ${result.size} bytes.`,{...opts,title:'Large product image file',severity:'medium',current:String(result.size),recommendation:'Serve responsive sizes and compress while retaining visible product detail.'});
      check('images','image-format',p,['jpeg','png','tiff'].includes(result.format)&&result.size>250000?'Potential Issue':'Passed',`Decoded format ${result.format}; ${result.size} bytes.`,{...opts,title:'Modern image format opportunity',severity:'low',recommendation:'Evaluate WebP or AVIF with visual quality checks.'});
      check('images','blank-image',p,result.blank?'Potential Issue':'Passed',`Decoded pixel-channel standard deviation ${result.blank?'below':'above'} 1.5 at inspection size.`,{...opts,title:'Image may be blank or nearly uniform',severity:'medium',recommendation:'Visually inspect the original. A uniform image is not automatically defective.',confidence:'Medium'});
      const duplicates=[...cache].filter(([url,r])=>url!==img.url&&r.hash&&hashDistance(r.hash,result.hash)<=3).slice(0,5);
      check('images','perceptual-duplicate',p,duplicates.length?'Potential Issue':'Passed',duplicates.length?`Perceptual difference ≤3 / 64 bits with: ${duplicates.map(([url])=>url).join(', ')}`:'No visually similar image among downloaded images at this point.',{...opts,title:'Potential duplicate product image',severity:'low',recommendation:'Compare these images before removing them. Shared views across variants can be intentional.',confidence:'Medium'});
    }
    scan.progress=80+Math.round(Math.min(1,downloaded/scan.config.maxImages)*10);store.save(scan);
  }
}
