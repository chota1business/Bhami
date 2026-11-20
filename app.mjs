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
  products:[['name','Product name'],['sku','SKU','text',false],['category','Category',['saree','dress']],['source','Source',['ready_made','in_house','external']],['size','Size','text',false],['cost_price','Unit cost','money'],['selling_price','Selling price','money']],
  customers:[['name','Customer name'],['phone','Phone','tel',false],['email','Email','email',false]],
};
const recordLabels={
  suppliers:'supplier',purchases:'purchase',material_lots:'material lot',products:'product',
  customers:'customer',production_batches:'production batch',sales_orders:'sale',media_assets:'file',
};
const postedTables=['production_batches','sales_orders'];
const tables = [...Object.keys(names).filter(key => key !== 'Overview'),'inventory_movements','material_usage','sales_items'];
const label = (row, table) => row?.name || (table==='purchases' ? row?.invoice_number || row?.purchased_on : null) || '—';
const redirect = () => new URL('./',window.location.href).href;
const checked = ({data,error}) => {if(error) throw error; return data;};
const errText = error => error?.message || 'Something went wrong. Please try again.';
const display = value => String(value).replaceAll('_',' ');
const unitLabels={metre:'Metres',piece:'Pieces',roll:'Rolls'};

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
  const [search,setSearch]=useState('');
  const [invoiceId,setInvoiceId]=useState(null);
  const [deletion,setDeletion]=useState(null);
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
    if(table==='products'&&!id){
      const {opening_quantity=0,...product}=payload;
      const storageKey='opening-stock:'+session.user.id+':'+tenant;
      const signature=JSON.stringify([product,opening_quantity]);
      const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');
      if(saved&&saved.signature!==signature)throw new Error('The previous product save has an unknown result. Retry it with the original values first.');
      const requestId=saved?.requestId||crypto.randomUUID();
      sessionStorage.setItem(storageKey,JSON.stringify({signature,requestId}));
      const result=await db.rpc('create_product_with_opening_stock',{tenant,request_id:requestId,product,opening_quantity});
      if(!result.error||/^[0-9A-Z]{5}$/.test(result.error.code||''))sessionStorage.removeItem(storageKey);
      checked(result);
      return;
    }
    if(table==='products'&&id){
      const {stock_quantity,unit,...product}=payload;
      checked(await db.rpc('edit_product_inventory',{
        tenant,item_id:id,product,
        previous_quantity:record.stock_quantity,previous_unit:record.unit||'piece',
        new_quantity:stock_quantity,new_unit:unit,
      }));
      return;
    }
    const query=id?db.from(table).update(payload).eq('business_id',tenant).eq('id',id):db.from(table).insert({business_id:tenant,...payload});
    checked(await query.select('id').single());
  },'Record saved.',done);

  const restoreProduct=row=>run(async()=>{
    checked(await db.rpc('remove_or_restore_product',{tenant,item_id:row.id,restore:true}));
  },'Product restored to the active list.');

  const remove=({table,row})=>{
    if(table==='products'){
      run(async()=>{
        const outcome=checked(await db.rpc('remove_or_restore_product',{tenant,item_id:row.id,restore:false}));
        setNotice({text:outcome==='archived'?'Product moved to Archived products. Its history is preserved.':'Product deleted.'});
      },null,()=>{if(record?.id===row.id)setRecord(null);setPhoto(null);});
      return;
    }
    run(async()=>{
    if(membership?.role!=='owner')throw new Error('Only the business owner can delete entries.');
    if(table==='media_assets'){
      const asset=checked(await db.from(table).select('bucket,object_path').eq('business_id',tenant).eq('id',row.id).single());
      checked(await db.storage.from(asset.bucket).remove([asset.object_path]));
    }
    const result=await db.from(table).delete().eq('business_id',tenant).eq('id',row.id).select('id').maybeSingle();
    if(result.error?.code==='23503')throw new Error('This entry is linked to other records. Remove eligible linked entries first.');
    if(!checked(result))throw new Error('This entry is no longer available for deletion.');
  },'Entry deleted.',()=>{
    if(record?.id===row.id)setRecord(null);
    setPhoto(null);
    });
  };

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
    if(payload.operation==='fulfill_sale'){
      setPage('sales_orders');
      setInvoiceId(request.requestId);
    }
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

  const preview=(asset,caption=buckets[asset.bucket][0])=>run(async()=>{
    const blob=checked(await db.storage.from(asset.bucket).download(asset.object_path));
    const image=/\.(jpg|png|webp)$/.test(asset.object_path);
    if(image && ['image/jpeg','image/png','image/webp'].includes(blob.type)){
      setPhoto({url:URL.createObjectURL(blob),local:true,name:caption});
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
  const move=next=>{setRecord(null);setPhoto(null);setSearch('');setInvoiceId(null);setPage(next);setNotice(null);};
  const requestDelete=(table,row)=>setDeletion({table,row,step:1});
  let content=null;
  if(memberships && !membership) content=h('div',{className:'card'},'Your account has no business membership. Ask the business owner to add you.');
  else if(membership && !canOperate) content=h('div',{className:'card'},'Your staff membership is active. This account has access to its membership and business details.');
  else if(data?.tenant===tenant) content=viewPage({page,data,balances,save,post,busy,record,setRecord,upload,preview,photo,setPhoto,move,search,setSearch,invoiceId,setInvoiceId,businessName:membership.businesses?.name,restoreProduct,requestDelete:membership?.role==='owner'?requestDelete:null});
  else content=h('p',{role:'status'},'Loading business records…');

  return h('div',{className:'layout'},h('aside',null,
    h('div',{className:'brand'},'Bhami',h('small',null,'Inventory & sales')),
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
    content,
    deletion&&h(DeleteDialog,{deletion,setDeletion,remove}),
    membership&&page==='Overview'&&h('details',{className:'card'},h('summary',null,'Set or change password'),
      h('form',{onSubmit:event=>{
        event.preventDefault();
        const form=event.currentTarget;
        const values=new FormData(form);
        const password=String(values.get('password'));
        run(async()=>{
          if(password!==values.get('confirmation'))throw new Error('Passwords must match.');
          checked(await db.auth.updateUser({password}));
        },'Password saved. Use it for your next sign-in.',()=>form.reset(),false);
      }},
      h('div',{className:'form-grid'},
        h('label',null,'New password',h('input',{name:'password',type:'password',autoComplete:'new-password',required:true,minLength:12,disabled:busy})),
        h('label',null,'Confirm password',h('input',{name:'confirmation',type:'password',autoComplete:'new-password',required:true,minLength:12,disabled:busy}))),
      h('div',{className:'form-footer'},h('button',{disabled:busy},'Save password'))))));
}

function DeleteDialog({deletion,setDeletion,remove}){
  const {table,row,step}=deletion;
  const entry=row.name||row.invoice_number||recordLabels[table];
  const close=()=>setDeletion(null);
  const isProduct=table==='products';
  return h('dialog',{ref:node=>{if(node&&!node.open)node.showModal();},
    'aria-labelledby':'delete-heading',onCancel:close},
    h('h2',{id:'delete-heading'},step===1?'Delete entry?':isProduct?'Confirm product removal':'Confirm permanent deletion'),
    h('p',null,step===1?'Selected entry: '+entry+'.':isProduct?
      'Remove '+entry+' from active products? Products with linked records will be archived and can be restored. Unlinked products are permanently deleted.':
      'Delete '+entry+' permanently? This cannot be undone.'),
    h('div',{className:'form-footer'},
      h('button',{type:'button',autoFocus:true,className:'secondary',onClick:close},'Cancel'),
      h('button',{type:'button',className:'delete-action',onClick:()=>{
        if(step===1){setDeletion({...deletion,step:2});return;}
        close();
        remove(deletion);
      }},step===1?'Continue':isProduct?'Remove product':'Delete permanently')));
}

function viewPage({page,data,balances,save,post,busy,record,setRecord,upload,preview,photo,setPhoto,move,search,setSearch,invoiceId,setInvoiceId,businessName,restoreProduct,requestDelete}){
  const get=(table,id)=>data[table].find(row=>row.id===id);
  const ledgerBalance=row=>number(balances.get(row.id)||0);
  const listed=(table,cols,render,edit=false,rows=data[table]||[])=>h('section',{className:'card'},h('h2',null,names[table]),
    h(Grid,{columns:edit||requestDelete?[...cols,'Actions']:cols,rows:[...rows].sort((a,b)=>String(b.created_at||b.purchased_on||'').localeCompare(String(a.created_at||a.purchased_on||''))).map(row=>({
      id:row.id,cells:[...render(row),...(edit||requestDelete?[h('div',{className:'inline'},
        edit&&h('button',{className:'secondary',disabled:busy,onClick:()=>setRecord(table==='products'?{...row,stock_quantity:Number((balances.get(row.id)||0).toFixed(3))}:row)},'Edit'),
        requestDelete&&h('button',{className:'delete-action',disabled:busy,onClick:()=>{
          if(postedTables.includes(table)&&row.status!=='draft'){
            window.alert('This entry is part of stock or sales history and cannot be deleted.');
            return;
          }
          requestDelete(table,row);
        }},'Delete'))]:[])],
    }))}));
  const photoPreview=photo&&h('section',{className:'card',key:photo.url,
    ref:node=>node?.scrollIntoView({block:'nearest'})},h('div',{className:'asset'},
    h('strong',null,photo.name),h('button',{className:'secondary',onClick:()=>setPhoto(null)},'Close preview')),
    h('img',{className:'photo',src:photo.url,alt:photo.name}));
  const photoCell=(row,bucket)=>h(RecordPhotos,{row,bucket,assets:data.media_assets,upload,preview,busy});
  const currency=(rows,col)=>fmt(rows.reduce((sum,row)=>sum+Number(row.quantity)*Number(row[col]),0));
  const terms=search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches=(...values)=>{
    const haystack=values.filter(Boolean).map(display).join(' ').toLowerCase();
    return terms.every(term=>haystack.includes(term));
  };
  const searchBox=labelText=>h('section',{className:'card'},h('label',null,labelText,
    h('input',{type:'search',value:search,onChange:event=>setSearch(event.target.value)})));
  if(page==='sales_orders'&&invoiceId){
    const order=get('sales_orders',invoiceId);
    const items=data.sales_items.filter(item=>item.order_id===invoiceId);
    return h(SaleInvoice,{order,items,businessName,customer:get('customers',order?.customer_id),
      products:data.products,close:()=>setInvoiceId(null)});
  }
  const stocked=data.products.filter(row=>!row.archived_at&&(balances.get(row.id)||0)>0).length;
  const sales=data.sales_orders.filter(row=>row.status==='fulfilled').length;
  if(page==='Overview') return h(React.Fragment,null,
    h('div',{className:'metrics'},...[[data.material_lots.length,'Material lots'],[stocked,'Products in stock'],[data.production_batches.length,'Production batches'],[sales,'Fulfilled sales']].map(([value,title])=>
      h('div',{key:title,className:'card metric'},h('strong',null,value),title))),
    h('section',{className:'card'},h('h2',null,'Quick actions'),h('div',{className:'inline'},
      ...[['material_lots','Receive fabric or lace'],['production_batches','Complete production'],['sales_orders','Record a sale']].map(([key,title])=>
        h('button',{key,disabled:busy,onClick:()=>move(key)},title)))));
  const editor=fields[page]&&h(Editor,{key:'editor:'+page+':'+(record?.id||'new'),table:page,record,data,save,close:()=>setRecord(null),busy});
  switch(page){
    case 'suppliers': return h(React.Fragment,null,editor,listed(page,['Name','Phone','Notes'],row=>[row.name,row.phone||'—',row.notes||'—'],true));
    case 'customers': return h(React.Fragment,null,editor,listed(page,['Name','Phone','Email'],row=>[row.name,row.phone||'—',row.email||'—'],true));
    case 'purchases': return h(React.Fragment,null,editor,listed(page,['Date','Supplier','Invoice','Shipping'],row=>[row.purchased_on,label(get('suppliers',row.supplier_id),'suppliers'),row.invoice_number||'—',fmt(row.shipping_cost)],true));
    case 'material_lots': return h(React.Fragment,null,editor,photoPreview,searchBox('Search fabric & lace'),
      listed(page,['Lot','Material','Received','Available','Unit cost','Photos'],row=>[
        row.name,display(row.material_type),number(row.quantity_purchased)+' '+row.unit,ledgerBalance(row)+' '+row.unit,fmt(row.unit_cost),
        photoCell(row,row.material_type==='lace'?'lace-images':'fabric-images'),
      ],true,data.material_lots.filter(row=>matches(row.name,row.material_type,row.unit,get('purchases',row.purchase_id)?.invoice_number))));
    case 'products': {
      const productMatches=row=>matches(row.name,row.sku,row.category,row.source,row.size,unitLabels[row.unit||'piece']);
      const archived=data.products.filter(row=>row.archived_at&&productMatches(row));
      const active=data.products.filter(row=>!row.archived_at&&productMatches(row));
      const available=row=>ledgerBalance(row)+' '+unitLabels[row.unit||'piece'].toLowerCase();
      return h(React.Fragment,null,editor,
        h('details',{className:'card'},h('summary',null,'Add stock to an existing product'),
          h(StockForm,{mode:'receive_product',data,balances,post,busy})),
        photoPreview,searchBox('Search products'),listed(page,['SKU','Name','Category','Available','Unit cost','Selling price','Photos'],row=>[
          row.sku,row.name,display(row.category),available(row),fmt(row.cost_price),fmt(row.selling_price),photoCell(row,'product-images'),
        ],true,active),
        archived.length>0&&h('details',{className:'card'},h('summary',null,'Archived products'),
          h(Grid,{columns:requestDelete?['SKU','Name','Stock on record','Actions']:['SKU','Name','Stock on record'],
            rows:archived.map(row=>({id:row.id,cells:[row.sku,row.name,available(row),
              ...(requestDelete?[h('button',{type:'button',className:'secondary',disabled:busy,onClick:()=>restoreProduct(row)},'Restore')]:[])]}))})));
    }
    case 'production_batches': return h(React.Fragment,null,h(StockForm,{key:'stock:'+page,mode:'complete_production',data,balances,post,busy}),photoPreview,
      listed(page,['Date','Product','Quantity','Total cost','Cost per unit','Status','Finished product photos'],row=>{
        const used=data.material_usage.filter(item=>item.batch_id===row.id);
        const total=used.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.unit_cost_snapshot),Number(row.tailoring_cost)+Number(row.other_cost));
        return [new Date(row.created_at).toLocaleDateString('en-IN'),label(get('products',row.product_id),'products'),number(row.quantity),fmt(total),fmt(total/Number(row.quantity)),display(row.status),
          get('products',row.product_id)?photoCell(get('products',row.product_id),'product-images'):'—'];
      }));
    case 'sales_orders': return h(React.Fragment,null,h(StockForm,{key:'stock:'+page,mode:'fulfill_sale',data,balances,post,busy}),
      listed(page,['Date','Channel','Customer','Items','Total','Status','Invoice'],row=>{
        const items=data.sales_items.filter(item=>item.order_id===row.id);
        return [new Date(row.created_at).toLocaleDateString('en-IN'),display(row.channel),label(get('customers',row.customer_id),'customers'),
          items.map(item=>number(item.quantity)+' × '+label(get('products',item.product_id),'products')).join(', '),currency(items,'unit_price'),row.is_sample?'Sample — stock restored':display(row.status),row.status==='fulfilled'&&items.length>0?
            h('button',{type:'button',className:'secondary',disabled:busy,onClick:()=>setInvoiceId(row.id)},'View invoice'):'—'];
      }));
    case 'media_assets': return h(React.Fragment,null,h(FileForm,{data,upload,busy}),
      listed(page,['Category','Linked record','Added','File'],row=>{
        const [title,table,column]=buckets[row.bucket];
        return [title,label(get(table,row[column]),table),new Date(row.created_at).toLocaleDateString('en-IN'),
          h('button',{className:'secondary',disabled:busy,onClick:()=>preview(row)},'Open file')];
      }),photoPreview);
    default:return null;
  }
}

