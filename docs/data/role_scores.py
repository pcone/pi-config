#!/usr/bin/env python3
"""Combined role-fit scores (Orchestrator / Implementer / Oracle) for frontier
OpenRouter models, plus a cost score. Weights reflect user steering:
  Orchestrator = balanced (planning leads, execution counts) + IFBench + (Omniscience*)
  Implementer  = balanced blend (repo-SWE + self-contained coding) + IFBench
  Oracle       = math/algo focused (LiveCodeBench, IMO/HMMT, AIME)
Normalization: well-covered benchmarks -> min-max WITHIN the scored set (mode 'mm');
sparsely-reported benchmarks (IFBench, LiveCodeBench) -> raw %/100 ('raw') to avoid
tiny-sample min-max artifacts. Oracle uses a raw weighted-% composite. Cost = blended
$/M at 90/10 I/O + 98% cache. Missing data -> confidence flag.
(*) AA-Omniscience is unpublished for every value-tier model, so it's carried as an
informational column only, NOT in the composite.
"""
import json, os

# name: (AA_intelligence, AA_coding, AA_agentic, cost_per_M, ctx_K, multimodal)
CACHE = {
 "Claude Fable 5":(59.9,76.5,52.8,6.06,1000,True),"GPT-5.6 Sol":(58.9,77.4,54.0,3.53,1050,True),
 "Claude Opus 4.8":(55.7,74.3,47.2,3.03,1000,True),"GPT-5.6 Terra":(55.0,76.7,47.4,1.77,1050,True),
 "GPT-5.5":(54.8,74.9,44.9,3.53,1050,True),"Grok 4.5":(53.8,72.4,45.7,1.08,500,True),
 "Claude Opus 4.7":(53.5,73.6,44.4,3.03,1000,True),"Claude Sonnet 5":(53.4,71.5,46.7,1.21,1000,True),
 "GPT-5.4":(51.4,71.1,41.1,1.77,1050,True),"GPT-5.6 Luna":(51.2,71.4,45.6,0.71,1050,True),
 "GLM-5.2":(51.1,68.8,43.1,0.48,1048,False),"Gemini 3.5 Flash":(50.2,70.1,37.4,1.06,1048,True),
 "Claude Sonnet 4.6":(47.2,63.0,40.8,1.82,1000,True),"Gemini 3.1 Pro":(46.5,68.8,21.4,1.41,1048,True),
 "Qwen3.7 Max":(46.0,66.0,30.6,0.73,1000,False),"MiniMax-M3":(44.4,58.6,35.4,0.18,1048,True),
 "DeepSeek V4 Pro":(44.3,59.4,36.4,0.10,1048,False),"Kimi K2.6":(44.2,61.8,30.3,0.48,262,True),
 "MiMo-V2.5-Pro":(42.2,60.2,29.1,0.10,1048,False),"Kimi K2.7 Code":(41.9,60.8,29.6,0.49,262,True),
 "Hy3":(41.2,58.8,30.7,0.04,262,False),"Nex-N2-Pro":(41.0,59.1,31.0,0.13,262,True),
 "DeepSeek V4 Flash":(40.3,56.2,31.1,0.04,1048,False),"GLM-5.1":(40.2,55.8,29.9,0.48,202,False),
 "GPT-5.4 mini":(40.0,56.1,30.2,0.53,400,True),
}
MODELS=list(CACHE)
# NOTE: CACHE index 3 is a legacy 90/10 cost — IGNORED. Live cost is computed in COST[]
# from raw prices below at the I/O ratio knob (currently 95/5, per user's input-heavy load).

