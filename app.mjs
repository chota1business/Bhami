import React, {useEffect, useState, useRef} from 'https://esm.sh/react@19.1.1';
import {createRoot} from 'https://esm.sh/react-dom@19.1.1/client?deps=react@19.1.1';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.95.3';
import {url, publishableKey} from './config.mjs';

const h = React.createElement;
const db = createClient(url, publishableKey, {auth:{flowType:'implicit'}});
const money = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'});
const fmt = value => money.format(Number(value));
const number = value => Number(value).toLocaleString('en-IN',{maximumFractionDigits:6});
const names = {
  Overview:'Overview', suppliers:'Suppliers', purchases:'Purchases', material_lots:'Fabric & lace',
  products:'Products', production_batches:'Production', customers:'Customers', sales_orders:'Sales', media_assets:'Files',
};
const fields = {
  suppliers:[['name','Supplier name'],['phone','Phone','tel',false],['notes','Notes','text',false]],
  purchases:[['supplier_id','Supplier','suppliers',false],['purchased_on','Purchase date','date',false],['invoice_number','Invoice number','text',false],['shipping_cost','Shipping cost','money',false],['notes','Notes','text',false]],
  material_lots:[['name','Lot name'],['material_type','Material',['fabric','lace','embellishment']],['purchase_id','Purchase','purchases',false],['quantity_purchased','Quantity received','amount'],['unit','Unit',['metre','piece','roll']],['unit_cost','Cost per unit','money']],
  products:[['name','Product name'],['sku','SKU'],['category','Category',['saree','dress']],['source','Source',['ready_made','in_house','external']],['size','Size','text',false],['cost_price','Unit cost','money'],['selling_price','Selling price','money']],
  customers:[['name','Customer name'],['phone','Phone','tel',false],['email','Email','email',false]],
};
const tables = [...Object.keys(names).filter(key => key !== 'Overview'),'inventory_movements','material_usage','sales_items'];
const label = (row, table) => row?.name || (table==='purchases' ? row?.invoice_number || row?.purchased_on : null) || '—';
const redirect = () => new URL('./',window.location.href).href;
const checked = ({data,error}) => {if(error) throw error; return data;};
const errText = error => error?.message || 'Something went wrong. Please try again.';
const display = value => String(value).replaceAll('_',' ');