function SaleInvoice({order,items,businessName,customer,products,close}){
  const total=items.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.unit_price),0);
  const seller=businessName||'Bhami';
  const buyer=customer?.name||'Walk-in customer';
  const soldOn=order?new Date(order.created_at).toLocaleDateString('en-IN'):'';
  const rows=items.map(item=>{
    const product=products.find(row=>row.id===item.product_id);
    return {id:item.id,cells:[product?.sku||'—',product?.name||'Product',number(item.quantity)+' '+unitLabels[item.unit_snapshot||product?.unit||'piece'].toLowerCase(),
      fmt(item.unit_price),fmt(Number(item.quantity)*Number(item.unit_price))]};
  });
  const whatsappText=order&&rows.length?[
    seller+' · Sales invoice','Invoice ID: '+order.id,'Sold on: '+soldOn,'Customer: '+buyer,'',
    ...rows.map(({cells:[sku,name,quantity,price,amount]})=>quantity+' × '+name+' ('+sku+') at '+price+' = '+amount),
    '','Total: '+fmt(total),
  ].join('\n'):null;
  return h('section',{className:'card sale-invoice','aria-label':'Sales invoice'},
    h('div',{className:'inline invoice-actions'},
      h('button',{type:'button',className:'secondary',onClick:close},'Back to sales'),
      h('button',{type:'button',disabled:!order||!items.length,onClick:()=>window.print()},'Print / Save PDF'),
      whatsappText&&h('a',{className:'invoice-share',href:'https://wa.me/?text='+encodeURIComponent(whatsappText),
        target:'_blank',rel:'noopener noreferrer'},'Share via WhatsApp')),
    h('h2',null,'Sales invoice'),
    order&&items.length?h(React.Fragment,null,
      h('p',null,h('strong',null,seller)),
      h('p',null,'Invoice ID ',order.id),
      h('p',null,'Sold on ',soldOn),
      h('p',null,'Customer ',buyer),
      h('p',null,'Channel ',display(order.channel)),
      h(Grid,{columns:['SKU','Product','Quantity','Unit price','Amount'],rows}),
      h('p',{className:'invoice-total'},h('strong',null,'Total ',fmt(total))))
      :h('p',{role:'status'},'Loading saved sale…'));
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
    h('h1',null,'Bhami'),
    h('section',{className:'card'},h('h2',null,'Sign in'),
      h('form',{onSubmit:async event=>{
        event.preventDefault();
        if(busy)return;
        const values=new FormData(event.currentTarget);
        setBusy(true);setNotice(null);
        try {
          checked(await db.auth.signInWithPassword({
            email:String(values.get('email')).trim(), password:String(values.get('password')),
          }));
        } catch(error){setNotice({error:true,text:errText(error)});}
        finally{setBusy(false);}
      }},
      h('label',null,'Email address',h('input',{name:'email',required:true,type:'email',autoComplete:'username',disabled:busy})),
      h('label',null,'Password',h('input',{name:'password',required:true,type:'password',autoComplete:'current-password',disabled:busy})),
      h('button',{disabled:busy},busy?'Please wait…':'Sign in')),
      h('details',{className:'form-footer'},h('summary',null,'Need to set a password?'),
        h('p',{className:'muted'},'Existing members can use an email link once, then set a password in the workspace. If email delivery fails, contact the Bhami administrator.'),
        h('form',{onSubmit:async event=>{
          event.preventDefault();
          if(busy)return;
          const email=String(new FormData(event.currentTarget).get('email')).trim();
          setBusy(true);setNotice(null);
          try {
            checked(await db.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:redirect()}}));
            setNotice({text:'Check your inbox for the sign-in link.'});
          } catch(error){setNotice({error:true,text:errText(error)});}
          finally{setBusy(false);}
        }},
        h('label',null,'Email address for sign-in link',h('input',{name:'email',required:true,type:'email',autoComplete:'email',disabled:busy})),
        h('button',{disabled:busy,className:'secondary'},'Email me a sign-in link'))),
      notice&&h('p',{className:'notice '+(notice.error?'error':''),role:notice.error?'alert':'status'},notice.text)));
}


