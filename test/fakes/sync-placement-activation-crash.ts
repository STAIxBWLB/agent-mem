/** Native owned-child crash probe, invoked only with an isolated fake home. */
import { activateSyncPlacement, type PlacementActivationStage } from "../../src/memory/sync-placement-activation.ts";
const [home,root,phase]=process.argv.slice(2);
const phases:PlacementActivationStage[]=["after-intent","after-epoch","after-root-map","after-shards","after-profile","after-fence","after-remove"];
if(!home||!root||!phases.includes(phase as PlacementActivationStage))throw Error("isolated crash probe requires fake home, install and known phase");
await activateSyncPlacement({memoryDir:home,mode:"apply",writerRoots:[root],ownRoot:root,authorize:()=>true,checkpoint:current=>{
  if(current===phase){process.stdout.write(JSON.stringify({phase:current})+"\n");process.kill(process.pid,"SIGKILL");}
}});
throw Error("crash checkpoint was not reached");
