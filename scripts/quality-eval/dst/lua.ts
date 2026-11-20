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
    b:ListenForEvent("buildstructure",function() b.qe.crafts=b.qe.crafts+1 end) end)`,
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
  `rawset(_G,"QE_CLEARBODY",function() local n=0; for _,v in pairs(Ents) do if v:IsValid() and v:HasTag("sei_companion") then v:Remove(); n=n+1 end end; rawset(_G,"QE_B",nil); print("[qe-clear] "..json.encode({removed=n})) end)`,
];