function Field({spec, data={}, record={}, disabled=false, onChange}){
  const [key,title,type='text',required=true,defaultValue=''] = spec;
  const startingValue = record[key] ?? defaultValue;
  const selection = Array.isArray(type) ? type.map(value=>[value,key==='unit'?unitLabels[value]||display(value):display(value)])
    : Array.isArray(data[type]) ? data[type].map(row=>[row.id,label(row,type)]) : null;
  const control = selection ? h('select',{name:key,required,defaultValue:startingValue,disabled,onChange},
    h('option',{value:''}, required ? 'Choose…' : 'None'),...selection.map(([value,text])=>h('option',{key:value,value},text)))
    : h('input',{name:key,required,defaultValue:startingValue,disabled,type:['money','amount'].includes(type)?'number':type,
      ...(['money','amount'].includes(type)?{min:0,step:key==='stock_quantity'?0.001:'any'}:{})});
  return h('label',null,title,control,key==='stock_quantity'&&h('small',{className:'muted'},'Enter the total currently in stock, in the selected unit.'),key==='opening_quantity'&&h('small',{className:'muted'},'Leave blank or enter zero if there is no stock yet.'),key==='sku'&&h('small',{className:'muted'},record.id?'Keep the existing SKU or enter a custom one.':'Leave blank to assign the next SAR or DRS code when you save.'),key==='source'&&h('small',{className:'muted source-hint'},
    h('span',null,'* Ready-made — bought as a finished item for resale.'),
    h('span',null,'* In-house — made by your own team.'),
    h('span',null,'* External — made to order by an outside tailor or production partner.')));
}