# ---- Pricing (raw $/token from model-tiers cache) & blended cost ----
CACHE_HIT=0.98; IN_RATIO=0.95; OUT_RATIO=0.05   # <-- I/O ratio knob
PRICES={  # name: (prompt, input_cache_read, completion)  $/token
 "Claude Fable 5":(1e-05,1e-06,5e-05),"GPT-5.6 Sol":(5e-06,5e-07,3e-05),
 "Claude Opus 4.8":(5e-06,5e-07,2.5e-05),"GPT-5.6 Terra":(2.5e-06,2.5e-07,1.5e-05),
 "GPT-5.5":(5e-06,5e-07,3e-05),"Grok 4.5":(2e-06,5e-07,6e-06),
 "Claude Opus 4.7":(5e-06,5e-07,2.5e-05),"Claude Sonnet 5":(2e-06,2e-07,1e-05),
 "GPT-5.4":(2.5e-06,2.5e-07,1.5e-05),"GPT-5.6 Luna":(1e-06,1e-07,6e-06),
 "GLM-5.2":(9.674e-07,1.7966e-07,3.0404e-06),"Gemini 3.5 Flash":(1.5e-06,1.5e-07,9e-06),
 "Claude Sonnet 4.6":(3e-06,3e-07,1.5e-05),"Gemini 3.1 Pro":(2e-06,2e-07,1.2e-05),
 "Qwen3.7 Max":(1.475e-06,2.95e-07,4.425e-06),"MiniMax-M3":(3e-07,6e-08,1.2e-06),
 "DeepSeek V4 Pro":(4.35e-07,3.625e-09,8.7e-07),"Kimi K2.6":(6.6e-07,1.44e-07,3.41e-06),
 "MiMo-V2.5-Pro":(4.35e-07,3.6e-09,8.7e-07),"Kimi K2.7 Code":(7.19e-07,1.49e-07,3.49e-06),
 "Hy3":(6.3e-08,2.1e-08,2.1e-07),"Nex-N2-Pro":(2.5e-07,2.5e-08,1e-06),
 "DeepSeek V4 Flash":(9.8e-08,2e-08,1.96e-07),"GLM-5.1":(9.66e-07,1.794e-07,3.036e-06),
 "GPT-5.4 mini":(7.5e-07,7.5e-08,4.5e-06),
}
def cost_per_M(m):
    pr,cr,co=PRICES[m]
    eff=(0.02*pr+CACHE_HIT*cr) if cr>0 else pr   # 2% miss @ prompt, 98% hit @ cache-read
    return (eff*IN_RATIO+co*OUT_RATIO)*1e6
COST={m:cost_per_M(m) for m in MODELS}

AA_LCR={"Claude Fable 5":70.0,"GPT-5.6 Sol":73.7,"Claude Opus 4.8":67.7,"GPT-5.6 Terra":74.0,
 "GPT-5.5":74.3,"Grok 4.5":67.7,"Claude Opus 4.7":70.3,"Claude Sonnet 5":70.7,"GPT-5.4":74.0,
 "GPT-5.6 Luna":74.0,"GLM-5.2":71.3,"Gemini 3.5 Flash":69.3,"Claude Sonnet 4.6":57.7,
 "Gemini 3.1 Pro":72.7,"Qwen3.7 Max":69.0,"MiniMax-M3":74.0,"DeepSeek V4 Pro":66.3,"Kimi K2.6":69.7,
 "MiMo-V2.5-Pro":73.3,"Kimi K2.7 Code":66.3,"Hy3":66.7,"Nex-N2-Pro":None,"DeepSeek V4 Flash":63.0,
 "GLM-5.1":62.3,"GPT-5.4 mini":69.3}
TB2={"Claude Fable 5":84.3,"GPT-5.6 Sol":91.9,"Claude Opus 4.8":74.6,"GPT-5.6 Terra":87.4,
 "GPT-5.5":82.0,"Grok 4.5":83.3,"Claude Opus 4.7":69.4,"Claude Sonnet 5":80.4,"GPT-5.4":None,
 "GPT-5.6 Luna":84.7,"GLM-5.2":81.0,"Gemini 3.5 Flash":76.2,"Claude Sonnet 4.6":None,
 "Gemini 3.1 Pro":80.2,"Qwen3.7 Max":69.7,"MiniMax-M3":66.0,"DeepSeek V4 Pro":67.9,"Kimi K2.6":66.7,
 "MiMo-V2.5-Pro":68.4,"Kimi K2.7 Code":None,"Hy3":54.4,"Nex-N2-Pro":None,"DeepSeek V4 Flash":56.9,
 "GLM-5.1":None,"GPT-5.4 mini":None}
