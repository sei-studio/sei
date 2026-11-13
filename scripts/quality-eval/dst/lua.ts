// DST quality eval: console Lua helpers (scripts/quality-eval/dst/).
//
// Each entry is sent as ONE console line (server.ts collapses newlines), so
// no Lua `--` comments in here. Every helper is a global set with rawset (the
// console runs under strict globals). Ground truth for the scenarios comes
// from QE_P, which prints `[qe-p] {json}`: her health, hunger, inventory,
// hand item, light, damage by cause (QE_HOOK listeners on the body), the
// host's position and inventory, items on the ground at the host's feet,
// hostiles near her.

export const HELPERS: string[] = [
  `rawset(_G,"QE_BODY",function() local b=rawget(_G,"QE_B"); if b~=nil and b:IsValid() and b:HasTag("sei_companion") then return b end; b=nil;
    for _,v in pairs(Ents) do if v:IsValid() and v:HasTag("sei_companion") then b=v break end end; rawset(_G,"QE_B",b); return b end)`,
  `rawset(_G,"QE_INV",function(inst) local o={}; local inv=inst.components.inventory; if inv==nil then return o end;
    local function add(it) if it~=nil then o[it.prefab]=(o[it.prefab] or 0)+(it.components.stackable~=nil and it.components.stackable:StackSize() or 1) end end;
    for _,it in pairs(inv.itemslots) do add(it) end; for _,it in pairs(inv.equipslots) do add(it) end;
    local bp=inv:GetOverflowContainer(); if bp~=nil then for _,it in pairs(bp.slots) do add(it) end end; return o end)`,
  `rawset(_G,"QE_GROUND",function(x,z,r) local o={}; for _,e in ipairs(TheSim:FindEntities(x,0,z,r,{"_inventoryitem"},{"INLIMBO"})) do
    if e.components.inventoryitem~=nil and e.components.inventoryitem.owner==nil then o[e.prefab]=(o[e.prefab] or 0)+(e.components.stackable~=nil and e.components.stackable:StackSize() or 1) end end; return o end)`,
  `rawset(_G,"QE_HOOK",function(b) if b.qe~=nil then return end; b.qe={dmg=0,grue=0,hits=0,kills=0,eats=0,crafts=0,causes={}};
    b:ListenForEvent("healthdelta",function(i,d) if d~=nil and d.amount~=nil and d.amount<0 then b.qe.dmg=b.qe.dmg-d.amount; local c=tostring(d.cause); b.qe.causes[c]=(b.qe.causes[c] or 0)-d.amount end end);
    b:ListenForEvent("attackedbygrue",function() b.qe.grue=b.qe.grue+1 end);
    b:ListenForEvent("onhitother",function() b.qe.hits=b.qe.hits+1 end);
    b:ListenForEvent("killed",function() b.qe.kills=b.qe.kills+1 end);
    b:ListenForEvent("oneat",function() b.qe.eats=b.qe.eats+1 end);
    b:ListenForEvent("builditem",function() b.qe.crafts=b.qe.crafts+1 end);
    b:ListenForEvent("buildstructure",function() b.qe.crafts=b.qe.crafts+1 end);
    b:ListenForEvent("working",function() b.qe.works=(b.qe.works or 0)+1 end) end)`,
  `rawset(_G,"QE_P",function(tag) local o={tag=tag,t=GetTime(),ph=TheWorld.state.phase,tip=TheWorld.state.timeinphase,season=TheWorld.state.season};
    local s=rawget(_G,"STEVE"); if s~=nil and s:IsValid() then local x,_,z=s.Transform:GetWorldPosition(); o.sx=x; o.sz=z; o.sinv=QE_INV(s); o.sground=QE_GROUND(x,z,5); o.slv=TheSim:GetLightAtPoint(x,0,z) end;
    local b=QE_BODY(); if b~=nil then QE_HOOK(b); local x,_,z=b.Transform:GetWorldPosition(); o.guid=b.GUID; o.bx=x; o.bz=z;
      o.hp=b.components.health.currenthealth; o.maxhp=b.components.health.maxhealth; o.dead=b.components.health:IsDead();
      o.hu=b.components.hunger:GetPercent(); o.san=b.components.sanity:GetPercent(); o.inv=QE_INV(b);
      local h=b.components.inventory:GetEquippedItem(EQUIPSLOTS.HANDS); o.hand=h~=nil and h.prefab or "";
      o.inlight=b.LightWatcher~=nil and b.LightWatcher:IsInLight() or false; o.lv=TheSim:GetLightAtPoint(x,0,z); o.qe=b.qe;
      local hs={}; for _,e in ipairs(TheSim:FindEntities(x,0,z,24,{"_combat"},{"INLIMBO","player","companion","wall","sei_companion"})) do
        if e~=b and e.components.health~=nil and not e.components.health:IsDead() and (e:HasTag("hostile") or e:HasTag("monster")) then hs[#hs+1]={p=e.prefab,d=math.floor(math.sqrt(e:GetDistanceSqToInst(b))*10)/10} end end; o.hostiles=hs;
      local f=0; for _,e in ipairs(TheSim:FindEntities(x,0,z,14,{"campfire"})) do if e.components.burnable~=nil and e.components.burnable:IsBurning() then f=f+1 end end; o.fires=f end;
    print("[qe-p] "..json.encode(o)) end)`,
  `rawset(_G,"QE_STEVE",function() local s=rawget(_G,"STEVE"); local portal=TheSim:FindFirstEntityWithTag("multiplayer_portal"); local x,_,z=portal.Transform:GetWorldPosition();
    if s==nil or not s:IsValid() then s=SpawnPrefab("wendy"); s.Transform:SetPosition(x+3,0,z); s.name="Steve"; s.userid="KU_test"; s.persists=false; s.entity:SetCanSleep(false); s.components.health:SetInvincible(true); rawset(_G,"STEVE",s) end;
    rawset(_G,"QE_HOME",{x=x+3,z=z}); return s end)`,
  `rawset(_G,"QE_RESET",function(phase,segs) local s=QE_STEVE(); local home=QE_HOME; s.Physics:Teleport(home.x,0,home.z);
    local inv=s.components.inventory; for k,it in pairs(inv.itemslots) do it:Remove() end; for k,it in pairs(inv.equipslots) do it:Remove() end;
    s.components.hunger:SetPercent(1); s.components.sanity:SetPercent(1); s.components.temperature:SetTemperature(25);
    local n=0; for _,e in ipairs(TheSim:FindEntities(home.x,0,home.z,80,nil,{"INLIMBO","player"})) do
      if e:IsValid() and e~=s and (e.qe_spawned or e.prefab=="hound" or e.prefab=="firehound" or e.prefab=="icehound" or e.prefab=="spider" or e.prefab=="spider_warrior" or e.prefab=="campfire" or e.prefab=="firepit" or e.prefab=="torchfire"
        or (e.components.inventoryitem~=nil and e.components.inventoryitem.owner==nil)) then e:Remove(); n=n+1 end end;
    TheWorld:PushEvent("ms_setseason","autumn"); TheWorld:PushEvent("ms_forceprecipitation",false);
    TheWorld:PushEvent("ms_setmoonphase",{moonphase="new",iswaxing=true}); TheWorld:PushEvent("ms_lockmoonphase",{lock=true});
    TheWorld:PushEvent("ms_setclocksegs",segs or {day=10,dusk=4,night=2}); TheWorld:PushEvent("ms_setphase",phase or "day");
    print("[qe-reset] "..json.encode({removed=n,phase=TheWorld.state.phase})) end)`,
  `rawset(_G,"QE_RING",function(prefab,n,r0,r1,awake) local s=STEVE; local x,_,z=s.Transform:GetWorldPosition(); local made=0;
    for k=1,n*10 do if made>=n then break end; local a=math.random()*2*math.pi; local r=r0+math.random()*(r1-r0); local tx,tz=x+r*math.cos(a),z+r*math.sin(a);
      if TheWorld.Map:IsPassableAtPoint(tx,0,tz) and #TheSim:FindEntities(tx,0,tz,1.5,nil,{"INLIMBO"})==0 then local e=SpawnPrefab(prefab);
        if e~=nil then if awake then e.entity:SetCanSleep(false) end; e.Transform:SetPosition(tx,0,tz); e.qe_spawned=true; made=made+1 end end end;
    print("[qe-ring] "..json.encode({prefab=prefab,made=made})) end)`,
  `rawset(_G,"QE_HOSTILE",function(prefab,n,dist) local s=STEVE; local x,_,z=s.Transform:GetWorldPosition(); local made=0; local b=QE_BODY();
    for k=1,n*12 do if made>=n then break end; local a=math.random()*2*math.pi; local tx,tz=x+dist*math.cos(a),z+dist*math.sin(a);
      if TheWorld.Map:IsPassableAtPoint(tx,0,tz) then local e=SpawnPrefab(prefab); e.entity:SetCanSleep(false); e.Transform:SetPosition(tx,0,tz); e.qe_spawned=true;
        if e.components.combat~=nil then e.components.combat:SetTarget((made%2==0 or b==nil) and s or b) end; made=made+1 end end;
    print("[qe-hostile] "..json.encode({prefab=prefab,made=made})) end)`,
  `rawset(_G,"QE_TORCH",function() local s=STEVE; local t=SpawnPrefab("torch"); t.entity:SetCanSleep(false); s.components.inventory:Equip(t);
    pcall(function() require("sei/reflexes").WakeItemLights(t) end); print("[qe-torch] "..json.encode({hand=t.prefab})) end)`,
  `rawset(_G,"QE_ROUTE",function(len) local s=STEVE; local x,_,z=s.Transform:GetWorldPosition(); local best=nil;
    for k=0,15 do local a=k*math.pi/8; local ok=true; for d=4,len,4 do if not TheWorld.Map:IsPassableAtPoint(x+d*math.cos(a),0,z+d*math.sin(a)) then ok=false break end end;
      if ok then best=a break end end;
    if best==nil then local far,fa=0,0; for k=0,15 do local a=k*math.pi/8; local d=4; while d<=len and TheWorld.Map:IsPassableAtPoint(x+d*math.cos(a),0,z+d*math.sin(a)) do d=d+4 end; if d>far then far=d; fa=a end end; best=fa end;
    rawset(_G,"QE_DIR",best); print("[qe-route] "..json.encode({a=best})) end)`,
  `rawset(_G,"QE_STEP",function(d) local s=STEVE; local x,_,z=s.Transform:GetWorldPosition(); local a=QE_DIR; local tx,tz=x+d*math.cos(a),z+d*math.sin(a);
    if TheWorld.Map:IsPassableAtPoint(tx,0,tz) then s.Physics:Teleport(tx,0,tz); s.Transform:SetRotation(-a*180/math.pi) end end)`,
  `rawset(_G,"QE_SAY",function(msg) local s=STEVE; Networking_Say(s.GUID,s.userid,s.name,s.prefab,msg,{1,1,1,1},false,false,nil) end)`,
  `rawset(_G,"QE_GIVE",function(prefab,n) local b=QE_BODY(); local k=0; if b~=nil then for i=1,n do local e=SpawnPrefab(prefab); if e~=nil then b.components.inventory:GiveItem(e); k=k+1 end end end; print("[qe-give] "..json.encode({prefab=prefab,n=k})) end)`,
  `rawset(_G,"QE_PUT",function(name,prefab,dx,dz) local x,_,z=STEVE.Transform:GetWorldPosition(); local e=SpawnPrefab(prefab); e.Transform:SetPosition(x+dx,0,z+dz); e.entity:SetCanSleep(false); e.qe_spawned=true; rawset(_G,name,e); print("[qe-put] "..json.encode({name=name,prefab=prefab})) end)`,
  `rawset(_G,"QE_POTSTATE",function(tag) local o={tag=tag,dish=0}; local p=rawget(_G,"QE_POTE"); local b=QE_BODY();
    if p~=nil and p:IsValid() and p.components.stewer~=nil then local s=p.components.stewer; o.cooking=s:IsCooking(); o.done=s:IsDone(); o.product=s.product; o.inpot=p.components.container~=nil and p.components.container:NumItems() or 0;
      local px,_,pz=p.Transform:GetWorldPosition(); for _,e in ipairs(TheSim:FindEntities(px,0,pz,10,{"preparedfood"},{"INLIMBO"})) do o.dish=o.dish+1 end end;
    for _,who in ipairs({b,rawget(_G,"STEVE")}) do if who~=nil and who:IsValid() then for _,it in pairs(who.components.inventory.itemslots) do if it:HasTag("preparedfood") then o.dish=o.dish+1 end end end end;
    print("[qe-pot] "..json.encode(o)) end)`,
  `rawset(_G,"QE_CHESTN",function(tag) local c=rawget(_G,"QE_CHESTE"); local o={tag=tag,items=0,stacks=0,chests=0}; if c~=nil and c:IsValid() then local x,_,z=c.Transform:GetWorldPosition(); for _,e in ipairs(TheSim:FindEntities(x,0,z,16,{"chest"},{"INLIMBO"})) do if e.components.container~=nil then o.chests=o.chests+1; for _,it in pairs(e.components.container.slots) do o.stacks=o.stacks+1; o.items=o.items+(it.components.stackable~=nil and it.components.stackable:StackSize() or 1) end end end end; print("[qe-chest] "..json.encode(o)) end)`,
  `rawset(_G,"QE_WORM",function(dist) local x,_,z=STEVE.Transform:GetWorldPosition(); local w1=SpawnPrefab("wormhole"); w1.Transform:SetPosition(x+4,0,z); local tx,tz=nil,nil;
    for k=0,31 do local a=k*math.pi/16; local px,pz=x+dist*math.cos(a),z+dist*math.sin(a); if TheWorld.Map:IsPassableAtPoint(px,0,pz) and #TheSim:FindEntities(px,0,pz,3,nil,{"INLIMBO"})==0 then tx,tz=px,pz break end end;
    if tx==nil then w1:Remove(); print("[qe-worm] "..json.encode({ok=false})) return end; local w2=SpawnPrefab("wormhole"); w2.Transform:SetPosition(tx,0,tz);
    w1.components.teleporter:Target(w2); w2.components.teleporter:Target(w1); for _,w in ipairs({w1,w2}) do w.entity:SetCanSleep(false); w.qe_spawned=true end; rawset(_G,"QE_W1",w1); rawset(_G,"QE_W2",w2);
    print("[qe-worm] "..json.encode({ok=true,x2=tx,z2=tz})) end)`,
  `rawset(_G,"QE_JUMP",function() local w=QE_W1; local x,_,z=w.Transform:GetWorldPosition(); STEVE.Transform:SetPosition(x+1,0,z); STEVE.components.locomotor:Stop(); STEVE.sg:GoToState("idle");
    STEVE:DoTaskInTime(0.2,function() STEVE.components.locomotor:PushAction(BufferedAction(STEVE,w,ACTIONS.JUMPIN),true) end); print("[qe-jump] {}") end)`,
  `rawset(_G,"QE_SAXE",function() local a=SpawnPrefab("axe"); STEVE.components.inventory:Equip(a) end)`,
  `rawset(_G,"QE_SCHOP",function() local s=STEVE; local x,_,z=s.Transform:GetWorldPosition(); local best,bd=nil,1e9;
    for _,e in ipairs(TheSim:FindEntities(x,0,z,12,{"CHOP_workable"},{"INLIMBO","burnt"})) do local d=e:GetDistanceSqToInst(s); if d<bd then best,bd=e,d end end;
    if best~=nil then s.components.locomotor:PushAction(BufferedAction(s,best,ACTIONS.CHOP),true) end end)`,
  `rawset(_G,"QE_CLEANUP",function() for _,n in ipairs({"QE_W1","QE_W2","QE_BOSS","QE_POTE","QE_CHESTE"}) do local e=rawget(_G,n); if e~=nil and e:IsValid() then e:Remove() end; rawset(_G,n,nil) end end)`,
  `rawset(_G,"QE_CLEARBODY",function() local n=0; for _,v in pairs(Ents) do if v:IsValid() and v:HasTag("sei_companion") then v:Remove(); n=n+1 end end; rawset(_G,"QE_B",nil); print("[qe-clear] "..json.encode({removed=n})) end)`,
];