function Grid({columns,rows}){
  return rows.length ? h('div',{className:'table-wrap'},h('table',null,
    h('thead',null,h('tr',null,...columns.map(col=>h('th',{key:col,scope:'col'},col)))),
    h('tbody',null,...rows.map(({id,cells})=>h('tr',{key:id},...cells.map((cell,index)=>h('td',{key:index},cell)))))))
    : h('p',{className:'muted'},'No records yet.');
}

function Editor({table,data,save,record,close,busy}){
  const entry=recordLabels[table];
  const [category,setCategory]=useState(record?.category||'');
  const specs=fields[table].filter(([key])=>
    (key!=='quantity_purchased'||!record)&&(key!=='size'||category==='dress'));
  if(table==='products'){
    specs.push(record?['stock_quantity','Current stock quantity','amount']:['opening_quantity','Opening quantity','amount',false],
      ['unit','Stock unit',['piece','metre'],true,'piece']);
  }
  return h('section',{className:table==='products'?'card product-editor':'card'},h('h2',null,(record?'Edit ':'Add ')+entry),
    h('form',{key:record?.id||'new',onSubmit:event=>{
      event.preventDefault();
      const form=event.currentTarget, values=new FormData(form);
      const payload=Object.fromEntries(specs.flatMap(([key,,type])=>{
        const value=String(values.get(key)||'').trim();
        if(key==='sku'&&!value)return [];
        if(!value && !record) return [];
        return [[key,value ? ['money','amount'].includes(type)?Number(value):value : key==='shipping_cost'?0:key==='purchased_on'?record.purchased_on:null]];
      }));
      if(table==='products'&&payload.category==='saree')payload.size=null;
      save(table,payload,record?.id,()=>{form.reset();setCategory('');close();});
    }},h('div',{className:'form-grid'},...specs.map(spec=>h(Field,{key:spec[0],spec,data,record:record||{},onChange:spec[0]==='category'?event=>setCategory(event.target.value):undefined}))),
    h('div',{className:'form-footer'},h('button',{disabled:busy},record?'Save changes':'Save '+entry),
      record && h('button',{type:'button',className:'secondary',onClick:close},'Cancel'))));
}

