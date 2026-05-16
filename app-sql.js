(function() {
  'use strict';

  var ICONS={Food:'\u{1F354}',Shopping:'\u{1F6CD}️',Bills:'\u{1F4C4}',Transport:'\u{1F697}',Health:'\u{1F48A}',Entertainment:'\u{1F3AC}',Others:'\u{1F4E6}',Income:'\u{1F4B0}',Transfer:'\u{1F504}'};
  var CATEGORIES=['Food','Shopping','Bills','Transport','Health','Entertainment','Others'];
  var DB_NAME='ExpenseTrackerDB';
  var DB_STORE='sqlitedb';
  var META_STORE='meta';

  // IndexedDB
  function openIDB(){return new Promise(function(ok,no){var r=indexedDB.open(DB_NAME,2);r.onupgradeneeded=function(e){var d=e.target.result;if(!d.objectStoreNames.contains(DB_STORE))d.createObjectStore(DB_STORE);if(!d.objectStoreNames.contains(META_STORE))d.createObjectStore(META_STORE);};r.onsuccess=function(){ok(r.result);};r.onerror=function(){no(r.error);};});}
  function idbGet(store,key){return openIDB().then(function(d){return new Promise(function(ok,no){var tx=d.transaction(store,'readonly');var r=tx.objectStore(store).get(key);r.onsuccess=function(){ok(r.result);};r.onerror=function(){no(r.error);};});});}
  function idbPut(store,key,val){return openIDB().then(function(d){return new Promise(function(ok,no){var tx=d.transaction(store,'readwrite');tx.objectStore(store).put(val,key);tx.oncomplete=function(){ok();};tx.onerror=function(){no(tx.error);};});});}

  // SQL Database
  var sqldb=null;
  var activeUserId=null;
  var saveTimer=null;
  var SCHEMA=[
    "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS settings(user_id INTEGER PRIMARY KEY,default_bank TEXT DEFAULT '',budget REAL DEFAULT 0,rollover REAL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS banks(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,name TEXT NOT NULL,balance REAL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,amount REAL NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'expense',bank TEXT,transfer_to TEXT,created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS patterns(user_id INTEGER NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,count INTEGER DEFAULT 1,PRIMARY KEY(user_id,description))"
  ];

  function persistDB(){clearTimeout(saveTimer);saveTimer=setTimeout(function(){if(!sqldb)return;var data=sqldb['export']();idbPut(DB_STORE,'db',new Uint8Array(data));},300);}
  function run(sql,params){sqldb.run(sql,params||[]);persistDB();}
  function sqlQuery(sql,params){return sqldb['exec'](sql,params||[]);}
  function queryRows(sql,params){var res=sqlQuery(sql,params);if(!res.length)return[];var cols=res[0].columns,vals=res[0].values;return vals.map(function(row){var o={};cols.forEach(function(c,i){o[c]=row[i];});return o;});}
  function queryOne(sql,params){var r=queryRows(sql,params);return r.length?r[0]:null;}

  // DB API
  var DB={
    getUsers:function(){return queryRows("SELECT * FROM users ORDER BY id");},
    createUser:function(name){run("INSERT INTO users(name,created_at) VALUES(?,?)",[name,Date.now()]);var u=queryOne("SELECT last_insert_rowid() as id");return u.id;},
    getSettings:function(){var s=queryOne("SELECT * FROM settings WHERE user_id=?",[activeUserId]);if(!s){run("INSERT OR IGNORE INTO settings(user_id) VALUES(?)",[activeUserId]);return{budget:0,rollover:0,default_bank:''};}return s;},
    updateSettings:function(obj){var s=DB.getSettings();run("INSERT OR REPLACE INTO settings(user_id,default_bank,budget,rollover) VALUES(?,?,?,?)",[activeUserId,obj.default_bank!==undefined?obj.default_bank:s.default_bank,obj.budget!==undefined?obj.budget:s.budget,obj.rollover!==undefined?obj.rollover:s.rollover]);},
    getBanks:function(){return queryRows("SELECT * FROM banks WHERE user_id=? ORDER BY id",[activeUserId]);},
    getBankNames:function(){return DB.getBanks().map(function(b){return b.name;});},
    getDefaultBank:function(){return(DB.getSettings()).default_bank||'';},
    saveBanks:function(arr){run("DELETE FROM banks WHERE user_id=?",[activeUserId]);arr.forEach(function(b){run("INSERT INTO banks(user_id,name,balance) VALUES(?,?,?)",[activeUserId,b.name,b.balance]);});},
    updateBankBalance:function(name,amount,isDebit){var banks=DB.getBanks();for(var i=0;i<banks.length;i++){if(banks[i].name===name){run("UPDATE banks SET balance=? WHERE id=?",[isDebit?banks[i].balance-amount:banks[i].balance+amount,banks[i].id]);return;}}},
    getExpenses:function(){return queryRows("SELECT * FROM expenses WHERE user_id=? ORDER BY id",[activeUserId]);},
    addExpense:function(e){run("INSERT INTO expenses(user_id,amount,description,category,type,bank,transfer_to,created_at) VALUES(?,?,?,?,?,?,?,?)",[activeUserId,e.amount,e.desc,e.category,e.type,e.bank||null,e.transferTo||null,Date.now()]);},
    deleteExpense:function(id){run("DELETE FROM expenses WHERE id=? AND user_id=?",[id,activeUserId]);},
    getExpenseById:function(id){return queryOne("SELECT * FROM expenses WHERE id=? AND user_id=?",[id,activeUserId]);},
    getPatterns:function(){var rows=queryRows("SELECT * FROM patterns WHERE user_id=?",[activeUserId]);var m={};rows.forEach(function(r){m[r.description]={category:r.category,count:r.count};});return m;},
    savePattern:function(desc,cat){var key=desc.toLowerCase().trim();if(!key)return;var ex=queryOne("SELECT * FROM patterns WHERE user_id=? AND description=?",[activeUserId,key]);if(ex)run("UPDATE patterns SET category=?,count=? WHERE user_id=? AND description=?",[cat,ex.count+1,activeUserId,key]);else run("INSERT INTO patterns(user_id,description,category,count) VALUES(?,?,?,1)",[activeUserId,key,cat]);},
    nukeUser:function(){run("DELETE FROM expenses WHERE user_id=?",[activeUserId]);run("UPDATE banks SET balance=0 WHERE user_id=?",[activeUserId]);run("DELETE FROM patterns WHERE user_id=?",[activeUserId]);DB.updateSettings({budget:0,rollover:0});}
  };

  // AI: Ambiguity
  var AMBIGUOUS_WORDS=['salary','income','pay','payment','wages','bonus','incentive','stipend','freelance','commission','refund','cashback','reimbursement','dividend','interest','payout','earnings','honorarium','allowance','prize','reward'];
  var EXPENSE_HINTS=['cook','maid','driver','helper','nanny','watchman','guard','gardener','servant','staff'];
  function isAmbiguousInput(desc){var w=desc.toLowerCase().split(/\s+/),a=false,h=false;for(var i=0;i<w.length;i++){if(AMBIGUOUS_WORDS.indexOf(w[i])!==-1)a=true;if(EXPENSE_HINTS.indexOf(w[i])!==-1)h=true;}return a&&!h;}

  // AI: Keywords
  var KEYWORDS={Food:['swiggy','zomato','chai','tea','coffee','starbucks','cafe','restaurant','hotel','mess','canteen','biryani','dosa','pizza','dominos','burger','mcdonalds','kfc','subway','momos','noodles','maggi','thali','lunch','dinner','breakfast','snack','snacks','samosa','juice','lassi','ice cream','bakery','cake','sweet','fruits','grocery','groceries','bigbasket','blinkit','zepto','milk','bread','eggs','chicken','mutton','fish','meat','rice','dal','paneer','food','eat'],Shopping:['amazon','flipkart','myntra','ajio','meesho','nykaa','dmart','reliance','mall','shopping','clothes','shoes','shirt','jeans','dress','jewellery','watch','bag','wallet','cosmetics','makeup','electronics','phone','laptop','headphones','furniture','gift','book','books'],Bills:['electricity','bill','bills','wifi','broadband','internet','jio','airtel','bsnl','recharge','rent','maintenance','society','water','gas','emi','loan','insurance','premium','lic','sip','tax','credit card','subscription'],Transport:['ola','uber','rapido','auto','rickshaw','cab','taxi','metro','bus','train','flight','petrol','diesel','fuel','parking','toll','fastag','car','bike','scooter','travel'],Health:['pharmacy','medical','medicine','apollo','medplus','doctor','hospital','clinic','dentist','gym','fitness','yoga','protein','vitamin','checkup'],Entertainment:['netflix','hotstar','spotify','youtube','movie','cinema','pvr','inox','concert','tickets','bookmyshow','game','gaming','pub','bar','party','sports','cricket'],Others:['donation','charity','temple','salon','haircut','barber','laundry','courier','delivery','repair','plumber','electrician','maid','cook','driver','helper']};
  var keywordMap={};CATEGORIES.forEach(function(c){(KEYWORDS[c]||[]).forEach(function(k){keywordMap[k.toLowerCase()]=c;});});

  // AI: Micro Neural Net
  var TVS=256,HS=32,NC=7;
  function sr(s){var x=Math.sin(s)*10000;return x-Math.floor(x);}
  function tgv(t){var v=new Float32Array(TVS),s=' '+t.toLowerCase().replace(/[^a-z0-9 ]/g,'')+' ';for(var i=0;i<s.length-2;i++){var h=((s.charCodeAt(i)*31+s.charCodeAt(i+1))*31+s.charCodeAt(i+2))%TVS;if(h<0)h+=TVS;v[h]+=1;}var m=0;for(var j=0;j<TVS;j++)if(v[j]>m)m=v[j];if(m>0)for(var k=0;k<TVS;k++)v[k]/=m;return v;}
  function initW(){var w1=[],b1=[],w2=[],b2=[],s=42;for(var i=0;i<HS;i++){w1[i]=[];for(var j=0;j<TVS;j++)w1[i][j]=(sr(s++)-0.5)*0.3;b1[i]=(sr(s++)-0.5)*0.1;}for(var c=0;c<NC;c++){w2[c]=[];for(var h=0;h<HS;h++)w2[c][h]=(sr(s++)-0.5)*0.5;b2[c]=(sr(s++)-0.5)*0.1;}var ex={Food:['swiggy order','zomato food','chai tapri','biryani dinner'],Shopping:['amazon purchase','flipkart order','mall shopping'],Bills:['electricity bill','wifi recharge','rent payment'],Transport:['ola ride','uber cab','metro ticket'],Health:['apollo pharmacy','doctor visit','gym membership'],Entertainment:['netflix subscription','movie tickets'],Others:['donation temple','salon haircut']};CATEGORIES.forEach(function(cat,ci){(ex[cat]||[]).forEach(function(e){var v=tgv(e);for(var hi=0;hi<HS;hi++)for(var vi=0;vi<TVS;vi++)if(v[vi]>0)w1[hi][vi]+=(sr(s++)>0.5?0.08:-0.02)*v[vi];for(var xi=0;xi<NC;xi++)for(var hj=0;hj<HS;hj++)w2[xi][hj]+=(xi===ci?0.15:-0.03)*sr(s++);b2[ci]+=0.3;});});return{w1:w1,b1:b1,w2:w2,b2:b2};}
  function mlP(t,W){var v=tgv(t),hid=new Float32Array(HS);for(var h=0;h<HS;h++){var sm=W.b1[h];for(var vi=0;vi<TVS;vi++)sm+=W.w1[h][vi]*v[vi];hid[h]=sm>0?sm:0;}var lo=new Float32Array(NC),mx=-Infinity;for(var c=0;c<NC;c++){var s2=W.b2[c];for(var hh=0;hh<HS;hh++)s2+=W.w2[c][hh]*hid[hh];lo[c]=s2;if(s2>mx)mx=s2;}var eS=0,pr=new Float32Array(NC);for(var p=0;p<NC;p++){pr[p]=Math.exp(lo[p]-mx);eS+=pr[p];}var bi=0,bp=0;for(var q=0;q<NC;q++){pr[q]/=eS;if(pr[q]>bp){bp=pr[q];bi=q;}}return{category:CATEGORIES[bi],confidence:bp};}
  var nnW=initW();

  function categorize(desc){
    if(!desc||!desc.trim())return{category:'Others',confidence:0,source:'default'};
    var p=DB.getPatterns(),k=desc.toLowerCase().trim();
    if(p[k]&&p[k].count>=1)return{category:p[k].category,confidence:1,source:'learned'};
    var ks=Object.keys(p);for(var i=0;i<ks.length;i++)if((k.indexOf(ks[i])!==-1||ks[i].indexOf(k)!==-1)&&p[ks[i]].count>=2)return{category:p[ks[i]].category,confidence:0.85,source:'learned'};
    var words=desc.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/);
    for(var j=0;j<words.length-1;j++){var ph=words[j]+' '+words[j+1];if(keywordMap[ph])return{category:keywordMap[ph],confidence:1,source:'keyword'};}
    for(var m=0;m<words.length;m++)if(keywordMap[words[m]])return{category:keywordMap[words[m]],confidence:1,source:'keyword'};
    var ml=mlP(desc,nnW);if(ml.confidence>0.4)return{category:ml.category,confidence:ml.confidence,source:'ai'};
    return{category:'Others',confidence:0.2,source:'default'};
  }

  // NLP Parser
  function parseSmartInput(text){
    if(!text||!text.trim())return null;var t=text.trim().replace(/^[₹$]\s*/i,'').replace(/^(rs\.?|inr)\s*/i,'');
    var parts=t.split(/\s+/),amtM=null,amtI=-1,bnkM=null,bnkI=-1,bNames=DB.getBankNames();
    for(var len=Math.min(3,parts.length);len>=1;len--)for(var st=0;st<=parts.length-len;st++){var cand=parts.slice(st,st+len).join(' ');for(var bi=0;bi<bNames.length;bi++)if(cand.toLowerCase()===bNames[bi].toLowerCase()){bnkM=bNames[bi];bnkI=st;len=0;break;}}
    var xTo=null,xKI=-1;for(var ti=0;ti<parts.length;ti++){if(parts[ti].toLowerCase()==='to'||parts[ti]==='>'||parts[ti]==='->'){for(var tl=Math.min(3,parts.length-ti-1);tl>=1;tl--){var tc=parts.slice(ti+1,ti+1+tl).join(' ');for(var tbi=0;tbi<bNames.length;tbi++)if(tc.toLowerCase()===bNames[tbi].toLowerCase()){xTo=bNames[tbi];xKI=ti;tl=0;break;}}if(xTo)break;}}
    var hasXW=false;for(var tw=0;tw<parts.length;tw++)if(parts[tw].toLowerCase()==='transfer'){hasXW=true;break;}
    var skip={};if(bnkI!==-1){var bw=bnkM.split(' ').length;for(var si=bnkI;si<bnkI+bw;si++)skip[si]=true;}
    if(xTo&&xKI!==-1){skip[xKI]=true;var tw2=xTo.split(' ').length;for(var si2=xKI+1;si2<xKI+1+tw2;si2++)skip[si2]=true;}
    for(var ai=parts.length-1;ai>=0;ai--){if(skip[ai])continue;if(parts[ai].toLowerCase()==='transfer')continue;var cl=parts[ai].replace(/,/g,'').replace(/^[₹$]/,'').replace(/^(rs\.?|inr)/i,'');var lM=cl.match(/^(\d+\.?\d*)[lL]$/);if(lM){amtM=parseFloat(lM[1])*100000;amtI=ai;break;}var kM=cl.match(/^(\d+\.?\d*)[kK]$/);if(kM){amtM=parseFloat(kM[1])*1000;amtI=ai;break;}if(/^\d+\.?\d*$/.test(cl)&&parseFloat(cl)>0){amtM=parseFloat(cl);amtI=ai;break;}}
    if(amtM===null)return null;skip[amtI]=true;var dp=[];for(var di=0;di<parts.length;di++){if(skip[di])continue;if(parts[di].toLowerCase()==='transfer')continue;dp.push(parts[di]);}
    var desc=dp.join(' ').replace(/^[₹$]\s*/,'').replace(/^(rs\.?|inr)\s*/i,'').replace(/^[-–—:,.\s]+/,'').replace(/[-–—:,.\s]+$/,'').trim();
    var isX=(hasXW||xTo)&&bnkM&&xTo;var catR=isX?{category:'Others',confidence:1,source:'default'}:categorize(desc||'others');
    return{amount:amtM,desc:desc||(isX?'Transfer':catR.category),category:catR.category,confidence:catR.confidence,source:catR.source,bank:bnkM,transferTo:xTo,isTransfer:isX};
  }

  // Insights
  function generateInsights(expenses,budget){
    var ins=[];if(budget<=0||expenses.length<2)return ins;var cr=0,db2=0;expenses.forEach(function(e){if(e.type==='credit')cr+=e.amount;else if(e.type!=='transfer')db2+=e.amount;});
    var spent=db2,tot=budget+cr,rem=tot-db2,pct=tot>0?spent/tot:0;var debits=expenses.filter(function(e){return e.type!=='credit'&&e.type!=='transfer';});if(debits.length<2)return ins;
    var dates=debits.map(function(e){return e.created_at;}),earliest=Math.min.apply(null,dates),now=Date.now(),days=Math.max(1,Math.ceil((now-earliest)/86400000)),rate=spent/days;
    if(pct>0.5&&days<15){var left=rem>0?Math.ceil(rem/rate):0;if(left>0&&left<20)ins.push({icon:'⚡',text:'Budget runs out in ~'+left+' days',type:'alert'});}
    if(pct>0.8)ins.push({icon:'\u{1F6A8}',text:'Used '+Math.round(pct*100)+'% of budget',type:'alert'});
    var catT={};debits.forEach(function(e){catT[e.category]=(catT[e.category]||0)+e.amount;});var topC='',topA=0;Object.keys(catT).forEach(function(c){if(catT[c]>topA){topA=catT[c];topC=c;}});
    if(topC&&topA/spent>0.4)ins.push({icon:ICONS[topC]||'\u{1F4CA}',text:topC+': '+Math.round(topA/spent*100)+'%',type:'neutral'});
    if(pct<0.3&&days>7)ins.push({icon:'\u{1F31F}',text:'Great pace! '+Math.round(pct*100)+'% in '+days+' days',type:'good'});
    if(debits.length>=3)ins.push({icon:'\u{1F4C8}',text:'Avg: ₹'+Math.round(rate).toLocaleString('en-IN')+'/day',type:'neutral'});
    return ins.slice(0,3);
  }

  // UI Helpers
  function fmt(n){return '₹'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:2});}
  function el(tag,cls){var n=document.createElement(tag);if(cls)n.className=cls;return n;}
  function openModal(id){document.getElementById(id).classList.add('active');}
  function closeModal(id){document.getElementById(id).classList.remove('active');}
  var entryType='expense',currentParsed=null,pendingAmbiguous=null,activeFilter='All',searchQuery='';

  function renderBankStrip(){var strip=document.getElementById('bankStrip');strip.textContent='';DB.getBanks().forEach(function(b){var chip=el('div','bank-chip'),nm=el('div','bank-chip-name'),bal=el('div','bank-chip-bal'+(b.balance<0?' negative':''));nm.textContent=b.name;bal.textContent=fmt(b.balance);chip.appendChild(nm);chip.appendChild(bal);strip.appendChild(chip);});}
  function renderBankSelect(){var wrap=document.getElementById('bankSelectWrap');wrap.textContent='';var banks=DB.getBanks();if(!banks.length)return;var sel=el('select','input');sel.id='bankInput';sel.setAttribute('style','min-height:34px;padding:6px 32px 6px 10px;font-size:13px;font-weight:600;border-radius:10px;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\'%3E%3Cpath d=\'M1 1l5 5 5-5\' stroke=\'%237c7c82\' stroke-width=\'1.5\' fill=\'none\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px');var none=el('option');none.value='';none.textContent='\u{1F3E6} No Bank';sel.appendChild(none);var def=DB.getDefaultBank();banks.forEach(function(b){var o=el('option');o.value=b.name;o.textContent='\u{1F3E6} '+b.name;sel.appendChild(o);});if(def)sel.value=def;wrap.appendChild(sel);}

  function createExpenseItem(expense){
    var isCr=expense.type==='credit',isXf=expense.type==='transfer';var item=el('div','expense-item'+(isCr?' credit':'')+(isXf?' transfer':''));
    var catKey=isCr?'Income':(isXf?'Transfer':expense.category);var icon=el('div','expense-cat-icon cat-'+catKey);
    icon.textContent=isCr?ICONS.Income:(isXf?ICONS.Transfer:(ICONS[expense.category]||'\u{1F4E6}'));item.appendChild(icon);
    var info=el('div','expense-info'),desc=el('div','expense-desc');desc.textContent=expense.description;info.appendChild(desc);
    var meta=el('div','expense-meta');meta.appendChild(document.createTextNode(isCr?'Income':(isXf?'Transfer':expense.category)));
    if(expense.bank){var bt=el('span','expense-bank-tag');bt.textContent=expense.bank;meta.appendChild(bt);}
    if(expense.transfer_to){meta.appendChild(document.createTextNode(' → '));var tt=el('span','expense-bank-tag');tt.textContent=expense.transfer_to;meta.appendChild(tt);}
    info.appendChild(meta);item.appendChild(info);var amt=el('div','expense-amount');amt.textContent=(isCr?'+':isXf?'':'-')+fmt(expense.amount);item.appendChild(amt);
    var del=el('button','btn-delete');del.textContent='✕';del.setAttribute('aria-label','Delete');del.dataset.id=expense.id;item.appendChild(del);return item;
  }

  function render(){
    var settings=DB.getSettings(),expenses=DB.getExpenses();var cr=0,db2=0;expenses.forEach(function(e){if(e.type==='credit')cr+=e.amount;else if(e.type!=='transfer')db2+=e.amount;});
    var rem=settings.budget+cr-db2,tot=settings.budget+cr;
    document.getElementById('totalBudget').textContent=fmt(tot);document.getElementById('totalSpent').textContent=fmt(db2);
    var remEl=document.getElementById('remaining');remEl.textContent=fmt(rem);remEl.classList.toggle('negative',rem<0);
    var pct=tot>0?Math.min((db2/tot)*100,100):0;var fill=document.getElementById('progressFill');fill.style.width=pct+'%';fill.classList.toggle('over',rem<0);
    var user=queryOne("SELECT name FROM users WHERE id=?",[activeUserId]);document.getElementById('headerUser').textContent=user?user.name:'';
    var pillsC=document.getElementById('filterPills');pillsC.textContent='';
    var allTypes=['All','Food','Shopping','Bills','Transport','Health','Entertainment','Others','Income','Transfer'];var catCounts={All:expenses.length};
    expenses.forEach(function(e){var k=e.type==='credit'?'Income':(e.type==='transfer'?'Transfer':e.category);catCounts[k]=(catCounts[k]||0)+1;});
    allTypes.forEach(function(t){if(t!=='All'&&!catCounts[t])return;var p=el('div','filter-pill'+(activeFilter===t?' active':''));p.textContent=t+(catCounts[t]?' ('+catCounts[t]+')':'');p.dataset.filter=t;pillsC.appendChild(p);});
    var filtered=[],q=searchQuery.toLowerCase();for(var fi=expenses.length-1;fi>=0;fi--){var e=expenses[fi],eT=e.type==='credit'?'Income':(e.type==='transfer'?'Transfer':e.category);if(activeFilter!=='All'&&eT!==activeFilter)continue;if(q){var hay=(e.description+' '+(e.category||'')+' '+(e.bank||'')+' '+(e.transfer_to||'')).toLowerCase();if(hay.indexOf(q)===-1)continue;}filtered.push(e);}
    var list=document.getElementById('expenseList');list.textContent='';var countEl=document.getElementById('filterCount');
    if(!expenses.length){countEl.textContent='';var em=el('div','empty-state'),emi=el('div','empty-icon');emi.textContent='\u{1F4DD}';em.appendChild(emi);em.appendChild(document.createTextNode('No expenses yet'));list.appendChild(em);}
    else if(!filtered.length){countEl.textContent='No matches';var nm=el('div','empty-state');nm.appendChild(document.createTextNode('No matches'));list.appendChild(nm);}
    else{countEl.textContent=filtered.length+' of '+expenses.length;filtered.forEach(function(e){list.appendChild(createExpenseItem(e));});}
    document.getElementById('rolloverInfo').textContent=settings.rollover>0?'Includes '+fmt(settings.rollover)+' rolled over':'';
    var insS=document.getElementById('insightsSection');insS.textContent='';generateInsights(expenses,settings.budget).forEach(function(ins){var card=el('div','insight-card'+(ins.type==='alert'?' alert':ins.type==='good'?' good':''));var ic=el('span','insight-icon');ic.textContent=ins.icon;card.appendChild(ic);var txt=el('span','insight-text');txt.textContent=ins.text;card.appendChild(txt);var dis=el('button','insight-dismiss');dis.textContent='✕';dis.addEventListener('click',function(){card.style.display='none';});card.appendChild(dis);insS.appendChild(card);});
    renderBankStrip();var bankSel=document.getElementById('bankInput');if(bankSel)bankSel.value=DB.getDefaultBank();
  }

  function updatePreview(){
    var text=document.getElementById('smartInput').value,preview=document.getElementById('parsePreview');var parsed=parseSmartInput(text);currentParsed=parsed;
    if(!parsed){preview.classList.remove('visible');document.getElementById('catOverride').classList.remove('visible');return;}
    preview.classList.add('visible');document.getElementById('previewAmt').textContent=fmt(parsed.amount);document.getElementById('previewDesc').textContent=parsed.desc;
    var catChip=document.getElementById('previewCat');catChip.textContent='';
    if(parsed.isTransfer){catChip.className='parse-chip category cat-Others';catChip.appendChild(document.createTextNode('\u{1F504} Transfer'));}
    else if(isAmbiguousInput(parsed.desc)&&entryType==='expense'){catChip.className='parse-chip category cat-Others';catChip.appendChild(document.createTextNode('\u{1F914} Income or Expense?'));}
    else{catChip.className='parse-chip category cat-'+parsed.category;catChip.appendChild(document.createTextNode(ICONS[parsed.category]+' '+parsed.category+' '));if(parsed.source==='ai'||parsed.source==='keyword'||parsed.source==='learned'){var badge=el('span','ai-badge');badge.textContent=parsed.source==='learned'?'YOU':'AI';catChip.appendChild(badge);}}
    var bankChip=document.getElementById('previewBank'),bankSel=document.getElementById('bankInput');
    if(parsed.bank){bankChip.textContent='\u{1F3E6} '+parsed.bank;bankChip.style.display='';if(bankSel)bankSel.value=parsed.bank;}else{bankChip.style.display='none';}
    document.getElementById('catSelect').value=parsed.category;
  }

  function commitEntry(parsed,finalCat,type,bank,transferTo){
    if(type!=='transfer')DB.savePattern(parsed.desc,finalCat);
    DB.addExpense({amount:parsed.amount,desc:parsed.desc,category:finalCat,type:type,bank:bank||null,transferTo:transferTo||null});
    if(bank&&type==='expense')DB.updateBankBalance(bank,parsed.amount,true);if(bank&&type==='credit')DB.updateBankBalance(bank,parsed.amount,false);
    if(type==='transfer'&&bank&&transferTo){DB.updateBankBalance(bank,parsed.amount,true);DB.updateBankBalance(transferTo,parsed.amount,false);}
    document.getElementById('smartInput').value='';currentParsed=null;document.getElementById('parsePreview').classList.remove('visible');document.getElementById('catOverride').classList.remove('visible');
    var bs=document.getElementById('bankInput');if(bs)bs.value=DB.getDefaultBank();document.getElementById('smartInput').focus();render();
  }

  function addExpense(){
    var text=document.getElementById('smartInput').value.trim();if(!text)return;var parsed=currentParsed||parseSmartInput(text);if(!parsed||!parsed.amount||parsed.amount<=0)return;
    var ov=document.getElementById('catOverride'),finalCat=parsed.category;if(ov.classList.contains('visible'))finalCat=document.getElementById('catSelect').value;
    var bs=document.getElementById('bankInput'),dropBank=bs?bs.value:'';var bank=parsed.bank||dropBank||DB.getDefaultBank()||null;
    if(parsed.isTransfer){commitEntry(parsed,'Others','transfer',parsed.bank,parsed.transferTo);return;}
    if(entryType==='expense'&&isAmbiguousInput(parsed.desc)){pendingAmbiguous={parsed:parsed,category:finalCat,bank:bank};document.getElementById('ambiguityText').textContent='"'+parsed.desc+'" for '+fmt(parsed.amount)+' — income or expense?';openModal('ambiguityModal');return;}
    commitEntry(parsed,finalCat,entryType,bank,null);
  }

  function deleteExpense(id){var e=DB.getExpenseById(id);if(!e)return;if(e.bank){if(e.type==='expense')DB.updateBankBalance(e.bank,e.amount,false);else if(e.type==='credit')DB.updateBankBalance(e.bank,e.amount,true);else if(e.type==='transfer'){DB.updateBankBalance(e.bank,e.amount,false);if(e.transfer_to)DB.updateBankBalance(e.transfer_to,e.amount,true);}}DB.deleteExpense(id);render();}
  function getLeftover(){var s=DB.getSettings(),ex=DB.getExpenses(),cr=0,db2=0;ex.forEach(function(e){if(e.type==='credit')cr+=e.amount;else if(e.type!=='transfer')db2+=e.amount;});return Math.max(s.budget+cr-db2,0);}

  // Settings Modal
  function renderSettingsModal(){var list=document.getElementById('settingsBankList');list.textContent='';DB.getBanks().forEach(function(bank){var row=el('div','settings-bank-row');var ni=el('input','input');ni.type='text';ni.value=bank.name;ni.placeholder='Bank name';row.appendChild(ni);var bi=el('input','input');bi.type='number';bi.inputMode='decimal';bi.value=bank.balance;bi.placeholder='Balance';row.appendChild(bi);var rm=el('button','btn-remove-bank');rm.textContent='✕';rm.addEventListener('click',function(){row.remove();updateDefaultBankDropdown();});row.appendChild(rm);list.appendChild(row);});updateDefaultBankDropdown();}
  function updateDefaultBankDropdown(){var sel=document.getElementById('defaultBankSelect');sel.textContent='';var none=el('option');none.value='';none.textContent='None — always ask';sel.appendChild(none);document.querySelectorAll('#settingsBankList .settings-bank-row').forEach(function(row){var nm=row.querySelector('input').value.trim();if(nm){var o=el('option');o.value=nm;o.textContent=nm;sel.appendChild(o);}});sel.value=DB.getDefaultBank();}
  function saveSettingsFromModal(){var rows=document.querySelectorAll('#settingsBankList .settings-bank-row'),banks=[];rows.forEach(function(r){var inputs=r.querySelectorAll('input');var nm=inputs[0].value.trim(),bal=parseFloat(inputs[1].value)||0;if(nm)banks.push({name:nm,balance:bal});});DB.saveBanks(banks);DB.updateSettings({default_bank:document.getElementById('defaultBankSelect').value});renderBankSelect();render();closeModal('settingsModal');}
  function renderTransferSelects(){var banks=DB.getBanks();['transferFrom','transferTo'].forEach(function(id){var sel=document.getElementById(id);sel.textContent='';banks.forEach(function(b){var o=el('option');o.value=b.name;o.textContent=b.name+' ('+fmt(b.balance)+')';sel.appendChild(o);});});}
  function renderProfileList(){var list=document.getElementById('profileList');list.textContent='';DB.getUsers().forEach(function(u){var item=el('div','profile-item'+(u.id===activeUserId?' active':''));var av=el('div','profile-avatar');av.textContent=u.name.charAt(0).toUpperCase();item.appendChild(av);var nm=el('div','profile-name');nm.textContent=u.name;item.appendChild(nm);if(u.id===activeUserId){var chk=el('span','profile-check');chk.textContent='✓';item.appendChild(chk);}item.dataset.uid=u.id;list.appendChild(item);});}

  // Data Migration
  function migrateFromLocalStorage(){
    var oldData=null;try{var raw=localStorage.getItem('expenseTracker_v3');if(raw)oldData=JSON.parse(raw);}catch(e){}
    if(!oldData){try{var raw2=localStorage.getItem('expenseTracker_v2');if(raw2)oldData=JSON.parse(raw2);}catch(e){}}
    if(!oldData)return;
    if(oldData.budget)DB.updateSettings({budget:oldData.budget,rollover:oldData.rollover||0});
    var oldBanks=[];try{var bRaw=localStorage.getItem('expenseTracker_v3_banks');if(bRaw)oldBanks=JSON.parse(bRaw);}catch(e){}
    if(oldBanks.length)DB.saveBanks(oldBanks);
    try{var defBank=localStorage.getItem('expenseTracker_v3_defaultBank');if(defBank)DB.updateSettings({default_bank:defBank});}catch(e){}
    (oldData.expenses||[]).forEach(function(e){DB.addExpense({amount:e.amount,desc:e.desc||e.description||'',category:e.category||'Others',type:e.type||'expense',bank:e.bank||null,transferTo:e.transferTo||null});});
    try{var pRaw=localStorage.getItem('expenseTracker_v3_patterns')||localStorage.getItem('expenseTracker_v2_patterns');if(pRaw){var oldP=JSON.parse(pRaw);Object.keys(oldP).forEach(function(k){DB.savePattern(k,oldP[k].category);});}}catch(e){}
    ['expenseTracker_v3','expenseTracker_v3_banks','expenseTracker_v3_defaultBank','expenseTracker_v3_patterns','expenseTracker_v2','expenseTracker_v2_patterns'].forEach(function(k){localStorage.removeItem(k);});
  }

  // Init
  initSqlJs({locateFile:function(file){return 'https://sql.js.org/dist/'+file;}}).then(function(SQL){
    return idbGet(DB_STORE,'db').then(function(savedData){
      if(savedData)sqldb=new SQL.Database(savedData);else sqldb=new SQL.Database();
      SCHEMA.forEach(function(s){sqldb.run(s);});persistDB();
      return idbGet(META_STORE,'activeUserId').then(function(uid){
        var users=DB.getUsers();
        if(uid&&users.some(function(u){return u.id===uid;}))activeUserId=uid;
        else if(users.length>0)activeUserId=users[0].id;
        var hasOld=!!localStorage.getItem('expenseTracker_v3')||!!localStorage.getItem('expenseTracker_v2');
        if(!activeUserId){document.getElementById('loadingScreen').classList.add('hidden');openModal('onboardModal');return;}
        if(hasOld)migrateFromLocalStorage();
        document.getElementById('loadingScreen').classList.add('hidden');document.getElementById('appContainer').classList.remove('hidden');renderBankSelect();render();
      });
    });
  });

  // Event Listeners
  document.getElementById('onboardConfirm').addEventListener('click',function(){var name=document.getElementById('onboardName').value.trim();if(!name)return;activeUserId=DB.createUser(name);idbPut(META_STORE,'activeUserId',activeUserId);migrateFromLocalStorage();closeModal('onboardModal');document.getElementById('appContainer').classList.remove('hidden');renderBankSelect();render();});
  document.getElementById('onboardName').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('onboardConfirm').click();});
  document.getElementById('profileBtn').addEventListener('click',function(){renderProfileList();openModal('profileModal');});
  document.getElementById('profileClose').addEventListener('click',function(){closeModal('profileModal');});
  document.getElementById('profileList').addEventListener('click',function(e){var item=e.target.closest('.profile-item');if(!item)return;activeUserId=parseInt(item.dataset.uid,10);idbPut(META_STORE,'activeUserId',activeUserId);closeModal('profileModal');renderBankSelect();render();});
  document.getElementById('addProfileBtn').addEventListener('click',function(){var name=document.getElementById('newProfileName').value.trim();if(!name)return;activeUserId=DB.createUser(name);idbPut(META_STORE,'activeUserId',activeUserId);document.getElementById('newProfileName').value='';closeModal('profileModal');renderBankSelect();render();});
  document.getElementById('newProfileName').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('addProfileBtn').click();});
  document.getElementById('filterPills').addEventListener('click',function(e){var p=e.target.closest('.filter-pill');if(!p)return;activeFilter=p.dataset.filter;render();});
  var searchDebounce=null;document.getElementById('searchInput').addEventListener('input',function(){var self=this;clearTimeout(searchDebounce);searchDebounce=setTimeout(function(){searchQuery=self.value.trim();render();},200);});
  var debounceTimer=null;document.getElementById('smartInput').addEventListener('input',function(){clearTimeout(debounceTimer);debounceTimer=setTimeout(updatePreview,150);});
  document.getElementById('smartInput').addEventListener('keydown',function(e){if(e.key==='Enter')addExpense();});
  document.getElementById('addBtn').addEventListener('click',addExpense);
  document.getElementById('pillExpense').addEventListener('click',function(){entryType='expense';this.classList.add('active');document.getElementById('pillIncome').classList.remove('active');updatePreview();});
  document.getElementById('pillIncome').addEventListener('click',function(){entryType='credit';this.classList.add('active');document.getElementById('pillExpense').classList.remove('active');updatePreview();});
  document.getElementById('previewCat').addEventListener('click',function(){document.getElementById('catOverride').classList.toggle('visible');});
  document.getElementById('expenseList').addEventListener('click',function(e){var btn=e.target.closest('.btn-delete');if(btn)deleteExpense(parseInt(btn.dataset.id,10));});
  document.getElementById('resetBtn').addEventListener('click',function(){var lo=getLeftover();document.getElementById('confirmText').textContent=lo>0?'You have '+fmt(lo)+' remaining. It will roll over.':'No leftover. Starting fresh.';openModal('confirmModal');});
  document.getElementById('confirmYes').addEventListener('click',function(){closeModal('confirmModal');document.getElementById('salaryInput').value='';var lo=getLeftover();document.getElementById('salaryText').textContent=lo>0?'Rollover: '+fmt(lo)+'. Enter new salary.':'Enter your salary or budget.';openModal('salaryModal');setTimeout(function(){document.getElementById('salaryInput').focus();},300);});
  document.getElementById('confirmNo').addEventListener('click',function(){closeModal('confirmModal');});
  document.getElementById('salaryCancel').addEventListener('click',function(){closeModal('salaryModal');});
  document.getElementById('salaryConfirm').addEventListener('click',function(){var sal=parseFloat(document.getElementById('salaryInput').value);if(!sal||sal<=0)return;var lo=getLeftover();run("DELETE FROM expenses WHERE user_id=?",[activeUserId]);DB.updateSettings({budget:sal+lo,rollover:lo});var defBank=DB.getDefaultBank();if(defBank)DB.updateBankBalance(defBank,sal,false);closeModal('salaryModal');render();});
  document.getElementById('salaryInput').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('salaryConfirm').click();});
  document.getElementById('ambiguityIncome').addEventListener('click',function(){closeModal('ambiguityModal');if(pendingAmbiguous){commitEntry(pendingAmbiguous.parsed,'Others','credit',pendingAmbiguous.bank,null);pendingAmbiguous=null;}});
  document.getElementById('ambiguityExpense').addEventListener('click',function(){closeModal('ambiguityModal');if(pendingAmbiguous){commitEntry(pendingAmbiguous.parsed,pendingAmbiguous.category,'expense',pendingAmbiguous.bank,null);pendingAmbiguous=null;}});
  document.getElementById('transferBtn').addEventListener('click',function(){if(DB.getBanks().length<2){alert('Add at least 2 bank accounts in Settings.');return;}document.getElementById('transferAmount').value='';document.getElementById('transferNote').value='';renderTransferSelects();openModal('transferModal');setTimeout(function(){document.getElementById('transferAmount').focus();},300);});
  document.getElementById('transferCancel').addEventListener('click',function(){closeModal('transferModal');});
  document.getElementById('transferConfirm').addEventListener('click',function(){var amt=parseFloat(document.getElementById('transferAmount').value);if(!amt||amt<=0)return;var from=document.getElementById('transferFrom').value,to=document.getElementById('transferTo').value;if(!from||!to||from===to)return;var note=document.getElementById('transferNote').value.trim()||(from+' → '+to);commitEntry({amount:amt,desc:note},'Others','transfer',from,to);closeModal('transferModal');});
  document.getElementById('transferAmount').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('transferConfirm').click();});
  document.getElementById('settingsBtn').addEventListener('click',function(){renderSettingsModal();openModal('settingsModal');});
  document.getElementById('settingsCancel').addEventListener('click',function(){closeModal('settingsModal');});
  document.getElementById('settingsSave').addEventListener('click',saveSettingsFromModal);
  document.getElementById('addBankBtn').addEventListener('click',function(){var list=document.getElementById('settingsBankList'),row=el('div','settings-bank-row');var ni=el('input','input');ni.type='text';ni.placeholder='e.g. SBI H';row.appendChild(ni);var bi=el('input','input');bi.type='number';bi.inputMode='decimal';bi.placeholder='Balance';row.appendChild(bi);var rm=el('button','btn-remove-bank');rm.textContent='✕';rm.addEventListener('click',function(){row.remove();});row.appendChild(rm);list.appendChild(row);ni.focus();});
  document.getElementById('nukeBtn').addEventListener('click',function(){openModal('nukeModal');});
  document.getElementById('nukeCancel').addEventListener('click',function(){closeModal('nukeModal');});
  document.getElementById('nukeConfirm').addEventListener('click',function(){DB.nukeUser();activeFilter='All';searchQuery='';document.getElementById('searchInput').value='';closeModal('nukeModal');renderBankSelect();render();});
  document.querySelectorAll('.modal-overlay').forEach(function(ov){ov.addEventListener('click',function(e){if(e.target===ov)closeModal(ov.id);});});
})();