async function readAll(table, tenant) {
  const rows = [];
  for(let start=0;;start+=500) {
    const page = checked(await db.from(table).select('*').eq('business_id',tenant).order('id').range(start,start+499));
    rows.push(...page);
    if(page.length < 500) return rows;
  }
}
function Workspace({session}){
  const [memberships,setMemberships]=useState(null);
  const [tenant,setTenant]=useState('');
  const [data,setData]=useState(null);
  const [page,setPage]=useState('Overview');
  const [record,setRecord]=useState(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(null);
  const [photo,setPhoto]=useState(null);
  const [revision,setRevision]=useState(0);
  const [pendingStock,setPendingStock]=useState(null);
  const active=useRef(false);

  useEffect(()=>{
    let live=true;
    db.from('memberships').select('role,business_id,businesses(name)').eq('user_id',session.user.id)
      .then(result=>{const rows=checked(result);if(live){setMemberships(rows);setTenant(rows[0]?.business_id||'');}})
      .catch(error=>{if(live)setNotice({error:true,text:errText(error)});});
    return ()=>{live=false;};
  },[session.user.id]);
  const membership=memberships?.find(row=>row.business_id===tenant);
  const canOperate=['owner','partner'].includes(membership?.role);
  const pendingKey='stock-v1:'+session.user.id+':'+tenant;
  useEffect(()=>{
    if(!canOperate) return;
    try {setPendingStock(JSON.parse(sessionStorage.getItem(pendingKey)||'null'));}
    catch {setPendingStock(null);}
  },[pendingKey,canOperate]);
  useEffect(()=>{
    if(!tenant||!canOperate) return;
    let live=true;
    Promise.all(tables.map(async table=>[table,await readAll(table,tenant)]))
      .then(entries=>{if(live)setData({tenant,...Object.fromEntries(entries)});})
      .catch(error=>{if(live)setNotice({error:true,text:errText(error)});});
    return ()=>{live=false;};
  },[tenant,canOperate,revision]);
  useEffect(()=>{
    if(!photo?.local) return;
    return ()=>URL.revokeObjectURL(photo.url);
  },[photo]);

  const run=async (fn,ok,done,reload=true)=>{
    if(active.current) return;
    active.current=true;setBusy(true);setNotice(null);
    try{
      await fn();
      if(reload) setRevision(value=>value+1);
      if(ok) setNotice({text:ok});
      done?.();
    }catch(error){setNotice({error:true,text:errText(error)});}
    finally{active.current=false;setBusy(false);}
  };

  const save=(table,payload,id,done)=>run(async()=>{
    const query=id?db.from(table).update(payload).eq('business_id',tenant).eq('id',id):db.from(table).insert({business_id:tenant,...payload});
    checked(await query.select('id').single());
  },'Record saved.',done);

  const post=(payload,done)=>run(async()=>{
    const stored=JSON.parse(sessionStorage.getItem(pendingKey)||'null');
    if(stored && JSON.stringify(stored.payload)!==JSON.stringify(payload)) {
      throw new Error('Retry the previous stock request before posting another transaction.');
    }
    const request=stored||{tenant,requestId:crypto.randomUUID(),payload};
    sessionStorage.setItem(pendingKey,JSON.stringify(request));
    setPendingStock(request);
    const result=await db.rpc('post_stock',{tenant,request_id:request.requestId,...payload});
    if(!result.error||/^[0-9A-Z]{5}$/.test(result.error.code||'')) {
      sessionStorage.removeItem(pendingKey);
      setPendingStock(null);
    }
    checked(result);
  },'Stock posted.',done);

  const upload=(bucket,column,id,file,done)=>run(async()=>{
    const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
    if(!file?.size||file.size>10*1024*1024||!buckets[bucket][3].split(',').includes(file.type)) {
      throw new Error('Choose a supported image or PDF under 10 MB.');
    }
    const path=tenant+'/'+crypto.randomUUID()+'.'+extensions[file.type];
    checked(await db.storage.from(bucket).upload(path,file,{contentType:file.type,upsert:false}));
    const result=await db.from('media_assets').insert({business_id:tenant,bucket,object_path:path,[column]:id});
    if(result.error && /^[0-9A-Z]{5}$/.test(result.error.code||'')) {
      const cleanup=await db.storage.from(bucket).remove([path]);
      if(cleanup.error) throw new Error('The file uploaded but could not be linked or removed. File reference '+path);
    }
    checked(result);
  },'Private file uploaded.',done);

  const preview=asset=>run(async()=>{
    const blob=checked(await db.storage.from(asset.bucket).download(asset.object_path));
    const image=/\.(jpg|png|webp)$/.test(asset.object_path);
    if(image && ['image/jpeg','image/png','image/webp'].includes(blob.type)){
      setPhoto({url:URL.createObjectURL(blob),local:true,name:buckets[asset.bucket][0]});
      return;
    }
    const link=document.createElement('a');
    const path=URL.createObjectURL(new Blob([blob],{type:'application/octet-stream'}));
    link.href=path;
    link.download=asset.object_path.split('/').at(-1);
    link.click();
    setTimeout(()=>URL.revokeObjectURL(path),30000);
  },null,null,false);

  const balances=new Map();
  if(data?.tenant===tenant){
    for(const lot of data.material_lots) balances.set(lot.id,Number(lot.quantity_purchased));
    for(const movement of data.inventory_movements){
      const item=movement.product_id||movement.material_lot_id;
      balances.set(item,(balances.get(item)||0)+Number(movement.quantity_delta));
    }
  }
  const move=next=>{setRecord(null);setPhoto(null);setPage(next);setNotice(null);};
  let content=null;
  if(memberships && !membership) content=h('div',{className:'card'},'Your account has no business membership. Ask the business owner to add you.');
  else if(membership && !canOperate) content=h('div',{className:'card'},'Your staff membership is active. This account has access to its membership and business details.');
  else if(data?.tenant===tenant) content=viewPage({page,data,balances,save,post,busy,record,setRecord,upload,preview,photo,setPhoto,move});
  else content=h('p',{role:'status'},'Loading business records…');

  return h('div',{className:'layout'},h('aside',null,
    h('div',{className:'brand'},'Saree & Dress',h('small',null,'Inventory & sales')),
    h('nav',{'aria-label':'Workspace'},...Object.entries(names).filter(([key])=>canOperate||key==='Overview').map(([key,title])=>
      h('button',{key,disabled:busy,'aria-current':page===key?'page':undefined,onClick:()=>move(key)},title))),
    ),h('main',null,h('header',null,h('div',null,
      h('p',{className:'eyebrow muted'},membership?.businesses?.name||'Business workspace'),
      h('h1',null,names[page]||page),
      membership&&h('p',{className:'muted'},display(membership.role))),
    h('div',{className:'inline'},memberships?.length>1&&h('label',null,'Business',h('select',{value:tenant,disabled:busy,onChange:e=>{move('Overview');setTenant(e.target.value);}},
      ...memberships.map(row=>h('option',{key:row.business_id,value:row.business_id},row.businesses?.name||row.business_id)))),
    h('button',{className:'secondary',disabled:busy,onClick:()=>run(async()=>checked(await db.auth.signOut()),null,null,false)},'Sign out'))),
    notice&&h('p',{className:'notice'+(notice.error?' error':''),role:notice.error?'alert':'status'},notice.text),
    canOperate&&pendingStock?.tenant===tenant&&h('div',{className:'notice inline'},
      h('span',null,'A stock request is pending.'),
      h('button',{disabled:busy,onClick:()=>post(pendingStock.payload)},'Retry pending request')),
    content));
}

function viewPage({page,data,balances,save,post,busy,record,setRecord,upload,preview,photo,setPhoto,move}){
  const get=(table,id)=>data[table].find(row=>row.id===id);
  const ledgerBalance=row=>number(balances.get(row.id)||0);
  const listed=(table,cols,render,edit=false)=>h('section',{className:'card'},h('h2',null,names[table]),
    h(Grid,{columns:edit?[...cols,'Actions']:cols,rows:[...(data[table]||[])].sort((a,b)=>String(b.created_at||b.purchased_on||'').localeCompare(String(a.created_at||a.purchased_on||''))).map(row=>({
      id:row.id,cells:[...render(row),...(edit?[h('button',{className:'secondary',disabled:busy,onClick:()=>setRecord(row)},'Edit')]:[])],
    }))}));
  const currency=(rows,col)=>fmt(rows.reduce((sum,row)=>sum+Number(row.quantity)*Number(row[col]),0));
  const stocked=data.products.filter(row=>(balances.get(row.id)||0)>0).length;
  const sales=data.sales_orders.filter(row=>row.status==='fulfilled').length;
  if(page==='Overview') return h(React.Fragment,null,
    h('div',{className:'metrics'},...[[data.material_lots.length,'Material lots'],[stocked,'Products in stock'],[data.production_batches.length,'Production batches'],[sales,'Fulfilled sales']].map(([value,title])=>
      h('div',{key:title,className:'card metric'},h('strong',null,value),title))),
    h('section',{className:'card'},h('h2',null,'Quick actions'),h('div',{className:'inline'},
      ...[['material_lots','Receive fabric or lace'],['production_batches','Complete production'],['sales_orders','Record a sale']].map(([key,title])=>
        h('button',{key,disabled:busy,onClick:()=>move(key)},title)))));
  const editor=fields[page]&&h(Editor,{key:page,table:page,record,data,save,close:()=>setRecord(null),busy});
  switch(page){
    case 'suppliers': return h(React.Fragment,null,editor,listed(page,['Name','Phone','Notes'],row=>[row.name,row.phone||'—',row.notes||'—'],true));
    case 'customers': return h(React.Fragment,null,editor,listed(page,['Name','Phone','Email'],row=>[row.name,row.phone||'—',row.email||'—'],true));
    case 'purchases': return h(React.Fragment,null,editor,listed(page,['Date','Supplier','Invoice','Shipping'],row=>[row.purchased_on,label(get('suppliers',row.supplier_id),'suppliers'),row.invoice_number||'—',fmt(row.shipping_cost)],true));
    case 'material_lots': return h(React.Fragment,null,editor,listed(page,['Lot','Material','Received','Available','Unit cost'],row=>[row.name,display(row.material_type),number(row.quantity_purchased)+' '+row.unit,ledgerBalance(row)+' '+row.unit,fmt(row.unit_cost)],true));
    case 'products': return h(React.Fragment,null,editor,h(StockForm,{key:page,mode:'receive_product',data,balances,post,busy}),
      listed(page,['SKU','Name','Category','Available','Unit cost','Selling price'],row=>[row.sku,row.name,display(row.category),ledgerBalance(row),fmt(row.cost_price),fmt(row.selling_price)],true));
    case 'production_batches': return h(React.Fragment,null,h(StockForm,{key:page,mode:'complete_production',data,balances,post,busy}),
      listed(page,['Date','Product','Quantity','Total cost','Cost per unit','Status'],row=>{
        const used=data.material_usage.filter(item=>item.batch_id===row.id);
        const total=used.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.unit_cost_snapshot),Number(row.tailoring_cost)+Number(row.other_cost));
        return [new Date(row.created_at).toLocaleDateString('en-IN'),label(get('products',row.product_id),'products'),number(row.quantity),fmt(total),fmt(total/Number(row.quantity)),display(row.status)];
      }));
    case 'sales_orders': return h(React.Fragment,null,h(StockForm,{key:page,mode:'fulfill_sale',data,balances,post,busy}),
      listed(page,['Date','Channel','Customer','Items','Total','Status'],row=>{
        const items=data.sales_items.filter(item=>item.order_id===row.id);
        return [new Date(row.created_at).toLocaleDateString('en-IN'),display(row.channel),label(get('customers',row.customer_id),'customers'),
          items.map(item=>number(item.quantity)+' × '+label(get('products',item.product_id),'products')).join(', '),currency(items,'unit_price'),display(row.status)];
      }));
    case 'media_assets': return h(React.Fragment,null,h(FileForm,{data,upload,busy}),
      listed(page,['Category','Linked record','Added','File'],row=>{
        const [title,table,column]=buckets[row.bucket];
        return [title,label(get(table,row[column]),table),new Date(row.created_at).toLocaleDateString('en-IN'),
          h('button',{className:'secondary',disabled:busy,onClick:()=>preview(row)},'Open file')];
      }),photo&&h('section',{className:'card'},h('div',{className:'asset'},h('strong',null,photo.name),h('button',{className:'secondary',onClick:()=>setPhoto(null)},'Close preview')),
      h('img',{className:'photo',src:photo.url,alt:photo.name})));
    default:return null;
  }
}

