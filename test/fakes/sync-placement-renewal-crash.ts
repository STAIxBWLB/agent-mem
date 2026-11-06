import { activateSyncPlacement } from "../../src/memory/sync-placement-activation.ts";
const [home,ownRoot,phase,rawRoots]=process.argv.slice(2);
if(!home||!ownRoot||!phase||!rawRoots)throw Error("isolated renewal crash arguments missing");
await activateSyncPlacement({memoryDir:home,ownRoot,mode:"apply",writerRoots:JSON.parse(rawRoots) as string[],authorize:()=>true,
  renewalCheckpoint(stage){if(stage===phase){process.stdout.write(stage+"\n");process.kill(process.pid,"SIGKILL");}}});
throw Error("isolated renewal crash phase was not reached");