SWE_PRO={"Claude Fable 5":80.0,"GPT-5.6 Sol":64.6,"Claude Opus 4.8":69.2,"GPT-5.6 Terra":63.4,
 "GPT-5.5":58.6,"Grok 4.5":64.7,"Claude Opus 4.7":64.3,"Claude Sonnet 5":63.2,"GPT-5.4":57.7,
 "GPT-5.6 Luna":62.7,"GLM-5.2":62.1,"Gemini 3.5 Flash":55.1,"Claude Sonnet 4.6":None,
 "Gemini 3.1 Pro":None,"Qwen3.7 Max":60.6,"MiniMax-M3":59.0,"DeepSeek V4 Pro":55.4,"Kimi K2.6":58.6,
 "MiMo-V2.5-Pro":57.2,"Kimi K2.7 Code":None,"Hy3":None,"Nex-N2-Pro":None,"DeepSeek V4 Flash":52.6,
 "GLM-5.1":58.4,"GPT-5.4 mini":None}
SWE_VER={"Claude Fable 5":95.0,"GPT-5.6 Sol":None,"Claude Opus 4.8":88.6,"GPT-5.6 Terra":None,
 "GPT-5.5":88.7,"Grok 4.5":86.6,"Claude Opus 4.7":87.6,"Claude Sonnet 5":85.2,"GPT-5.4":None,
 "GPT-5.6 Luna":None,"GLM-5.2":None,"Gemini 3.5 Flash":78.8,"Claude Sonnet 4.6":79.6,
 "Gemini 3.1 Pro":80.6,"Qwen3.7 Max":80.4,"MiniMax-M3":80.5,"DeepSeek V4 Pro":80.6,"Kimi K2.6":80.2,
 "MiMo-V2.5-Pro":None,"Kimi K2.7 Code":None,"Hy3":74.4,"Nex-N2-Pro":None,"DeepSeek V4 Flash":79.0,
 "GLM-5.1":None,"GPT-5.4 mini":None}
IFBENCH={"Qwen3.7 Max":79.1,"Gemini 3.5 Flash":76.3,"MiniMax-M3":82.9,"Hy3":63.1}  # sparse
OMNISCIENCE={"Claude Fable 5":40.0,"Gemini 3.1 Pro":32.9,"Claude Opus 4.8":27.0}  # informational only
AA_INT={m:CACHE[m][0] for m in MODELS}; AA_COD={m:CACHE[m][1] for m in MODELS}
AA_AGT={m:CACHE[m][2] for m in MODELS}

# Oracle math/algo
LCB={"DeepSeek V4 Pro":93.5,"DeepSeek V4 Flash":91.6,"Qwen3.7 Max":91.6}
HARDMATH={"DeepSeek V4 Pro":89.8,"DeepSeek V4 Flash":88.4}
AIME={"GLM-5.2":99.2,"Kimi K2.6":96.4,"GLM-5.1":95.3}
CODEFORCES={"DeepSeek V4 Pro":3206,"DeepSeek V4 Flash":3052}

# role weights: (dict, weight, mode)  mode 'mm'=min-max in-set, 'raw'=value/100
MINMAX_ROLES={
 "Orchestrator":[(AA_LCR,5,'mm'),(AA_INT,5,'mm'),(IFBENCH,4,'raw'),(TB2,4,'mm'),
                 (SWE_PRO,3,'mm'),(AA_AGT,3,'mm')],
 "Implementer": [(SWE_PRO,5,'mm'),(LCB,5,'raw'),(AA_COD,4,'mm'),(SWE_VER,3,'mm'),
                 (TB2,3,'mm'),(IFBENCH,2,'raw')],
 # Adversarial review, split into two passes. Decorrelation from the implementer is a
 # separate flag (see LAB), not a score term.
 # review-code  = comprehension-tilt: find bugs in the implementation (code first).
 # review-tests = reasoning-tilt: find coverage gaps / weak or tautological tests.
 "Review-Code":  [(AA_COD,5,'mm'),(AA_INT,4,'mm'),(IFBENCH,4,'raw'),(AA_LCR,3,'mm'),(SWE_PRO,3,'mm')],
 "Review-Tests": [(AA_INT,5,'mm'),(IFBENCH,4,'raw'),(AA_LCR,4,'mm'),(AA_COD,3,'mm'),(SWE_PRO,2,'mm')],
}
GRANULAR={"Orchestrator":[AA_LCR,TB2,SWE_PRO,IFBENCH],"Implementer":[SWE_PRO,SWE_VER,TB2,LCB],
 "Review-Code":[AA_LCR,SWE_PRO,IFBENCH],"Review-Tests":[AA_LCR,SWE_PRO,IFBENCH]}
