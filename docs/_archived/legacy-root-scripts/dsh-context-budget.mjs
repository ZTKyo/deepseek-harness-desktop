import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
function est(text){ if(!text) return 0; return Math.ceil(String(text).length/4); }
const cats=['systemPrompt','toolSchemas','skills','memory','conversation','toolResults','other'];
function inspect(sessionDir){
  const r={categories:{},total:0,sessionDir};
  for(const c of cats) r.categories[c]={chars:0,tokens:0,label:c};
  try{ const t=fs.readFileSync(path.join(os.homedir(),'.dsh','settings.yaml'),'utf8'); r.categories.systemPrompt.chars=t.length; }catch{}
  try{ const t=fs.readFileSync(path.join(os.homedir(),'.dsh','profiles','web','cordis.patch.yml'),'utf8'); r.categories.toolSchemas.chars=t.length; }catch{}
  if(sessionDir && fs.existsSync(sessionDir)){
    try{ for(const f of fs.readdirSync(sessionDir)){ try{ r.categories.conversation.chars+=fs.statSync(path.join(sessionDir,f)).size; }catch{} } }catch{}
  }
  for(const c of cats){ r.categories[c].tokens=est(String('x').repeat(r.categories[c].chars).substring(0,r.categories[c].chars) || ''); if(r.categories[c].chars>0) r.categories[c].tokens=Math.ceil(r.categories[c].chars/4); r.total+=r.categories[c].tokens; }
  return r;
}
const si=process.argv.indexOf('--session');
const sd=si>=0?path.join(os.homedir(),'.dsh','sessions',process.argv[si+1]):null;
console.log(JSON.stringify(inspect(sd),null,2));
