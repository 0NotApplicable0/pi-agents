import subprocess, json, os, tempfile, time, sys, statistics
HERE=os.path.dirname(os.path.abspath(__file__))
STORE=os.path.join(HERE,"..","..","src","collab","store.ts")
ITERS=int(os.environ.get("ITERS","20"))
out=[]
for N in [10,25,50,100]:
    root=tempfile.mkdtemp(prefix=f"procs-{N}-")
    # seed members and the shared board entry
    subprocess.run(["bun","-e",f"""
import {{ CollabStore }} from "{STORE}";
const s=new CollabStore("{root}","main");
for(let i=0;i<{N};i++) s.upsertMember({{key:`agent-${{i}}`,agentId:`${{i}}`,name:`a${{i}}`,role:"r",group:"main",cwd:"/r",joinedAt:0,updatedAt:Date.now(),state:"working",status:"live"}});
s.post({{id:"shared",kind:"todo",title:"t",body:"",refs:[],author:"agent-0",authorName:"a0"}});
"""],check=True)
    start=int(time.time()*1000)+3000+N*40
    t0=time.time()
    procs=[subprocess.Popen(["bun",os.path.join(HERE,"worker.ts"),root,str(i),str(ITERS),str(start)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for i in range(N)]
    res=[]
    for p in procs:
        o,e=p.communicate(); 
        try: res.append(json.loads(o.strip().splitlines()[-1]))
        except Exception: res.append({"lat":[],"timeouts":0,"hot":0,"errors":1,"crash":e[-300:]})
    wall=time.time()-max(t0,start/1000)
    lat=sorted(x for r in res for x in r["lat"])
    p=lambda q: lat[min(len(lat)-1,int(q*len(lat)))] if lat else 0
    # correctness
    # read back through the store, whichever backend it uses
    state=json.loads(subprocess.run(["bun","-e",f"""
import {{ CollabStore }} from "{STORE}";
const s=new CollabStore("{root}","main");
console.log(JSON.stringify({{kind:s.kind,claims:s.claims(),history:s.entry("shared")?.history.length??0}}));
"""],check=True,capture_output=True,text=True).stdout.strip().splitlines()[-1])
    claims=state["claims"]
    uniq=[c for c in claims if c["resource"].startswith("path:u")]
    hist=state["history"]
    # mutual exclusion of hot.js: timestamps across processes (a few µs of
    # clock skew can show as overlap), and an O_EXCL marker file (exact)
    ev=[l.split() for l in open(f"{root}/hot.log")] if os.path.exists(f"{root}/hot.log") else []
    holders=0; overlap=0
    for kind,_,_ in sorted(ev,key=lambda x:int(x[2])):
        holders += 1 if kind=="A" else -1
        overlap=max(overlap,holders)
    row=dict(store=state["kind"],N=N,iters=ITERS,cycles=N*ITERS,wall_s=round(wall,1),cycles_per_s=round(N*ITERS/wall,1),p50_ms=round(p(.5),1),p95_ms=round(p(.95),1),max_ms=round(lat[-1],1) if lat else 0,
             timeouts=sum(r["timeouts"] for r in res),errors=sum(r["errors"] for r in res),unique_claims_kept=f"{len(uniq)}/{N*ITERS}",
             board_history=f"{hist}/{N*ITERS}",hot_grants=sum(r["hot"] for r in res),max_concurrent_hot_holders=overlap,exclusive_violations=sum(r.get("violations",0) for r in res))
    print(json.dumps(row)); out.append(row); sys.stdout.flush()
json.dump(out,open(os.environ.get("OUT","/tmp/procs.json"),"w"),indent=1)