function App(){
  const [session,setSession]=useState(undefined);
  const [notice,setNotice]=useState(null);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let live=true;
    const hash=new URLSearchParams(location.hash.slice(1));
    if(hash.has('error_description')){
      setNotice({error:true,text:hash.get('error_description')});
      history.replaceState(null,'',redirect());
    }
    const {data:{subscription}}=db.auth.onAuthStateChange((_event,next)=>{if(live)setSession(next);});
    db.auth.getSession().then(result=>{if(live && result.error){setNotice({error:true,text:errText(result.error)});setSession(null);}});
    return ()=>{live=false;subscription.unsubscribe();};
  },[]);
  if(session===undefined) return h('main',{className:'loading',role:'status'},'Opening your workspace…');
  if(session) return h(Workspace,{session,key:session.user.id});
  return h('main',{className:'gate'},h('p',{className:'eyebrow muted'},'Business workspace'),
    h('h1',null,'Saree & Dress Management'),
    h('section',{className:'card'},h('h2',null,'Sign in'),h('p',{className:'muted'},'We’ll email a sign-in link to your registered address.'),
      h('form',{onSubmit:async event=>{
        event.preventDefault();if(busy)return;
        const email=String(new FormData(event.currentTarget).get('email')).trim();
        setBusy(true);setNotice(null);
        try{
          checked(await db.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:redirect()}}));
          setNotice({text:'Check your inbox for the sign-in link.'});
        }catch(error){setNotice({error:true,text:errText(error)});}
        finally{setBusy(false);}
      }},h('label',null,'Email address',h('input',{name:'email',required:true,type:'email',autoComplete:'email',disabled:busy})),
        h('button',{disabled:busy},busy?'Sending…':'Email me a sign-in link')),
      notice&&h('p',{className:'notice '+(notice.error?'error':''),role:notice.error?'alert':'status'},notice.text)));
}


