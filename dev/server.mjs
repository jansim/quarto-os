import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2] || '.';
const port = +process.argv[3] || 8123;
const coi = process.argv[4] !== 'nocoi';
const types = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.wasm':'application/wasm','.txt':'text/plain','.mp4':'video/mp4'};
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(root, p);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  const h = {'Content-Type': types[path.extname(f)] || 'application/octet-stream'};
  if (coi) { h['Cross-Origin-Opener-Policy']='same-origin'; h['Cross-Origin-Embedder-Policy']='require-corp'; h['Cross-Origin-Resource-Policy']='cross-origin'; }
  const st = fs.statSync(f);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range); const s=+m[1]; const e = m[2]? +m[2] : st.size-1;
    h['Content-Range'] = `bytes ${s}-${e}/${st.size}`; h['Content-Length']= e-s+1; h['Accept-Ranges']='bytes';
    res.writeHead(206, h); fs.createReadStream(f,{start:s,end:e}).pipe(res); return;
  }
  h['Content-Length'] = st.size; h['Accept-Ranges']='bytes';
  res.writeHead(200, h); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('listening', port));