LAB={"Claude Fable 5":"Anthropic","GPT-5.6 Sol":"OpenAI","Claude Opus 4.8":"Anthropic",
 "GPT-5.6 Terra":"OpenAI","GPT-5.5":"OpenAI","Grok 4.5":"xAI","Claude Opus 4.7":"Anthropic",
 "Claude Sonnet 5":"Anthropic","GPT-5.4":"OpenAI","GPT-5.6 Luna":"OpenAI","GLM-5.2":"Zhipu",
 "Gemini 3.5 Flash":"Google","Claude Sonnet 4.6":"Anthropic","Gemini 3.1 Pro":"Google",
 "Qwen3.7 Max":"Alibaba","MiniMax-M3":"MiniMax","DeepSeek V4 Pro":"DeepSeek","Kimi K2.6":"Moonshot",
 "MiMo-V2.5-Pro":"Xiaomi","Kimi K2.7 Code":"Moonshot","Hy3":"?","Nex-N2-Pro":"?",
 "DeepSeek V4 Flash":"DeepSeek","GLM-5.1":"Zhipu","GPT-5.4 mini":"OpenAI"}
IMPL_LAB="DeepSeek"  # the implementer's lab -> reviewer should differ for decorrelation
ORACLE_W=[(LCB,5),(HARDMATH,4),(AIME,3)]
# Value-tier membership is FIXED (the cost-conscious set the user endorsed: <=$1.10/M at
# 90/10, flagships excluded). Pinned so changing the I/O ratio doesn't re-admit flagships.
EXCLUDE={"Claude Fable 5","GPT-5.6 Sol","Claude Opus 4.8","GPT-5.6 Terra","GPT-5.5",
 "Claude Opus 4.7","Claude Sonnet 5","GPT-5.4","Gemini 3.1 Pro","Claude Sonnet 4.6"}
VALUE=[m for m in MODELS if m not in EXCLUDE]

def minmax(d,subset):
    vals=[d[m] for m in subset if d.get(m) is not None]; lo,hi=min(vals),max(vals); rng=hi-lo or 1.0
    return {m:(None if d.get(m) is None else (d[m]-lo)/rng) for m in subset}

def score_role(bmks,subset):
    norm=[]
    for d,w,mode in bmks:
        nb=minmax(d,subset) if mode=='mm' else {m:(None if d.get(m) is None else d[m]/100.0) for m in subset}
        norm.append((nb,w))
    out={}
    for m in subset:
        num=den=0.0
        for nb,w in norm:
            if nb[m] is not None: num+=nb[m]*w; den+=w
        out[m]=(num/den*100 if den else None)
    return out

def score_oracle(subset):
    out={}
    for m in subset:
        num=den=0.0
        for b,w in ORACLE_W:
            if m in b: num+=b[m]*w; den+=w
        out[m]=(num/den if den else None)
    return out

def conf_oi(m,role):
    g=GRANULAR[role]; present=sum(1 for b in g if b.get(m) is not None); total=len(g)
    if present==0: return f"proxy (0/{total})"
    if present<=total//3: return f"partial ({present}/{total})"
    return f"solid ({present}/{total})"

def conf_oracle(m):
    if m in LCB or m in HARDMATH: return "solid (hard/algo)"
    if m in AIME: return "aime-only"
    return "proxy (0 math/algo)"

def compute(subset):
    r={role:score_role(b,subset) for role,b in MINMAX_ROLES.items()}
    r["Oracle"]=score_oracle(subset); return r

vres=compute(VALUE); fres=compute(MODELS)