function Field({spec, data={}, record={}, disabled=false}){
  const [key,title,type='text',required=true] = spec;
  const startingValue = record[key] ?? '';
  const selection = Array.isArray(type) ? type.map(value=>[value,display(value)])
    : Array.isArray(data[type]) ? data[type].map(row=>[row.id,label(row,type)]) : null;
  const control = selection ? h('select',{name:key,required,defaultValue:startingValue,disabled},
    h('option',{value:''}, required ? 'Choose…' : 'None'),...selection.map(([value,text])=>h('option',{key:value,value},text)))
    : h('input',{name:key,required,defaultValue:startingValue,disabled,type:['money','amount'].includes(type)?'number':type,
      ...(['money','amount'].includes(type)?{min:0,step:'any'}:{})});
  return h('label',null,title,control);
}

function Grid({columns,rows}){
  return rows.length ? h('div',{className:'table-wrap'},h('table',null,
    h('thead',null,h('tr',null,...columns.map(col=>h('th',{key:col,scope:'col'},col)))),
    h('tbody',null,...rows.map(({id,cells})=>h('tr',{key:id},...cells.map((cell,index)=>h('td',{key:index},cell)))))))
    : h('p',{className:'muted'},'No records yet.');
}

function Editor({table,data,save,record,close,busy}){
  const specs = fields[table].filter(spec=>!record || spec[0]!=='quantity_purchased');
  return h('section',{className:'card'},h('h2',null,record?'Edit record':'Add record'),
    h('form',{key:record?.id||'new',onSubmit:event=>{
      event.preventDefault();
      const form=event.currentTarget, values=new FormData(form);
      const payload=Object.fromEntries(specs.flatMap(([key,,type])=>{
        const value=String(values.get(key)||'').trim();
        if(!value && !record) return [];
        return [[key,value ? ['money','amount'].includes(type)?Number(value):value : key==='shipping_cost'?0:key==='purchased_on'?record.purchased_on:null]];
      }));
      save(table,payload,record?.id,()=>{form.reset();close();});
    }},h('div',{className:'form-grid'},...specs.map(spec=>h(Field,{key:spec[0],spec,data,record:record||{}}))),
    h('div',{className:'form-footer'},h('button',{disabled:busy},record?'Save changes':'Add record'),
      record && h('button',{type:'button',className:'secondary',onClick:close},'Cancel'))));
}

