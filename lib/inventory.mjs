import { dependency } from './dependencies.mjs';
const {parse}=dependency('csv-parse/sync'),JSZip=dependency('jszip'),{load}=dependency('cheerio');
const fields=['sku','name','category','stock','reserved','on_order','units_7','units_30','units_60','units_90','price','margin_percent','visits_30','orders_30','age_days'];
const numeric=fields.filter(f=>!['sku','name','category'].includes(f));
export const uploadTemplate=fields.join(',')+'\r\n';
export async function readUpload(bytes,filename){let rows;
  if(/\.csv$/i.test(filename)){rows=parse(bytes.toString('utf8'),{columns:headers=>headers.map(h=>h.replace(/^\uFEFF/,'').trim().toLowerCase()),bom:true,skip_empty_lines:true,trim:true,max_record_size:100000});}
  else if(/\.xlsx$/i.test(filename)){rows=await readXlsx(bytes);}
  else throw new Error('Only .csv and .xlsx files are supported.');
  if(!rows.length||rows.length>10000)throw new Error('Upload must contain 1–10,000 data rows.');
  const seen=new Set();return rows.map((row,index)=>{const result={};for(const key of fields){const value=String(row[key]??'').trim();if(value.length>5000)throw new Error(`Row ${index+2}: field is too long.`);if(numeric.includes(key)){if(value==='')result[key]=null;else if(!Number.isFinite(Number(value))||Number(value)<0||Number(value)>1e12)throw new Error(`Row ${index+2}: ${key} must be a nonnegative number.`);else result[key]=Number(value);}else result[key]=value;}
    if(!result.sku||seen.has(result.sku.toLowerCase()))throw new Error(`Row ${index+2}: missing or duplicate SKU.`);seen.add(result.sku.toLowerCase());
    if(result.reserved!=null&&result.stock!=null&&result.reserved>result.stock)throw new Error(`Row ${index+2}: reserved stock exceeds on-hand stock.`);
    if(result.margin_percent>100)throw new Error(`Row ${index+2}: margin_percent cannot exceed 100.`);
    if(result.orders_30!=null&&result.visits_30!=null&&result.orders_30>result.visits_30)throw new Error(`Row ${index+2}: orders exceed visits; verify the metric definitions.`);
    return result;
  });
}
async function readXlsx(bytes){const zip=await JSZip.loadAsync(bytes);const files=Object.values(zip.files);if(files.length>300||files.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0)>25000000)throw new Error('Excel archive exceeds safe unpacked size limits.');if(zip.file('xl/vbaProject.bin'))throw new Error('Macro-enabled spreadsheets are not accepted.');
  const shared=[];const strings=zip.file('xl/sharedStrings.xml');if(strings){const $=load(await strings.async('string'),{xml:true});$('si').each((_,el)=>shared.push($(el).find('t').text()));}
  const worksheet=zip.file('xl/worksheets/sheet1.xml');if(!worksheet)throw new Error('Excel upload requires data in the first worksheet.');const $=load(await worksheet.async('string'),{xml:true});const table=[];
  $('sheetData row').each((_,el)=>{const row=[];$(el).find('c').each((_,cell)=>{const c=$(cell);if(c.find('f').length)throw new Error('Upload values only: spreadsheet formulas are not evaluated.');const letters=(c.attr('r')||'A').match(/^[A-Z]+/)[0];let col=0;for(const ch of letters)col=col*26+ch.charCodeAt(0)-64;if(col>100)throw new Error('Excel sheet has too many columns.');const v=c.find('v').text();row[col-1]=c.attr('t')==='s'?shared[Number(v)]||'':c.attr('t')==='inlineStr'?c.find('is t').text():v;});if(row.some(v=>v!==''))table.push(row);});
  const headers=table.shift()?.map(h=>String(h).trim().toLowerCase())||[];return table.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??''])));
}
export function validatePlanning(input={}){const limits={leadTime:[0,365,14],targetDays:[1,365,30],safetyStock:[0,100000,5],window:[7,90,30]};const settings={};for(const [k,[min,max,fallback]]of Object.entries(limits)){const n=Number(input[k]??fallback);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid inventory setting: ${k}`);settings[k]=n;}if(![7,30,60,90].includes(settings.window))throw new Error('Sales window must be 7, 30, 60 or 90 days.');return settings;}
const round=v=>Math.round(v*100)/100;
export function analyzeInventory(rows,input){const settings=validatePlanning(input),{window,leadTime,targetDays,safetyStock}=settings;return rows.map(r=>{
  const units=r['units_'+window],daily=units==null?null:units/window;
  // stock = physical on-hand. When reserved is absent we do not assume zero.
  const stock=r.stock!=null&&r.reserved!=null?r.stock-r.reserved:null;
  const position=stock!=null&&r.on_order!=null?stock+r.on_order:null;
  const reorderPoint=daily==null?null:Math.ceil(daily*leadTime+safetyStock),target=daily==null?null:Math.ceil(daily*(leadTime+targetDays)+safetyStock);
  const reorder=target!=null&&position!=null?Math.max(0,target-position):null;
  return {sku:r.sku,name:r.name,stock,reserved:r.reserved,units,daily:daily==null?null:round(daily),cover:daily>0&&stock!=null?round(stock/daily):null,reorderPoint,target,reorder,inventoryPosition:position,classification:daily==null?'Requires sales data':daily===0?'Non-moving':daily>=1?'Fast-moving':daily<.1?'Slow-moving':'Steady',action:daily==null||stock==null||position==null?'Requires units_'+window+', stock, reserved and on_order':daily===0?'Review zero-sales inventory':stock===0?'Restore stock':stock<=reorderPoint?'Replenish inventory':reorder>0?'Plan replenishment':'Retain current stock',windowDays:window,leadTimeDays:leadTime,targetCoverageDays:targetDays,safetyStock};
  });}
export function analyzeMerchandising(rows,inventory){const output=[];const add=(r,action,evidence)=>output.push({sku:r.sku,name:r.name,category:r.category,action,evidence,source:'Authorized uploaded data'});
  const positive=rows.filter(r=>r.units_30>0).sort((a,b)=>b.units_30-a.units_30);const top=new Set(positive.slice(0,Math.max(1,Math.ceil(positive.length*.2))).map(r=>r.sku));
  for(const r of rows){const i=inventory.find(i=>i.sku===r.sku);if(top.has(r.sku)&&i?.stock>0)add(r,'Consider featuring on homepage',`${r.units_30} units sold in 30 days; top 20% of uploaded positive-sales products; ${i.stock} available.`);
    if(i?.reorder>0)add(r,'Replenish inventory',`${i.daily} units/day over ${i.windowDays} days; available ${i.stock}; target ${i.target}; suggested reorder ${i.reorder}.`);
    if(r.units_30===0&&r.stock>0)add(r,'Review slow stock',`0 units sold in 30 days; ${r.stock} on hand${r.age_days!=null?'; age '+r.age_days+' days':''}.`);
    if(r.visits_30>=100&&r.orders_30!=null){const conversion=r.orders_30/r.visits_30*100;if(conversion<1)add(r,'Review page conversion',`${r.visits_30} visits and ${r.orders_30} orders over 30 days; ${round(conversion)}% conversion. Heuristic threshold: <1%.`);}
    if(r.visits_30>0&&r.visits_30<100&&r.orders_30!=null&&r.orders_30/r.visits_30>=.03)add(r,'Test additional visibility',`${r.visits_30} visits; ${r.orders_30} orders in 30 days; ${round(r.orders_30/r.visits_30*100)}% conversion. Small samples warrant caution.`);
    if(r.margin_percent>=40&&i?.stock>0)add(r,'Review high-margin opportunity',`Uploaded gross margin ${r.margin_percent}%; ${i.stock} available. Heuristic threshold: 40%.`);
    if(r.price===0)add(r,'Review pricing','Uploaded unit price is zero. Verify whether intentionally free or quote-only.');
  }
  const categories=new Map();for(const r of rows)if(r.category&&r.price!=null&&r.units_30!=null){const c=categories.get(r.category)||{units:0,revenue:0,count:0};c.units+=r.units_30;c.revenue+=r.units_30*r.price;c.count++;categories.set(r.category,c);}
  for(const [category,c]of categories)output.push({sku:'Category aggregate',name:category,category,action:'Review category performance',evidence:`${c.units} units × uploaded prices = ${round(c.revenue)} gross revenue proxy across ${c.count} records in 30 days. Excludes discounts, returns and tax; currency must be consistent.`,source:'Authorized uploaded data'});
  return output;
}
