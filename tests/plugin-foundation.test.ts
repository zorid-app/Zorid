import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Vault as CoreVault } from '../src/core/vault.ts';
import { MemoryAdapter } from '../src/core/memory-adapter.ts';
import { Vault, TFile, TFolder, TAbstractFile } from '../src/plugins/vault-api.ts';
import { Plugin } from '../src/plugins/plugin.ts';
import type { PluginHost } from '../src/plugins/plugin.ts';
import { PluginLoader } from '../src/plugins/loader.ts';
import { createPluginRequire } from '../src/plugins/module-resolver.ts';
import { Setting, TextComponent } from '../src/plugins/ui-components.ts';

class RemovableMemoryAdapter extends MemoryAdapter {
  removals:{path:string;force:boolean}[]=[];
  async remove(path:string,force=false){this.removals.push({path,force});await super.trash(path);}
}
async function fixture(){
  const adapter=new RemovableMemoryAdapter({'Note.md':'body','Links.md':'[[Note]]'}),core=new CoreVault(adapter);
  await core.initialize();
  const vault=new Vault(core,{name:'Test',configDir:'.zorid',rename:core.renameEntry.bind(core),delete:core.deleteEntry.bind(core)});
  return{adapter,core,vault};
}

test('core-backed permanent delete forwards force and publishes shared file identity',async()=>{
  const {adapter,vault}=await fixture(),file=vault.getFileByPath('Note.md')!;
  const removed:TAbstractFile[]=[];vault.on('delete',(entry:TAbstractFile)=>removed.push(entry));
  await vault.delete(file,true);
  assert.deepEqual(adapter.removals,[{path:'Note.md',force:true}]);assert.deepEqual(removed,[file]);
  assert.equal(vault.getFileByPath('Note.md'),null);vault.dispose();
});

for(const operation of ['rename','delete']as const)test(`bound ${operation} callback carries validation through the core mutation queue`,async()=>{
  const {adapter,core,vault}=await fixture(),file=vault.getFileByPath('Note.md')!;
  const removal=core.trash('Note.md'),replacement=core.create('Note.md','replacement');
  const pending=operation==='rename'?vault.rename(file,'Wrong.md'):vault.delete(file,true);
  const results=await Promise.allSettled([removal,replacement,pending]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'fulfilled');assert.equal(results[2].status,'rejected');
  assert.equal(await adapter.read('Note.md'),'replacement');assert.equal(await adapter.stat('Wrong.md'),null);
  assert.equal(adapter.removals.length,0);vault.dispose();
});

test('original fixture shares loader, vault classes and UI constructors without production namespace assembly',async()=>{
  const {adapter,vault}=await fixture(),dom=new JSDOM('<main></main>'),container=dom.window.document.querySelector<HTMLElement>('main')!;
  const namespace={Plugin,Vault,TAbstractFile,TFile,TFolder,Setting,TextComponent};
  const require=createPluginRequire({modules:{obsidian:namespace}}),commands=new Map();
  const app:PluginHost&{vault:Vault}={vault,registerCommand:command=>{commands.set(command.id,command);},removeCommand:id=>{commands.delete(id);},registerSettingTab:()=>()=>{},loadPluginData:async()=>null,savePluginData:async()=>{}};
  let removedStyles=0;
  const loader=new PluginLoader({app,require,policy:()=>({communityPluginsEnabled:true,allowedPlugins:true,isDesktopApp:true}),readText:async(_dir,file)=>file==='main.js'?'original fixture':'.test{}',mountStyles:()=>()=>{removedStyles++;},
    evaluate(_source,pluginRequire,module){
      const api=pluginRequire('obsidian')as typeof namespace;
      assert.equal(api,namespace);
      module.exports=class extends api.Plugin {
        async onload(){
          const file=(this.app as typeof app).vault.getFileByPath('Note.md')!;assert.ok(file instanceof api.TFile);
          const setting=new api.Setting(container).setName('Test');let control:TextComponent|undefined;
          setting.addText(text=>{assert.ok(text instanceof api.TextComponent);control=text;text.setValue(file.basename);});
          assert.equal(control!.getValue(),'Note');this.register(()=>setting.settingEl.remove());
          this.addCommand({id:'example',name:'Example',callback(){}});
          await(this.app as typeof app).vault.rename(file,'Moved.md');
        }
      };
    },
  });
  const manifest={id:'fixture',name:'Fixture',version:'1',minAppVersion:'1',description:'Original test only',author:'Test',dir:'.zorid/plugins/fixture'};
  try{
    await loader.load(manifest);assert.ok(vault.getFileByPath('Moved.md') instanceof TFile);
    assert.equal(await adapter.read('Links.md'),'[[Note]]');assert.equal(commands.size,1);assert.ok(container.querySelector('.setting-item'));
    await loader.unload('fixture');assert.equal(commands.size,0);assert.equal(container.childElementCount,0);assert.equal(removedStyles,1);
    assert.equal(await vault.read(vault.getFileByPath('Moved.md')!),'body','plugin unload does not dispose shared vault');
  }finally{await loader.unload('fixture');vault.dispose();dom.window.close();}
});