function StockForm({mode,data,balances,post,busy}){
  const [lines,setLines]=useState([{key:0,id:'',quantity:''}]);
  const [output,setOutput]=useState('');
  const [units,setUnits]=useState('');
  const [tailoring,setTailoring]=useState('');
  const [other,setOther]=useState('');
  const next=useRef(1);
  const production=mode==='complete_production', sale=mode==='fulfill_sale', receipt=mode==='receive_product';
  const choices=production?data.material_lots:data.products;
  const estimates=lines.reduce((sum,line)=>{
    const row=choices.find(x=>x.id===line.id);
    return sum+Number(line.quantity||0)*Number(row?.[production?'unit_cost':'selling_price']||0);
  },0);
  const estimate=estimates+Number(tailoring||0)+Number(other||0);
  const change=(key,patch)=>setLines(old=>old.map(line=>line.key===key?{...line,...patch}:line));
  return h('section',{className:'card'},h('h2',null,production?'Complete a batch':sale?'Record a fulfilled sale':'Receive finished stock'),
    h('form',{onSubmit:event=>{
      event.preventDefault();
      const form=event.currentTarget, values=new FormData(form);
      const items=lines.map(({id,quantity})=>({id,quantity:Number(quantity)}));
      const details=production?{materials:items,tailoring_cost:Number(tailoring||0),other_cost:Number(other||0)}:sale?{items,channel:values.get('channel'),customer_id:values.get('customer_id')||null}:{};
      post({operation:mode,item_id:sale?null:output,units:sale?null:Number(units),details},()=>{
        form.reset(); setOutput('');setUnits('');setTailoring('');setOther('');setLines([{key:0,id:'',quantity:''}]);
      });
    }},
    h('div',{className:'form-grid'},
      !sale&&h('label',null,'Product',h('select',{required:true,value:output,onChange:e=>setOutput(e.target.value)},
        h('option',{value:''},'Choose…'),...data.products.map(row=>h('option',{value:row.id,key:row.id},row.sku+' · '+row.name)))),
      !sale&&h('label',null,'Finished quantity',h('input',{type:'number',min:'0.000001',step:'any',required:true,value:units,onChange:e=>setUnits(e.target.value)})),
      production&&h('label',null,'Tailoring cost',h('input',{type:'number',min:0,step:'any',value:tailoring,onChange:e=>setTailoring(e.target.value)})),
      production&&h('label',null,'Other batch costs',h('input',{type:'number',min:0,step:'any',value:other,onChange:e=>setOther(e.target.value)})),
      sale&&h(Field,{spec:['channel','Sales channel',['direct','whatsapp','exhibition','online']]}),
      sale&&h(Field,{spec:['customer_id','Customer','customers',false],data})),
    !receipt&&h('fieldset',null,h('legend',null,production?'Materials used':'Products sold'),
      ...lines.map(line=>h('div',{className:'line',key:line.key},
        h('label',null,production?'Material lot':'Product',h('select',{required:true,value:line.id,onChange:e=>change(line.key,{id:e.target.value})},
          h('option',{value:''},'Choose…'),...choices.map(row=>h('option',{value:row.id,key:row.id},row.name+' · '+number(balances.get(row.id)||0)+' available')))),
        h('label',null,'Quantity',h('input',{type:'number',min:'0.000001',step:'any',required:true,value:line.quantity,onChange:e=>change(line.key,{quantity:e.target.value})})),
        h('button',{type:'button',className:'secondary',disabled:lines.length===1,onClick:()=>setLines(old=>old.filter(x=>x.key!==line.key))},'Remove'))),
      h('button',{type:'button',className:'secondary',onClick:()=>{const key=next.current++;setLines(old=>[...old,{key,id:'',quantity:''}]);}},'Add line')),
    h('div',{className:'form-footer'},h('button',{disabled:busy},production?'Complete batch':sale?'Record sale':'Receive stock'),
      !receipt&&h('span',null,(production?'Estimated batch cost ':'Estimated sale total ')+fmt(estimate),
        production&&Number(units)>0?' · '+fmt(estimate/Number(units))+' per unit':''))));
}

