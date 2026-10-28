'use strict';
const CACHE='reky-offline-v5';
const BASE=new URL('./',self.location.href);
const SHELL=BASE.href;
const ASSETS=['manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'].map(p=>new URL(p,BASE).href);
async function isAppShell(response){
 return response&&response.ok&&(response.headers.get('content-type')||'').includes('text/html')&&(await response.clone().text()).includes('data-app-version="reky-v5"');
}
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const response=await fetch(SHELL,{credentials:'same-origin',cache:'reload'});
  if(!(await isAppShell(response)))throw new Error('Expected the river app, not a sign-in page.');
  const cache=await caches.open(CACHE);
  await cache.put(SHELL,response);
  await cache.addAll(ASSETS);
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(k=>k.startsWith('reky-offline-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
 })());
});
async function navigation(request){
 const cache=await caches.open(CACHE);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),2500);
 try{
  const response=await fetch(request,{signal:controller.signal});
  if(await isAppShell(response))await cache.put(SHELL,response.clone());
  // Online sign-in and access-denied responses must remain authoritative.
  return response;
 }catch{
  return await cache.match(SHELL)||new Response('Offline kopie ještě není uložená. Otevři aplikaci jednou s internetem.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
 }finally{clearTimeout(timer);}
}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==BASE.origin)return;
 if(request.mode==='navigate'&&(url.pathname===BASE.pathname||url.pathname===BASE.pathname+'index.html')){
  event.respondWith(navigation(request));return;
 }
 if(ASSETS.includes(url.href))event.respondWith((async()=>{
  const cache=await caches.open(CACHE);return await cache.match(request)||fetch(request);
 })());
});
self.addEventListener('message',event=>{
 if(event.data&&event.data.type==='OFFLINE_STATUS')event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  const response=await cache.match(SHELL);
  event.ports[0]?.postMessage({ready:!!response,version:CACHE});
 })());
});
