/** Release-only, read-only GitHub proof. No dependency on another repository. */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA=/^[a-f0-9]{40}$/, REQUIRED=["check (ubuntu-latest)","check (macos-latest)"];
const ACTIVE=new Set(["queued","in_progress","waiting","pending","requested"]);
const REMEDY="Push the release tree to main, or dispatch check on the tag commit, then retry the release.";
// #503: a main push may skip its heavy jobs by reusing a PR proof; that run is never release evidence (PR runs are not).
const HEAVY=/^(test|test-macos|measure|measure-macos) \(/;
/** Same rules as scripts/ci-scope.ts workflowShards/completeMatrix: the heavy jobs are exactly the matrix the proven tree's check.yml declares. */
export function workflowShards(text){
  const out={};
  for(const id of ["test","test-macos"]){
    const block=new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`,"m").exec(text)?.[1];
    const shard=block&&/^\s+shard: \[([\d, ]+)\]$/m.exec(block)?.[1],total=block&&/^\s+total: \[(\d+)\]$/m.exec(block)?.[1];
    if(!shard||!total)return null;
    const n=Number(total),list=shard.split(",").map(value=>Number(value.trim()));
    if(!Number.isSafeInteger(n)||n<1||list.length!==n||list.some((value,index)=>value!==index+1))return null;
    out[id]=n;
  }
  return out;
}
export function completeMatrix(names,expected){
  const heavy=names.filter(name=>HEAVY.test(name));
  const want=[...["test","test-macos"].flatMap(kind=>{const os=kind==="test"?"ubuntu-latest":"macos-latest",n=expected[kind];return Array.from({length:n},(_,index)=>`${kind} (${os}, ${index+1}, ${n})`);}),"measure (ubuntu-latest)","measure-macos (macos-latest)"].sort();
  return JSON.stringify([...heavy].sort())===JSON.stringify(want);
}
const SKIPPED_REMEDY="A matching main check skipped its test and measure jobs by reusing a pull request proof (#503), and pull request runs are not release evidence. Run gh workflow run check.yml --ref main, wait for it to succeed, then retry the release.";
export class ReleaseProofError extends Error { constructor(kind,cause){super(kind==="reused"?cause:`${cause}. ${REMEDY}`);this.name="ReleaseProofError";this.kind=kind;} }
const refuse=(kind,cause)=>{throw new ReleaseProofError(kind,cause);};
const sha=value=>{if(typeof value!=="string"||!SHA.test(value))refuse("invalid","Commit/tree identity is unavailable");return value;};
const integer=value=>Number.isSafeInteger(value)&&value>0;

export async function frozenTag(api,tag,commit,expectedObject){
  sha(commit);if(typeof tag!=="string"||!/^v[0-9A-Za-z][0-9A-Za-z.+-]{0,100}$/.test(tag))refuse("invalid","Release tag name is unsupported");
  const ref=await api(`git/ref/tags/${tag}`),object=sha(ref?.object?.sha);let target=ref?.object;
  if(expectedObject!==undefined&&object!==sha(expectedObject))refuse("moving-tag","Release tag object moved");
  for(let depth=0;target?.type==="tag";depth++){
    if(depth>=4)refuse("invalid","Annotated release tag exceeds the four-object peel bound");
    const value=await api(`git/tags/${sha(target.sha)}`);if(value?.sha!==target.sha)refuse("invalid","Annotated tag identity is inconsistent");target=value.object;
  }
  if(target?.type!=="commit"||sha(target.sha)!==commit)refuse("moving-tag","Release tag no longer names the event commit");
  return object;
}
async function onMain(api,commit){
  const ref=await api("git/ref/heads/main"),main=sha(ref?.object?.sha);
  if(ref?.object?.type!=="commit")refuse("invalid","Main commit identity is unavailable");
  const comparison=await api(`compare/${commit}...${main}`);
  if(comparison?.base_commit?.sha!==commit||comparison?.merge_base_commit?.sha!==commit||!["ahead","identical"].includes(comparison.status))
    refuse("off-main","Release commit is not on main");
}
function page(value,key){
  if(!value||!Array.isArray(value[key])||value[key].length>100||!Number.isSafeInteger(value.total_count)||value.total_count<value[key].length)
    refuse("invalid","GitHub Actions inventory is malformed");
  return value[key];
}
function eligible(run,workflow,repository,commit,tag){
  return run&&integer(run.id)&&run.workflow_id===workflow&&run.path===".github/workflows/check.yml"
    &&run.head_repository?.full_name===repository&&run.repository?.full_name===repository
    &&(run.head_branch==="main"&&["push","workflow_dispatch"].includes(run.event)
      ||tag!==undefined&&run.head_branch===tag&&run.event==="workflow_dispatch"&&run.head_sha===commit);
}
async function jobsOf(api,run,expected){
  const jobs=[];let total;
  for(let number=1;number<=5;number++){
    const value=await api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${number}`),rows=page(value,"jobs");
    if(total!==undefined&&total!==value.total_count)refuse("changed","CI job inventory changed during proof");total=value.total_count;jobs.push(...rows);
    if(jobs.length===total)break;
    if(rows.length!==100||number===5)refuse("bound","CI job inventory exceeds the complete-read bound");
  }
  if(new Set(jobs.map(job=>job?.id)).size!==jobs.length||jobs.some(job=>!integer(job?.id)||job.run_id!==run.id||typeof job.name!=="string"))
    refuse("invalid","CI job identities are malformed or duplicated");
  const passed=job=>job.status==="completed"&&job.conclusion==="success";
  if(!REQUIRED.every(name=>{const matches=jobs.filter(job=>job.name===name);return matches.length===1&&passed(matches[0]);}))return "no";
  const heavy=jobs.filter(job=>HEAVY.test(job.name));
  if(heavy.length&&heavy.every(job=>job.status==="completed"&&job.conclusion==="skipped"))return "reused";
  return expected&&completeMatrix(jobs.map(job=>job.name),expected)&&heavy.every(passed)?"yes":"no";
}
/** ponytail: discovery is bounded to the latest 100 main runs and 100 exact-tag manual runs, 500 jobs/run.
 * Missing older proof fails closed; dispatch a fresh check rather than broadening the release trust boundary. */