const buckets={
  'fabric-images':['Fabric photos','material_lots','material_lot_id','image/jpeg,image/png,image/webp'],
  'lace-images':['Lace photos','material_lots','material_lot_id','image/jpeg,image/png,image/webp'],
  'product-images':['Product photos','products','product_id','image/jpeg,image/png,image/webp'],
  'purchase-documents':['Purchase documents','purchases','purchase_id','application/pdf,image/jpeg,image/png,image/webp'],
};
function FileForm({data,upload,busy}){
  const [bucket,setBucket]=useState('fabric-images');
  const [,table,column,types]=buckets[bucket];
  const options=table==='material_lots'?{...data,material_lots:data.material_lots.filter(row=>row.material_type===(bucket==='fabric-images'?'fabric':'lace'))}:data;
  return h('section',{className:'card'},h('h2',null,'Upload a private file'),h('form',{onSubmit:event=>{
    event.preventDefault();
    const form=event.currentTarget, values=new FormData(form);
    upload(bucket,column,values.get(column),values.get('file'),()=>form.reset());
  }},h('div',{className:'form-grid'},h('label',null,'File category',h('select',{value:bucket,onChange:e=>setBucket(e.target.value)},
    ...Object.entries(buckets).map(([value,[title]])=>h('option',{value,key:value},title)))),
    h(Field,{key:bucket,spec:[column,'Linked record',table],data:options}),
    h('label',null,'File (up to 10 MB)',h('input',{type:'file',name:'file',required:true,accept:types}))),
    h('div',{className:'form-footer'},h('button',{disabled:busy},'Upload'))));
}

createRoot(document.getElementById('root')).render(h(App));

