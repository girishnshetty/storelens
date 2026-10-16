import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dependency } from '../../lib/dependencies.mjs';
const {chromium}=dependency('playwright');
const base=process.env.AUDIT_TEST_URL||'http://127.0.0.1:4185';
const output=fileURLToPath(new URL('../../../output/store-audit/',import.meta.url));await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.AUDIT_BROWSER_CHANNEL||'msedge'}:{})});
const errors=[];let checks=0;
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.getByRole('heading',{name:'A clearer picture of your store.'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Store URL',exact:true}).inputValue(),'https://giheritage.com/');checks++;
 for(const [hash,title]of [['seo','SEO audit'],['images','Image audit'],['catalog','Catalog quality'],['inventory','Inventory intelligence'],['merchandising','Merchandising'],['reports','Your audit reports'],['history','Scan history'],['connections','Connect the dots.'],['settings','Workspace settings'],['products','Discovered products']]){await page.goto(base+'/#'+hash);await page.getByRole('heading',{name:title,exact:true}).first().waitFor();checks++;}
 await page.goto(base+'/#inventory');assert.match(await page.locator('.content').innerText(),/Requires Store Connection|Verified data analysis/);checks++;
 await page.goto(base+'/#seo');const search=page.getByRole('textbox',{name:'Search findings'});await search.fill('no-such-product-for-smoke');await page.getByText('No findings match your filters').waitFor();checks++;await search.fill('');
 if(await page.getByRole('button',{name:'Review →',exact:true}).count()){await page.getByRole('button',{name:'Review →',exact:true}).first().click();await page.getByRole('textbox',{name:'Recommended content'}).waitFor();await page.getByRole('button',{name:'Close dialog'}).click();checks++;}
 await page.goto(base+'/#overview');await page.screenshot({path:output+'dashboard-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.reload();await page.getByRole('button',{name:'Toggle navigation'}).click();await page.locator('.sidebar.open').waitFor();await page.locator('.sidebar').getByRole('link',{name:'Reports',exact:true}).click();await page.getByRole('heading',{name:'Your audit reports'}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks++;
 await page.goto(base+'/#overview');await page.screenshot({path:output+'dashboard-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);checks++;
 console.log(JSON.stringify({status:'passed',checks,browser:'Chromium',screenshots:[output+'dashboard-desktop.png',output+'dashboard-mobile.png']}));
}finally{await browser.close();}
