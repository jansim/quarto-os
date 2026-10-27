// A named HTTP origin is deliberately not treated as a secure localhost origin.
import assert from 'node:assert/strict';
import {chromium} from '../playwright.mjs';
const index=process.argv.indexOf('--port');
const port=index<0?'8203':process.argv[index+1];
const base=`http://quarto-os.test:${port}`;
const browser=await chromium.launch();
try {
  const context=await browser.newContext();
  // Serve owned local assets under a virtual HTTP origin. No request to the
  // .test hostname leaves the test, so DNS/proxy policy cannot mask the bug.
  await context.route(`${base}/**`,async route=>{
    const url=new URL(route.request().url());
    const response=await context.request.get(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
    await route.fulfill({response});
  });
  const page=await context.newPage();
  const cache=`qos-http-${Date.now()}`;
  const response=await page.goto(`${base}/dev/vm-test.html?suite=boot&persist=1&cache=${cache}`);
  assert.equal(response.status(),200);
  async function ready() {
    await page.waitForFunction(()=>window.__done,null,{timeout:150000});
    const state=await page.evaluate(()=>({secure:isSecureContext,subtle:typeof crypto.subtle,ready:vm.isReady,results:__results}));
    assert.equal(state.secure,false); assert.equal(state.subtle,'undefined');
    assert(state.ready,JSON.stringify(state.results));
  }
  await ready();
  await page.evaluate(async()=>{
    const result=await vm.exec('python3 -c "print(6*7)"');
    if(result.code!==0||result.output!=='42\n')throw new Error(JSON.stringify(result));
    await vm.writeFile('~/http-origin.txt','kept over HTTP');
    await vm.save();
  });
  console.log('PASS HTTP origin boots and executes Python with crypto.subtle unavailable');
  await page.reload(); await ready();
  assert.equal(await page.evaluate(()=>vm.readText('~/http-origin.txt')),'kept over HTTP');
  console.log('PASS HTTP cache identity and persistence survive reload');

  await page.goto(`${base}/dev/apps-test.html?boot=0`);
  await page.waitForFunction(()=>window.QuartoOS);
  await page.evaluate(()=>{
    QuartoOS.vm=async()=>{throw new Error('VM startup failed for this test');};
    return QuartoOS.open('terminal',{});
  });
  await page.waitForFunction(()=>document.querySelector('.qos-term')?.textContent.includes('Could not start the Linux VM'));
  const error=await page.locator('.qos-term').textContent();
  assert(error.includes('VM startup failed for this test'));
  assert(!/COOP|COEP|coi-serviceworker|cross-origin isolated/.test(error));
  console.log('PASS terminal errors omit obsolete cross-origin-isolation advice');
} finally {await browser.close();}
