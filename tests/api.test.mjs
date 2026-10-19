import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, DEMO_PASSWORD } from '../server.mjs';
let app, base;
before(async()=>{app=createApp({dbPath:':memory:'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;});
after(async()=>{await app.close();});
const request=async(route,method='GET',body,cookie='',headers={})=>{const response=await fetch(base+route,{method,headers:{...body?{'Content-Type':'application/json'}:{},Cookie:cookie,...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
const login=async(email)=> (await request('/api/login','POST',{email,password:DEMO_PASSWORD})).cookie;
const createOrder=async(cookie,quantity=1,key=crypto.randomUUID())=>request('/api/orders','POST',{quantity,idempotencyKey:key},cookie);

test('public product is readable; customer and staff routes are protected',async()=>{
  assert.equal((await request('/api/product')).status,200);
  assert.equal((await request('/api/admin')).status,401);
  const cookie=await login('collector@philately.test');
  assert.equal((await request('/api/admin','GET',null,cookie)).status,403);
  assert.equal((await request('/api/admin/product','PATCH',{total:200,price:25000,active:true},cookie)).status,403);
});
test('registration hashes passwords and produces a scoped session',async()=>{
  const reg=await request('/api/register','POST',{name:'Test Collector',email:'new@example.test',password:'OnlyForTests123!'});
  assert.equal(reg.status,200);assert.equal(reg.body.user.role,'customer');
  const row=app.db.prepare('SELECT hash FROM users WHERE email=?').get('new@example.test');assert.notEqual(row.hash,'OnlyForTests123!');
  assert.equal((await request('/api/session','GET',null,reg.cookie)).body.user.email,'new@example.test');
  const out=await request('/api/logout','POST',{},reg.cookie);assert.equal(out.status,200);
  assert.equal((await request('/api/session','GET',null,reg.cookie)).body.user,null);
});
test('idempotent checkout reserves stock once; success allocates it once',async()=>{
  const cookie=await login('collector@philately.test');const before=(await request('/api/product')).body.product;const key=crypto.randomUUID();
  const first=await createOrder(cookie,2,key);const second=await createOrder(cookie,2,key);
  assert.equal(first.body.order.id,second.body.order.id);
  assert.equal((await createOrder(cookie,1,key)).status,409);
  let product=(await request('/api/product')).body.product;assert.equal(product.available,before.available-2);assert.equal(product.held,before.held+2);
  const pay=()=>request(`/api/orders/${first.body.order.id}/simulate`,'POST',{outcome:'success'},cookie);
  const paid=await pay();assert.equal(paid.body.order.status,'confirmed');assert.ok(paid.body.order.payment_ref.startsWith('SIM-'));
  assert.equal((await pay()).body.order.payment_ref,paid.body.order.payment_ref);
  product=(await request('/api/product')).body.product;assert.equal(product.sold,before.sold+2);assert.equal(product.held,before.held);
  assert.equal((await request(`/api/orders/${first.body.order.id}/cancel`,'POST',{},cookie)).status,409);
});
test('customer cannot view or pay another customer order',async()=>{
  const a=await login('collector@philately.test');const b=await login('sample1@example.test');const order=await createOrder(a);
  const mine=await request('/api/orders','GET',null,b);assert.equal(mine.body.orders.some(x=>x.id===order.body.order.id),false);
  assert.equal((await request(`/api/orders/${order.body.order.id}/simulate`,'POST',{outcome:'success'},b)).status,404);
  await request(`/api/orders/${order.body.order.id}/cancel`,'POST',{},a);
});
test('failed and cancelled orders release stock; closed payments cannot change outcome',async()=>{
  const cookie=await login('collector@philately.test');const before=(await request('/api/product')).body.product.available;
  const o=await createOrder(cookie);const oid=o.body.order.id;
  assert.equal((await request(`/api/orders/${oid}/simulate`,'POST',{outcome:'failure'},cookie)).body.order.status,'failed');
  assert.equal((await request(`/api/orders/${oid}/simulate`,'POST',{outcome:'success'},cookie)).status,409);
  const other=(await createOrder(cookie)).body.order;await request(`/api/orders/${other.id}/cancel`,'POST',{},cookie);
  assert.equal((await request('/api/product')).body.product.available,before);
});
test('expiry releases stock and cannot subsequently confirm payment',async()=>{
  const cookie=await login('collector@philately.test');const o=(await createOrder(cookie)).body.order;
  app.db.prepare('UPDATE orders SET expires=? WHERE id=?').run(Date.now()-1,o.id);
  const response=await request(`/api/orders/${o.id}/simulate`,'POST',{outcome:'success'},cookie);
  assert.equal(response.body.order.status,'expired');
  assert.equal((await request(`/api/orders/${o.id}/simulate`,'POST',{outcome:'success'},cookie)).status,409);
});
test('inventory cannot undercut commitments; order price is immutable',async()=>{
  const staff=await login('staff@philately.test');const customer=await login('collector@philately.test');const o=(await createOrder(customer)).body.order;
  assert.equal((await request('/api/admin/product','PATCH',{total:0,price:50000,active:true},staff)).status,409);
  assert.equal((await request('/api/admin/product','PATCH',{total:150,price:50000,active:true},staff)).status,200);
  const saved=(await request('/api/orders','GET',null,customer)).body.orders.find(x=>x.id===o.id);assert.equal(saved.unit_price,o.unit_price);
  assert.equal((await request('/api/admin','GET',null,staff)).body.audit.some(x=>x.action==='inventory.updated'),true);
  await request(`/api/orders/${o.id}/cancel`,'POST',{},customer);
});
test('last unit is reserved exactly once under concurrent requests; pause blocks checkout',async()=>{
  const staff=await login('staff@philately.test');const c=await login('collector@philately.test');const d=await login('sample1@example.test');
  const current=(await request('/api/product')).body.product;
  await request('/api/admin/product','PATCH',{total:current.sold+current.held+1,price:25000,active:true},staff);
  const results=await Promise.all([createOrder(c),createOrder(d)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal((await request('/api/product')).body.product.available,0);
  const winner=results.find(r=>r.status===201).body.order;
  await request(`/api/orders/${winner.id}/cancel`,'POST',{},winner.user_id===(await request('/api/session','GET',null,c)).body.user.id?c:d);
  await request('/api/admin/product','PATCH',{total:150,price:25000,active:false},staff);
  assert.equal((await createOrder(c)).status,409);
  await request('/api/admin/product','PATCH',{total:150,price:25000,active:true},staff);
});
test('invalid quantities, cross-origin writes and non-JSON requests are rejected',async()=>{
  const cookie=await login('collector@philately.test');
  assert.equal((await createOrder(cookie,-1)).status,400);
  assert.equal((await createOrder(cookie,6)).status,400);
  assert.equal((await request('/api/logout','POST',{},cookie,{Origin:'https://evil.example'})).status,403);
  const r=await fetch(base+'/api/logout',{method:'POST',body:'{}'});assert.equal(r.status,415);
});
test('customer and staff pages serve with protective response headers',async()=>{
  for(const route of ['/','/admin','/orders','/checkout','/login']){const r=await fetch(base+route);assert.equal(r.status,200);assert.equal(r.headers.get('x-frame-options'),'DENY');assert.match(await r.text(),/Philately Passport/);}
});