def f(x): return f"{x:6.1f}" if x is not None else "   -- "
def table(res,subset,title):
    print(f"\n=== {title} ===")
    print(f"{'MODEL':<20}{'ORCH':>7}{'IMPL':>7}{'ORAC':>7}{'$/M':>7}  {'ctx':>5}  conf(orch/impl/oracle)")
    for m in sorted(subset,key=lambda m:-(res['Orchestrator'][m] or -1)):
        print(f"{m:<20}{f(res['Orchestrator'][m]):>7}{f(res['Implementer'][m]):>7}"
              f"{f(res['Oracle'][m]):>7}{COST[m]:>7.3f}  {CACHE[m][4]:>4}K  "
              f"{conf_oi(m,'Orchestrator')} | {conf_oi(m,'Implementer')} | {conf_oracle(m)}")

def oracle_detail(subset):
    print(f"\n=== ORACLE math/algo detail (value tier) ===")
    print(f"{'MODEL':<20}{'LCB':>6}{'IMO/HMMT':>9}{'AIME':>6}{'CForces':>8}{'SCORE':>7}  conf")
    sc=score_oracle(subset)
    for m in sorted([x for x in subset if sc[x] is not None],key=lambda m:-sc[m]):
        print(f"{m:<20}{f(LCB.get(m)):>6}{f(HARDMATH.get(m)):>9}{f(AIME.get(m)):>6}"
              f"{str(CODEFORCES.get(m,'--')):>8}{sc[m]:>7.1f}  {conf_oracle(m)}")
    print(f"  unknown (no math/algo eval): {', '.join(m for m in subset if sc[m] is None)}")

def reviewer_view(subset):
    print(f"\n=== ADVERSARIAL REVIEW (review-code / review-tests) — value tier ===")
    print(f"{'MODEL':<18}{'R-CODE':>7}{'R-TEST':>7}{'$/M':>7}  {'ctx':>5}  {'lab':<9} decorr")
    res=vres if subset is VALUE else fres
    key=lambda m:-((res['Review-Code'][m] or -1)+(res['Review-Tests'][m] or -1))
    for m in sorted(subset,key=key):
        decorr='same-lab ✗' if LAB[m]==IMPL_LAB else 'ok ✓'
        print(f"{m:<18}{f(res['Review-Code'][m]):>7}{f(res['Review-Tests'][m]):>7}{COST[m]:>7.3f}  "
              f"{CACHE[m][4]:>4}K  {LAB[m]:<9} {decorr}")

table(vres,VALUE,f"PRIMARY: value tier, {len(VALUE)} cost-conscious models (flagships excluded) @ {int(IN_RATIO*100)}/{int(OUT_RATIO*100)} I/O")
reviewer_view(VALUE)
oracle_detail(VALUE)
table(fres,MODELS,f"APPENDIX: full frontier, all {len(MODELS)} models")

def pack(res,subset):
    return {m:{"orchestrator":res['Orchestrator'][m],"implementer":res['Implementer'][m],
        "oracle":res['Oracle'][m],"review_code":res['Review-Code'][m],"review_tests":res['Review-Tests'][m],
        "cost_per_M":COST[m],"ctx_K":CACHE[m][4],"multimodal":CACHE[m][5],"lab":LAB[m],
        "decorrelated_from_impl":LAB[m]!=IMPL_LAB,"aa_int":CACHE[m][0],"aa_cod":CACHE[m][1],
        "aa_agt":CACHE[m][2],"ifbench":IFBENCH.get(m),"omniscience":OMNISCIENCE.get(m),"lcb":LCB.get(m),
        "hardmath":HARDMATH.get(m),"aime":AIME.get(m),"codeforces":CODEFORCES.get(m),
        "conf_orch":conf_oi(m,'Orchestrator'),"conf_impl":conf_oi(m,'Implementer'),
        "conf_oracle":conf_oracle(m),"conf_review":conf_oi(m,'Review-Code')} for m in subset}
_out=os.path.join(os.path.dirname(os.path.abspath(__file__)),'role_scores.json')
json.dump({"value_tier":pack(vres,VALUE),"full":pack(fres,MODELS)},open(_out,'w'),indent=2)
print(f"\nwrote {_out}")
