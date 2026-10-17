import { eventHotkey, formatHotkey, reservedHotkey, HOTKEY_COMMANDS } from './hotkeys.ts';
import type { HotkeyPreferences } from './hotkeys.ts';

/** Owns only this Settings section; capture stops before the modal Escape handler. */
export function mountHotkeySettings(parent:HTMLElement,preferences:HotkeyPreferences,onChange:()=>void):{destroy():void;refresh():void} {
  const doc=parent.ownerDocument,win=doc.defaultView!;
  const section=doc.createElement('section');section.className='hotkey-settings';
  const description=doc.createElement('p');description.className='muted';description.textContent='Customize workspace commands and Markdown formatting, folding or syntax selection in the editor. Other editor, text-editing and system shortcuts keep their existing bindings. Bold and Italic have default shortcuts; other editor commands start unassigned. Editor commands only run in an active note editor. Open new window requires the desktop app.';
  const search=doc.createElement('input');search.type='search';search.placeholder='Search commands or shortcuts';search.setAttribute('aria-label','Search hotkeys');
  const status=doc.createElement('p');status.className='hotkey-status';status.role='status';status.setAttribute('aria-live','polite');
  const list=doc.createElement('div');list.className='hotkey-list';
  section.append(description,search,status,list);parent.append(section);
  let destroyed=false,cancelCapture:(()=>void)|undefined;
  const button=(label:string,action:()=>void)=>{const node=doc.createElement('button');node.type='button';node.textContent=label;node.onclick=action;return node;};
  const focusCommand=(id:string)=>list.querySelector<HTMLButtonElement>(`[data-command="${id}"] .hotkey-add`)?.focus();
  const save=(id:string,operation:()=>void)=>{try{operation();onChange();render();focusCommand(id);status.textContent='Shortcut saved.';return true;}catch(error){status.textContent=error instanceof Error?error.message:String(error);return false;}};
  const capture=(id:string,index:number|undefined,trigger:HTMLButtonElement)=>{
    cancelCapture?.();trigger.textContent='Press shortcut…';trigger.setAttribute('aria-label','Press a shortcut. Escape cancels. Tab moves to the next control.');trigger.dataset.recording='true';trigger.focus();
    status.textContent='Press your shortcut. Escape cancels. Tab moves to the next control.';
    const cancel=()=>{win.removeEventListener('keydown',record,true);delete trigger.dataset.recording;cancelCapture=undefined;if(trigger.isConnected){trigger.textContent=index===undefined?'Add shortcut':'Change';trigger.setAttribute('aria-label',`${index===undefined?'Add shortcut to':'Change shortcut for'} ${HOTKEY_COMMANDS.find(command=>command.id===id)!.name}`);}};
    const record=(event:KeyboardEvent)=>{
      if(!section.isConnected||doc.activeElement!==trigger){cancel();return;}
      if(event.key==='Tab'){cancel();status.textContent='Shortcut capture cancelled.';return;}
      event.preventDefault();event.stopImmediatePropagation();
      if(event.key==='Escape'){cancel();status.textContent='Shortcut capture cancelled.';return;}
      const binding=eventHotkey(event,preferences.platform);if(!binding)return;
      const reserved=reservedHotkey(binding,preferences.platform,HOTKEY_COMMANDS.find(command=>command.id===id)!.scope);if(reserved){status.textContent=reserved;return;}
      const bindings=preferences.bindings(id);if(index===undefined)bindings.push(binding);else bindings[index]=binding;
      if(save(id,()=>preferences.set(id,bindings)))cancel();
    };
    cancelCapture=cancel;win.addEventListener('keydown',record,true);
  };
  const render=()=>{
    cancelCapture?.();list.replaceChildren();
    const query=search.value.trim().toLocaleLowerCase();
    const commands=HOTKEY_COMMANDS.filter(command=>`${command.name} ${preferences.label(command.id)}`.toLocaleLowerCase().includes(query));
    for(const command of commands){
      const row=doc.createElement('div');row.className='hotkey-row';row.dataset.command=command.id;row.dataset.scope=command.scope;
      const name=doc.createElement('span');name.className='hotkey-command-name';name.textContent=command.name;
      const controls=doc.createElement('div');controls.className='hotkey-controls';
      const bindings=preferences.bindings(command.id);
      bindings.forEach((binding,index)=>{
        const group=doc.createElement('span');group.className='hotkey-binding';const key=doc.createElement('kbd');key.textContent=formatHotkey(binding,preferences.platform);
        const edit=button('Change',()=>capture(command.id,index,edit));edit.setAttribute('aria-label',`Change ${key.textContent} for ${command.name}`);
        const remove=button('Remove',()=>save(command.id,()=>preferences.set(command.id,bindings.filter((_,i)=>i!==index))));remove.setAttribute('aria-label',`Remove ${key.textContent} from ${command.name}`);
        group.append(key,edit,remove);controls.append(group);
        const conflicts=preferences.conflicts(command.id,binding),reserved=reservedHotkey(binding,preferences.platform,command.scope);
        if(conflicts.length||reserved){const warning=doc.createElement('span');warning.className='hotkey-conflict';warning.textContent=reserved??`Conflicts with ${conflicts.map(item=>item.name).join(', ')}; no command will run.`;controls.append(warning);}
      });
      if(!bindings.length){const unbound=doc.createElement('span');unbound.className='muted';unbound.textContent='Not assigned';controls.append(unbound);}
      const add=button('Add shortcut',()=>capture(command.id,undefined,add));add.className='hotkey-add';add.disabled=bindings.length>=8;add.setAttribute('aria-label',`Add shortcut to ${command.name}`);
      const reset=button('Reset',()=>save(command.id,()=>preferences.set(command.id,null)));reset.disabled=!preferences.customized(command.id);reset.setAttribute('aria-label',`Reset shortcuts for ${command.name}`);
      controls.append(add,reset);row.append(name,controls);list.append(row);
    }
    if(!commands.length){const empty=doc.createElement('p');empty.textContent='No matching commands.';list.append(empty);}
  };
  search.oninput=render;render();
  // Also release window capture on backdrop/section removal without a second
  // modal callback API; this observer does not outlive its owning section.
  const observer=new win.MutationObserver(()=>{if(!section.isConnected)destroy();});observer.observe(doc.body,{childList:true,subtree:true});
  function destroy(){if(destroyed)return;destroyed=true;cancelCapture?.();observer.disconnect();}
  return {destroy,refresh(){if(!destroyed){const owner=(doc.activeElement as Element|null)?.closest<HTMLElement>('[data-command]')?.dataset.command;render();if(owner)focusCommand(owner);}}};
}