function StockForm({mode,data,balances,post,busy}){
  const [lines,setLines]=useState([{key:0,id:'',quantity:''}]);
  const [output,setOutput]=useState('');
  const [receiptUnit,setReceiptUnit]=useState('');
  const [units,setUnits]=useState('');
  const [tailoring,setTailoring]=useState('');
  const [other,setOther]=useState('');
  const next=useRef(1);
  const production=mode==='complete_production', sale=mode==='fulfill_sale', receipt=mode==='receive_product';
  const activeProducts=data.products.filter(row=>!row.archived_at);
  const choices=production?data.material_lots:activeProducts;
  const outputUnit=data.products.find(row=>row.id===output)?.unit||'piece';
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
      const details=production?{materials:items,tailoring_cost:Number(tailoring||0),other_cost:Number(other||0)}:sale?{items,channel:values.get('channel'),customer_id:values.get('customer_id')||null}:{unit:receiptUnit};
      post({operation:mode,item_id:sale?null:output,units:sale?null:Number(units),details},()=>{
        form.reset(); setOutput('');setReceiptUnit('');setUnits('');setTailoring('');setOther('');setLines([{key:0,id:'',quantity:''}]);
      });
    }},
    h('div',{className:'form-grid'},
      !sale&&h('label',null,'Product',h('select',{required:true,value:output,onChange:e=>{
        const id=e.target.value;
        setOutput(id);setUnits('');setReceiptUnit(id?(data.products.find(row=>row.id===id)?.unit||'piece'):'');
      }},
        h('option',{value:''},'Choose…'),...activeProducts.map(row=>h('option',{value:row.id,key:row.id},row.sku+' · '+row.name)))),
      !sale&&h('label',null,production&&output?'Finished quantity ('+unitLabels[outputUnit].toLowerCase()+')':'Finished quantity',h('input',{type:'number',min:'0.000001',step:'any',required:true,value:units,onChange:e=>setUnits(e.target.value)})),
      receipt&&h('label',null,'Stock unit',h('select',{required:true,disabled:!output,value:receiptUnit,
        onChange:event=>setReceiptUnit(event.target.value)},
        h('option',{value:''},'Choose product first'),...['piece','metre'].map(unit=>
          h('option',{key:unit,value:unit,disabled:unit!==outputUnit},unitLabels[unit]))),
        h('small',{className:'muted'},'Stock additions use the unit set when the product was created.')),
      production&&h('label',null,'Tailoring cost',h('input',{type:'number',min:0,step:'any',value:tailoring,onChange:e=>setTailoring(e.target.value)})),
      production&&h('label',null,'Other batch costs',h('input',{type:'number',min:0,step:'any',value:other,onChange:e=>setOther(e.target.value)})),
      sale&&h(Field,{spec:['channel','Sales channel',['direct','whatsapp','exhibition','online']]}),
      sale&&h(Field,{spec:['customer_id','Customer','customers',false],data})),
    !receipt&&h('fieldset',null,h('legend',null,production?'Materials used':'Products sold'),
      ...lines.map(line=>{
        const chosen=choices.find(row=>row.id===line.id);
        const unit=chosen&&(production?chosen.unit:chosen.unit||'piece');
        return h('div',{className:'line',key:line.key},
        h('label',null,production?'Material lot':'Product',h('select',{required:true,value:line.id,onChange:e=>change(line.key,{id:e.target.value,...(production?{quantity:''}:{})})},
          h('option',{value:''},'Choose…'),...choices.map(row=>h('option',{value:row.id,key:row.id},row.name+' · '+number(balances.get(row.id)||0)+' '+(production?row.unit:unitLabels[row.unit||'piece'].toLowerCase())+' available')))),
        h('label',null,unit?'Quantity ('+unit+')':'Quantity',h('input',{type:'number',min:'0.000001',step:'any',required:true,value:line.quantity,onChange:e=>change(line.key,{quantity:e.target.value})})),
        h('button',{type:'button',className:'secondary',disabled:lines.length===1,onClick:()=>setLines(old=>old.filter(x=>x.key!==line.key))},'Remove'));
      }),
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
function PhotoThumbnail({asset,caption,preview,busy}){
  const button=useRef(null);
  const [image,setImage]=useState(null);

  useEffect(()=>{
    let active=true;
    let objectUrl;
    let observer;
    const controller=new AbortController();
    const load=async()=>{
      observer?.disconnect();
      try {
        const blob=checked(await db.storage.from(asset.bucket).download(asset.object_path,{},{
          signal:controller.signal,
        }));
        if(!active)return;
        if(!['image/jpeg','image/png','image/webp'].includes(blob.type))throw new Error('Unsupported image');
        objectUrl=URL.createObjectURL(blob);
        setImage(objectUrl);
      }catch{
        if(active)setImage(false);
      }
    };
    if(typeof IntersectionObserver==='function'){
      observer=new IntersectionObserver(entries=>{
        if(entries.some(entry=>entry.isIntersecting))load();
      },{rootMargin:'160px'});
      observer.observe(button.current);
    }else{
      load();
    }
    return ()=>{
      active=false;
      controller.abort();
      observer?.disconnect();
      if(objectUrl)URL.revokeObjectURL(objectUrl);
    };
  },[asset.bucket,asset.object_path]);

  return h('button',{ref:button,type:'button',className:'secondary photo-thumbnail',disabled:busy,
    'aria-label':'Preview '+caption,title:caption,onClick:()=>preview(asset,caption)},
    image ? h('img',{src:image,alt:'',width:54,height:54,onError:()=>setImage(false)})
      : h('span',null,image===false?'Preview':'Loading…'));
}

function RecordPhotos({row,bucket,assets,upload,preview,busy}){
  const picker=useRef(null);
  const [, , column, types]=buckets[bucket];
  const photos=assets.filter(asset=>asset[column]===row.id &&
    (asset.bucket==='product-images'||asset.bucket==='fabric-images'||asset.bucket==='lace-images'))
    .sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));

  return h('div',{className:'inline'},
    h('input',{ref:picker,type:'file',hidden:true,accept:types,disabled:busy,onChange:event=>{
      const file=event.currentTarget.files[0];
      event.currentTarget.value='';
      if(file) upload(bucket,column,row.id,file);
    }}),
    h('button',{type:'button',className:'secondary',disabled:busy,'aria-label':'Add photo for '+row.name,
      onClick:()=>picker.current.click()},'Add photo'),
    ...photos.map((asset,index)=>h(PhotoThumbnail,{key:asset.id,asset,
      caption:row.name+' · Photo '+(index+1),preview,busy})));
}

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

