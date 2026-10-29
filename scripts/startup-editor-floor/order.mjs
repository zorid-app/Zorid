// Stable seeded Fisher-Yates order. Repetitions still use independent app/profile
// directories and processes; no warm in-process editor is reused as a launch.
export function planCases({sizes,modes,repetitions=1,seed}){
 if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>5)throw Error('Repetitions must be an integer from 1 through 5');
 if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('Seed must be an unsigned 32-bit integer');
 if(!Array.isArray(sizes)||!sizes.length||new Set(sizes).size!==sizes.length||sizes.some(value=>![8192,524288,5242880,52428800].includes(value)))throw Error('Invalid or duplicate fixture sizes');
 if(!Array.isArray(modes)||!modes.length||new Set(modes).size!==modes.length||modes.some(value=>!['normal-reopen','first-folder-selection'].includes(value)))throw Error('Invalid or duplicate clock modes');
 const cases=[];for(let repetition=1;repetition<=repetitions;repetition++)for(const bytes of sizes)for(const mode of modes)cases.push({bytes,mode,repetition,caseId:`${bytes}-${mode}-r${repetition}`});
 let state=seed>>>0;
 const random=()=>{state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return((value^(value>>>14))>>>0)/4294967296;};
 for(let index=cases.length-1;index>0;index--){const other=Math.floor(random()*(index+1));[cases[index],cases[other]]=[cases[other],cases[index]];}
 return cases;
}
