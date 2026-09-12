import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-files.js';

const UUID=z.string().uuid().regex(/^[a-f0-9-]+$/);
const Account=z.object({id:UUID,cryptRemote:z.string().regex(/^[A-Za-z0-9_-]{1,128}:$/)}).strict();
const Desired=z.object({ enabled:z.boolean(),accounts:z.array(Account).max(512),
  cacheMaxBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reserveBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const Registry=z.object({ version:z.literal(1),slots:z.array(z.object({accountId:UUID,slot:z.number().int().min(0).max(511)}).strict()).max(512),desired:Desired }).strict();
export type ManagedMountDesired=z.infer<typeof Desired>;
export class ManagedMountRegistry {
  private readonly filename: string;
  private value: z.infer<typeof Registry>;
  constructor(stateDir: string) {
    this.filename=path.join(stateDir,'setup','mounts.json');
    try {
      this.value=existsSync(this.filename) ? Registry.parse(readPrivateJson(this.filename)) : {version:1,slots:[],desired:{enabled:false,accounts:[],cacheMaxBytes:0,reserveBytes:0}};
      if (new Set(this.value.slots.map(x=>x.accountId)).size!==this.value.slots.length || new Set(this.value.slots.map(x=>x.slot)).size!==this.value.slots.length) throw Error('DUPLICATE');
    } catch { throw Error('MOUNT_REGISTRY_INVALID'); }
  }
  allocate(accountIds: readonly string[]): Map<string,{media:string;imports:string}> {
    if (accountIds.some(id=>!UUID.safeParse(id).success) || new Set(accountIds).size!==accountIds.length) throw Error('MOUNT_REGISTRY_INVALID');
    const slots=this.value.slots.map(x=>({...x}));
    let next=slots.reduce((n,x)=>Math.max(n,x.slot+1),0);
    for (const id of [...accountIds].sort()) if (!slots.some(x=>x.accountId===id)) {
      if (next>511) throw Error('MOUNT_REGISTRY_FULL');
      slots.push({accountId:id,slot:next++});
    }
    if (slots.length!==this.value.slots.length) {
      const value={...this.value,slots}; writePrivateJson(this.filename,value); this.value=value;
    }
    return new Map(accountIds.map(id=>{
      const slot=slots.find(x=>x.accountId===id)!.slot;
      return [id,{media:`127.0.0.1:${34800+2*slot}`,imports:`127.0.0.1:${34801+2*slot}`}];
    }));
  }
  publish(input: ManagedMountDesired): void {
    const parsed=Desired.safeParse(input);
    if (!parsed.success || (!input.enabled && input.accounts.length>0) || new Set(input.accounts.map(x=>x.id)).size!==input.accounts.length || input.accounts.some(x=>!this.value.slots.some(slot=>slot.accountId===x.id))) throw Error('MOUNT_REGISTRY_INVALID');
    const desired={...parsed.data,accounts:[...parsed.data.accounts].sort((a,b)=>a.id.localeCompare(b.id))};
    const value={...this.value,desired};
    if (!existsSync(this.filename) || JSON.stringify(this.value)!==JSON.stringify(value)) {
      writePrivateJson(this.filename,value); this.value=value;
    }
  }
}
