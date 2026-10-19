import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const NOW = () => Date.now();
const id = () => randomBytes(18).toString('hex');
const digest = s => createHash('sha256').update(s).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const DEMO_PASSWORD = 'PassportDemo!2026';

export function createApp({ dbPath = path.join(root, 'data', 'preview.sqlite'), seed = true } = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','staff')));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS product(id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=100), total INTEGER NOT NULL CHECK(total>=0), active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 5), unit_price INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed','cancelled','expired')), created INTEGER NOT NULL, expires INTEGER NOT NULL, paid INTEGER, payment_ref TEXT, idem TEXT NOT NULL, UNIQUE(user_id,idem));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL);`);
  const get = (sql, ...v) => db.prepare(sql).get(...v);
  const all = (sql, ...v) => db.prepare(sql).all(...v);
  const run = (sql, ...v) => db.prepare(sql).run(...v);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  function addUser(name, email, password, role = 'customer') {
    const salt = id(); const uid = id();
    run('INSERT INTO users VALUES(?,?,?,?,?,?)', uid, name, email, salt, scryptSync(password, salt, 64).toString('hex'), role);
    return uid;
  }
  if (!get('SELECT id FROM product')) run('INSERT INTO product VALUES(1,?,?,?,1)', 'Philately Passport', 25000, 150);
  if (seed && !get('SELECT id FROM users WHERE email=?', 'staff@philately.test')) {
    addUser('GPO Test Administrator', 'staff@philately.test', DEMO_PASSWORD, 'staff');
    const uid = addUser('Ananya Rao', 'collector@philately.test', DEMO_PASSWORD);
    const names = ['Meera Shah', 'Arjun Kumar', 'Kavya Rao', 'Dev Patel', 'Ishaan Roy', 'Nisha Jain'];
    names.forEach((name, i) => {
      const customer = i === 0 ? uid : addUser(name, `sample${i}@example.test`, DEMO_PASSWORD);
      const time = NOW() - (i + 1) * 14400000;
      const status = i === 4 ? 'failed' : 'confirmed';
      run('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?)', `PP-DEMO-${String(1006-i)}`, customer, i % 2 + 1, 25000, status, time, time + 600000, status === 'confirmed' ? time + 20000 : null, status === 'confirmed' ? `SIM-SEED-${i}` : null, id());
    });
  }
  const audit = (u, action, detail) => run('INSERT INTO audit(user_id,action,detail,created) VALUES(?,?,?,?)', u, action, detail, NOW());
  function expire() { run("UPDATE orders SET status='expired' WHERE status='pending' AND expires<=?", NOW()); }
  function product() {
    expire();
    const p = get('SELECT * FROM product WHERE id=1');
    const counts = get("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN quantity ELSE 0 END),0) held, COALESCE(SUM(CASE WHEN status='confirmed' THEN quantity ELSE 0 END),0) sold FROM orders");
    return { ...p, ...counts, available: p.total - counts.held - counts.sold };
  }
  function user(req) {
    const token = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('pp_session='))?.slice(11);
    if (!token || token.length !== 48) return null;
    return get('SELECT u.id,u.name,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?', digest(token), NOW()) || null;
  }
  const rates = new Map();
  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (!route.startsWith('/api/')) {
        if (req.method !== 'GET') return send(405,{error:'Method not allowed.'});
        const files = { '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/favicon.svg':['favicon.svg','image/svg+xml'] };
        const [file,type] = files[route] || ['index.html','text/html'];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control':'no-cache' }); res.end(readFileSync(path.join(root,'public',file))); return;
      }
      if (!['GET','POST','PATCH'].includes(req.method)) return send(405,{error:'Method not allowed.'});
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) fail(403, 'Request origin is not permitted.');
        if (!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON request required.');
      }
      let body = {};
      if (req.method !== 'GET') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw)>12000) fail(413,'Request too large.'); }
        try { body=JSON.parse(raw || '{}'); } catch { fail(400,'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400,'Invalid request.');
      }
      let u=user(req);
      const requireUser = () => { if (!u) fail(401,'Please sign in to continue.'); };
      const requireStaff = () => { requireUser(); if(u.role!=='staff') fail(403,'Staff access required.'); };
      if(route==='/api/health' && req.method==='GET') return send(200,{ok:true,mode:'demo',payments:'simulated'});
      if(route==='/api/session' && req.method==='GET') return send(200,{user:u});
      if(route==='/api/product' && req.method==='GET') return send(200,{product:product(),mode:'demo'});
      if(['/api/login','/api/register'].includes(route) && req.method==='POST') {
        const key=req.socket.remoteAddress || 'unknown'; const bucket=rates.get(key);
        if(bucket && bucket.until>NOW() && bucket.count>=25) fail(429,'Too many sign-in attempts. Try again in a minute.');
        rates.set(key, bucket && bucket.until>NOW() ? {...bucket,count:bucket.count+1} : {count:1,until:NOW()+60000});
        if(rates.size>5000) for(const [k,v] of rates) if(v.until<NOW()) rates.delete(k);
        const email=String(body.email||'').trim().toLowerCase(); const password=String(body.password||'');
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>160 || password.length<10 || password.length>128) fail(400,'Enter a valid email and a password of 10–128 characters.');
        if(route==='/api/register') {
          const name=String(body.name||'').trim();
          if(name.length<2 || name.length>80) fail(400,'Enter a name of 2–80 characters.');
          if(get('SELECT id FROM users WHERE email=?',email)) fail(409,'Unable to register this email. Try signing in.');
          addUser(name,email,password);
        }
        const record=get('SELECT * FROM users WHERE email=?',email);
        const candidate=scryptSync(password,record?.salt || 'dummy-salt',64);
        if(!record || !timingSafeEqual(candidate,Buffer.from(record.hash,'hex'))) fail(401,'Email or password is incorrect.');
        const token=randomBytes(24).toString('hex');
        run('DELETE FROM sessions WHERE expires<=?',NOW());
        run('INSERT INTO sessions VALUES(?,?,?)',digest(token),record.id,NOW()+28800000);
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto']==='https' || Boolean(process.env.CODESPACES);
        res.setHeader('Set-Cookie',`pp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure?'; Secure':''}`);
        return send(200,{user:{id:record.id,name:record.name,email:record.email,role:record.role}});
      }
      if(route==='/api/logout' && req.method==='POST') {
        const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pp_session='))?.slice(11);
        if(token) run('DELETE FROM sessions WHERE token=?',digest(token));
        res.setHeader('Set-Cookie','pp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return send(200,{ok:true});
      }
      if(route==='/api/orders' && req.method==='GET') { requireUser(); expire(); return send(200,{orders:all('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC',u.id)}); }
      if(route==='/api/orders' && req.method==='POST') {
        requireUser(); if(u.role!=='customer') fail(403,'Use a customer account to place a test order.');
        const q=body.quantity; const idem=String(body.idempotencyKey || '');
        if(!Number.isInteger(q)||q<1||q>5) fail(400,'Choose between 1 and 5 passports.');
        if(!/^[a-zA-Z0-9_-]{12,80}$/.test(idem)) fail(400,'A valid checkout reference is required.');
        const order=tx(()=>{
          const previous=get('SELECT * FROM orders WHERE user_id=? AND idem=?',u.id,idem);
          if(previous) { if(previous.quantity!==q) fail(409,'Checkout reference already used for a different quantity.'); return previous; }
          const p=product(); if(!p.active) fail(409,'Reservations are paused.');
          if(q>p.available) fail(409,'Not enough stock. Please select a lower quantity.');
          const held=get("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='pending'",u.id).n;
          if(held>=3) fail(409,'Complete or cancel your pending checkouts first.');
          const oid=`PP-${new Date().getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
          run('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?)',oid,u.id,q,p.price,'pending',NOW(),NOW()+600000,null,null,idem);
          audit(u.id,'order.created',oid); return get('SELECT * FROM orders WHERE id=?',oid);
        }); return send(201,{order});
      }
      const match=route.match(/^\/api\/orders\/([A-Z0-9-]+)\/(simulate|cancel)$/);
      if(match && req.method==='POST') {
        requireUser(); const [,oid,action]=match;
        const order=tx(()=>{
          const o=get('SELECT * FROM orders WHERE id=? AND user_id=?',oid,u.id);
          if(!o) fail(404,'Order not found.');
          if(action==='cancel') {
            if(o.status==='cancelled') return o;
            if(o.status!=='pending') fail(409,'Only pending checkouts can be cancelled in this test.');
            run("UPDATE orders SET status='cancelled' WHERE id=?",oid);
          } else {
            if(!['success','failure'].includes(body.outcome)) fail(400,'Choose a simulated payment outcome.');
            const target=body.outcome==='success'?'confirmed':'failed';
            if(o.status===target) return o;
            if(o.status!=='pending') fail(409,'This checkout is already closed.');
            if(o.expires<=NOW()) {
              run("UPDATE orders SET status='expired' WHERE id=?",oid);
            } else run('UPDATE orders SET status=?,paid=?,payment_ref=? WHERE id=?',target,target==='confirmed'?NOW():null,target==='confirmed'?`SIM-${id().slice(0,12).toUpperCase()}`:null,oid);
          }
          audit(u.id,`order.${action}`,oid); return get('SELECT * FROM orders WHERE id=?',oid);
        }); return send(200,{order});
      }
      if(route==='/api/admin' && req.method==='GET') {
        requireStaff(); const p=product();
        return send(200,{product:p,orders:all('SELECT o.*,u.name,u.email FROM orders o JOIN users u ON o.user_id=u.id ORDER BY o.created DESC'),audit:all('SELECT * FROM audit ORDER BY id DESC LIMIT 40')});
      }
      if(route==='/api/admin/product' && req.method==='PATCH') {
        requireStaff();
        const {total,price,active}=body;
        if(!Number.isInteger(total)||total<0||total>1000000||!Number.isInteger(price)||price<100||price>10000000||typeof active!=='boolean') fail(400,'Enter valid stock, price and reservation settings.');
        const p=tx(()=>{ const current=product(); if(total<current.sold+current.held) fail(409,'Stock cannot be lower than confirmed and held quantities.'); run('UPDATE product SET total=?,price=?,active=? WHERE id=1',total,price,active?1:0); audit(u.id,'inventory.updated',JSON.stringify(body)); return product(); });
        return send(200,{product:p});
      }
      send(404,{error:'Not found.'});
    } catch(e) { if(!e.status) console.error('Request failed:',e.message); send(e.status||500,{error:e.status?e.message:'The server could not complete this request. Please retry.'}); }
  }
  const server=http.createServer(handler);
  server.requestTimeout=15000;
  return {server,db,close:()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}))};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp(); const port=Number(process.env.PORT || 3000);
  app.server.listen(port,'0.0.0.0',()=>console.log(`Philately Passport TEST SITE: http://localhost:${port} — simulated payments only`));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>app.server.close(()=>{app.db.close();process.exit(0);}));
}