export async function proveRelease(api,input,{now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),waitMs=25*60_000,pollMs=20_000}={}){
  const {repository,tag}=input,commit=sha(input.commit);
  if(typeof repository!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))refuse("invalid","Release repository identity is unavailable");
  const deadline=now()+waitMs,trees=new Map();let requests=0;
  const read=async path=>{
    if(now()>=deadline||++requests>500)refuse("deadline","CI proof deadline or request bound exhausted");
    let result;try{result=await api(path);}catch(error){if(error instanceof ReleaseProofError)throw error;refuse("unavailable","GitHub CI evidence could not be read");}
    if(now()>=deadline)refuse("deadline","GitHub CI evidence arrived after the proof deadline");return result;
  };
  const treeOf=async id=>{sha(id);if(!trees.has(id)){const value=await read(`git/commits/${id}`);if(value?.sha!==id)refuse("invalid","CI commit identity is inconsistent");trees.set(id,sha(value.tree?.sha));}return trees.get(id);};
  const tree=await treeOf(commit);await onMain(read,commit);
  const tagObject=tag===undefined?undefined:await frozenTag(read,tag,commit,input.tagObject);
  const workflow=await read("actions/workflows/check.yml");
  if(!integer(workflow?.id)||workflow.path!==".github/workflows/check.yml")refuse("invalid","Check workflow identity is unavailable");
  for(;;){
    const inventory=page(await read("actions/workflows/check.yml/runs?branch=main&per_page=100"),"workflow_runs");
    if(tag!==undefined)inventory.push(...page(await read(`actions/workflows/check.yml/runs?event=workflow_dispatch&head_sha=${commit}&per_page=100`),"workflow_runs"));
    let active=false,reused=false;const visited=new Set();
    for(const candidate of inventory){
      if(!eligible(candidate,workflow.id,repository,commit,tag)||visited.has(candidate.id))continue;visited.add(candidate.id);
      if(!ACTIVE.has(candidate.status)&&!(candidate.status==="completed"&&candidate.conclusion==="success"))continue;
      if(await treeOf(candidate.head_sha)!==tree)continue;
      const run=await read(`actions/runs/${candidate.id}`);
      if(!eligible(run,workflow.id,repository,commit,tag)||run.id!==candidate.id||run.head_sha!==candidate.head_sha||!integer(run.run_attempt))refuse("changed","CI run identity changed during proof");
      if(ACTIVE.has(run.status)){active=true;continue;}
      if(run.status!=="completed"||run.conclusion!=="success")continue;
      const verdict=await jobsOf(read,run,input.shards);if(verdict==="reused")reused=true;if(verdict!=="yes")continue;
      const final=await read(`actions/runs/${run.id}`);
      if(!eligible(final,workflow.id,repository,commit,tag)||final.id!==run.id||final.status!=="completed"||final.conclusion!=="success"||final.head_sha!==run.head_sha||final.run_attempt!==run.run_attempt)
        refuse("changed","CI was rerun or changed while release evidence was read");
      await onMain(read,commit);if(tag!==undefined)await frozenTag(read,tag,commit,tagObject);
      return {commit,tree,tagObject,runId:run.id,runCommit:run.head_sha,runAttempt:run.run_attempt,url:`https://github.com/${repository}/actions/runs/${run.id}`,requests};
    }
    if(!active&&reused)refuse("reused",SKIPPED_REMEDY);
    if(!active)refuse("missing","No successful identical-tree main check with both OS gates was found within the bounded inventory");
    if(now()+pollMs>=deadline)refuse("deadline","Matching main CI is still in progress at the release wait deadline");
    await sleep(pollMs);
  }
}
export function githubReader(repository,token,{fetcher=fetch,deadline=Date.now()+25*60_000}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository??"")||!token)refuse("invalid","Scoped repository/Actions read access is unavailable");
  return async path=>{
    const remaining=deadline-Date.now();if(remaining<=0)refuse("deadline","GitHub release proof read deadline exhausted");
    const response=await fetcher(`https://api.github.com/repos/${repository}/${path}`,{headers:{authorization:`Bearer ${token}`,accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"},signal:AbortSignal.timeout(Math.min(15000,remaining))});
    if(!response.ok)refuse("unavailable",`GitHub release proof read failed (HTTP ${response.status})`);
    const reader=response.body?.getReader();if(!reader)refuse("invalid","GitHub release proof body is unavailable");
    const chunks=[];let size=0;try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>2*1024*1024)refuse("bound","GitHub release proof response exceeds 2 MiB");chunks.push(row.value);}}finally{await reader.cancel();reader.releaseLock();}
    try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{refuse("invalid","GitHub release proof JSON is malformed");}
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const repository=process.env.GITHUB_REPOSITORY,commit=process.env.RELEASE_TARGET_SHA??process.env.GITHUB_SHA,tag=process.env.RELEASE_TAG_NAME||undefined;
    const api=githubReader(repository,process.env.GH_TOKEN??process.env.GITHUB_TOKEN);
    if(process.argv.includes("--verify-tag-only")){
      if(!tag||!process.env.RELEASE_TAG_OBJECT)refuse("invalid","Frozen release tag proof is missing");
      await frozenTag(api,tag,commit,process.env.RELEASE_TAG_OBJECT);console.log("release: frozen tag still names the verified commit");
    }else{
      if(process.env.RELEASE_DRY_RUN!=="true"&&execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!==commit)refuse("invalid","Release checkout differs from the immutable event commit");
      // The proven run has this commit's tree, so the checked-out check.yml declares the matrix it must have run.
      const shards=workflowShards(execFileSync("git",["show",`${commit}:.github/workflows/check.yml`],{encoding:"utf8"}));
      if(!shards)refuse("invalid","The release tree's check.yml does not declare a plain test shard matrix");
      const proof=await proveRelease(api,{repository,commit,tag,tagObject:process.env.RELEASE_TAG_OBJECT,shards});
      console.log(JSON.stringify({diagnostic:"release-ci-reuse",...proof}));
      if(process.env.GITHUB_OUTPUT)for(const [key,value] of Object.entries(proof))if(value!==undefined)appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
      if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Verified identical-tree check: ${proof.url}\n\nTree: \`${proof.tree}\`. No release test shards were launched.\n`);
    }
  }catch(error){console.error(error instanceof ReleaseProofError?error.message:`Release CI proof is unavailable. ${REMEDY}`);process.exitCode=1;}
}
