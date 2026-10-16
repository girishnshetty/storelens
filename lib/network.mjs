import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { dependency } from './dependencies.mjs';
const ipaddr=dependency('ipaddr.js'),robotsParser=dependency('robots-parser');

export const USER_AGENT = 'StorelensAudit/1.0 (+read-only storefront audit)';
export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function validateURL(input) {
  let u;
  try { u = new URL(input); } catch { throw new Error('Enter a complete http:// or https:// store URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new Error('Use a public HTTP(S) URL without credentials or a custom port.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes('.') && !isIP(host) || /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host) || (isIP(host) && !publicAddress(host))) throw new Error('Private, reserved and local network destinations are not permitted.');
  u.hash = '';
  return u;
}
const delay = ms => new Promise(r => setTimeout(r, ms));
export class SafeClient {
  constructor({ interval = 800, maxBytes = 5_000_000, timeout = 18000 } = {}) { this.interval = interval; this.maxBytes = maxBytes; this.timeout = timeout; this.slots = new Map(); this.robots = new Map(); this.requests = 0; }
  async slot(origin, wait = this.interval) { const time = Math.max(Date.now(), this.slots.get(origin) || 0); this.slots.set(origin, time + wait); await delay(Math.max(0, time-Date.now())); }
  async raw(input, { maxBytes = this.maxBytes, redirects = 0, chain = [], allowedOrigin, onRedirect } = {}) {
    const u = validateURL(input);
    if (allowedOrigin && u.origin !== allowedOrigin) throw new Error('Cross-origin page redirect was not followed.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{address: host, family: isIP(host)}] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Destination resolves to a private or reserved network address.');
    const chosen = addresses[0];
    await this.slot(u.origin);
    this.requests++;
    const result = await new Promise((resolve, reject) => {
      const transport = u.protocol === 'https:' ? https : http;
      let settled = false;
      const fail = e => { if (!settled) { settled = true; reject(e); } };
      const req = transport.request(u, { method:'GET', agent:false, headers:{'user-agent':USER_AGENT,'accept':'text/html,application/xml,application/json,image/*;q=0.8,*/*;q=0.5','accept-encoding':'gzip, deflate, br'}, lookup:(_hostname, options, callback) => options?.all ? callback(null,[chosen]) : callback(null,chosen.address,chosen.family) }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) { res.resume(); settled = true; resolve({ redirect: new URL(res.headers.location,u).href, status:res.statusCode }); return; }
        if (Number(res.headers['content-length']) > maxBytes) { req.destroy(); res.destroy(); fail(new Error(`Response exceeds ${maxBytes} bytes.`)); return; }
        const encoding = res.headers['content-encoding'];
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
        const stream = decoder ? res.pipe(decoder) : res;
        let size = 0, wire = 0; const chunks = [];
        res.on('data', c => { wire += c.length; if(wire > maxBytes) { res.destroy(); stream.destroy(); fail(new Error('Compressed response exceeds download limit.')); } });
        stream.on('data', c => { size += c.length; if(size > maxBytes) { res.destroy(); stream.destroy(); fail(new Error('Decoded response exceeds download limit.')); } else chunks.push(c); });
        stream.on('error', fail); res.on('error', fail);
        stream.on('end', () => { if(!settled) { settled = true; resolve({url:u.href,status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks),chain}); } });
      });
      req.setTimeout(this.timeout, () => req.destroy(new Error('Remote request timed out.')));
      const timer = setTimeout(() => req.destroy(new Error('Remote request exceeded total time limit.')), this.timeout + 2000);
      req.on('close', () => clearTimeout(timer));req.on('error', fail);req.end();
    });
    if(result.redirect) {
      if(redirects >= 4) throw new Error('Redirect limit exceeded.');
      validateURL(result.redirect);
      if(onRedirect) await onRedirect(result.redirect);
      return this.raw(result.redirect, {maxBytes,redirects:redirects+1,chain:[...chain,{url:u.href,status:result.status}],allowedOrigin,onRedirect});
    }
    return result;
  }
  async policy(origin) {
    if(this.robots.has(origin)) return this.robots.get(origin);
    const pending = (async () => {
      const r = await this.raw(origin+'/robots.txt',{maxBytes:500_000,allowedOrigin:origin});
      if(r.status===401||r.status===403||r.status===429||r.status>=500) throw new Error(`robots.txt returned HTTP ${r.status}; crawl stopped because access could not be established.`);
      const text = r.status===404||r.status===410 ? '' : r.bytes.toString('utf8');
      if(r.status!==404 && r.status!==410 && (r.status!==200 || /<html/i.test(text))) throw new Error('robots.txt is not a usable robots policy; crawl stopped.');
      const parser=robotsParser(origin+'/robots.txt',text);
      return {parser,status:r.status,text,sitemaps:parser.getSitemaps(),delay:Math.min(300000,Math.max(800,Number(parser.getCrawlDelay('StorelensAudit')||parser.getCrawlDelay('*')||0)*1000))};
    })();
    this.robots.set(origin,pending);
    return pending;
  }
  async get(input, options={}) {
    const u=validateURL(input);const policy=await this.policy(u.origin);
    if(policy.parser.isAllowed(u.href,'StorelensAudit')===false) throw new Error('Not checked: robots.txt disallows this URL.');
    // Reserve additional spacing when the site requests a crawl delay.
    if(policy.delay>this.interval) await this.slot(u.origin,policy.delay);
    const onRedirect=async target=>{const t=validateURL(target);const p=await this.policy(t.origin);if(p.parser.isAllowed(t.href,'StorelensAudit')===false)throw new Error('Redirect target disallowed by robots.txt.');};
    let r=await this.raw(u.href,{...options,onRedirect});
    if([429,502,503,504].includes(r.status)) {
      const after=Number(r.headers['retry-after']);
      if(Number.isFinite(after)&&after>10) throw new Error(`HTTP ${r.status}: Retry-After exceeds this job's retry window.`);
      await delay(Math.max(1500,Math.min(10000,(after||2)*1000)));
      r=await this.raw(u.href,{...options,onRedirect});
    }
    return {...r,text:r.bytes.toString('utf8')};
  }
}
