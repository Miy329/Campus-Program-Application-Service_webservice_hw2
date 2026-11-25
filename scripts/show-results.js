// 보고서 작성용 확인 스크립트: T25~T32 상황을 임시 DB에서 그대로 재현하고
// HTTP 응답, 신청 상태, 변경 기록을 화면에 출력합니다. 실제 DB(data/app.sqlite)는 건드리지 않습니다.
// 실행: node scripts/show-results.js
import { fixture } from '../tests/helpers.js';

const cleanups=[];
const t={after:fn=>cleanups.push(fn)};
const line=()=>console.log('-'.repeat(70));
const res=(label,r)=>console.log(`${label}: ${r.status}${r.data?.code?' '+r.data.code:''}`);
function apps(f){return f.snapshot().map(a=>`#${a.id} user${a.user_id} 행사${a.event_id} ${a.status}`).join(' / ')||'(없음)';}
function hist(f){return f.db.prepare('SELECT * FROM application_history ORDER BY id').all();}
function histText(f,appId){return hist(f).filter(h=>h.application_id===appId)
  .map(h=>`[기록#${h.id} ${h.action} ${h.from_status??'없음'}→${h.to_status} 행위자${h.actor_id}${h.reason?' 사유:'+h.reason:''}${h.cause_history_id?' 원인:기록#'+h.cause_history_id:''}]`).join(' ');}
async function created(f,name,event=1){return (await f.apply(name,event)).data;}
async function approved(f,name,event=1){const a=await created(f,name,event);await f.action(event===1?'manager1':'manager2',a.id,'approve');return a;}
const revoke=(f,name,id,reason='운영 사정으로 승인 취소')=>f.request(`/api/applications/${id}/revoke`,{method:'POST',token:f.tokens[name],body:{reason}});
const approvedCount=async(f,i)=>(await f.request('/api/events')).data[i].approvedCount;

console.log('계정 번호: alice=1, bob=2, manager1=3, manager2=4, charlie=5');

{ line();console.log('T25 승인 취소와 자동 승급 기록의 원인 연결');
  const f=await fixture(t),a=await approved(f,'alice'),b=await created(f,'bob');
  res('manager1이 alice 승인 취소',await revoke(f,'manager1',a.id));
  console.log('신청:',apps(f));
  console.log('alice 기록:',histText(f,a.id));
  console.log('bob 기록:',histText(f,b.id)); }

{ line();console.log('T26 거부된 요청은 상태와 기록을 바꾸지 않음');
  const f=await fixture(t),a=await approved(f,'alice',2),b=await created(f,'bob',2);
  const before=JSON.stringify([f.snapshot(),hist(f)]);
  res('manager2가 bob 승인 (정원 1명 찬 상태)',await f.action('manager2',b.id,'approve'));
  res('alice가 같은 행사 재신청',await f.apply('alice',2));
  res('alice가 승인된 신청 취소',await f.action('alice',a.id,'cancel'));
  res('manager1(다른 행사 운영자)이 승인 취소',await revoke(f,'manager1',a.id));
  console.log('신청:',apps(f),'| 기록 수:',hist(f).length);
  console.log('요청 전과 같은가:',before===JSON.stringify([f.snapshot(),hist(f)])); }

{ line();console.log('T27 변경 기록 조회 권한');
  const f=await fixture(t),a=await created(f,'alice');
  for(const n of ['alice','manager1','bob','manager2'])res(`${n} 조회`,await f.request(`/api/applications/${a.id}/history`,{token:f.tokens[n]}));
  res('토큰 없이 조회',await f.request(`/api/applications/${a.id}/history`));
  res('없는 신청(9999) 조회',await f.request('/api/applications/9999/history',{token:f.tokens.alice})); }

{ line();console.log('T28 신청 기록 저장 실패 → 신청도 롤백');
  const f=await fixture(t);
  f.db.exec("CREATE TRIGGER fail_apply BEFORE INSERT ON application_history WHEN NEW.action='APPLY' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END");
  res('APPLY 기록 실패 상태에서 alice 신청',await f.apply('alice'));
  console.log('신청:',apps(f),'| 기록 수:',hist(f).length);
  f.db.exec('DROP TRIGGER fail_apply');
  res('실패 장치 제거 후 다시 신청',await f.apply('alice'));
  console.log('신청:',apps(f),'| 기록 수:',hist(f).length); }

{ line();console.log('T29 자동 승급 기록 저장 실패 → 두 상태와 두 기록 모두 롤백');
  const f=await fixture(t),a=await approved(f,'alice'),b=await created(f,'bob');
  console.log('요청 전 신청:',apps(f),'| 기록 수:',hist(f).length);
  f.db.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON application_history WHEN NEW.action='AUTO_APPROVE' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END");
  res('AUTO_APPROVE 기록 실패 상태에서 승인 취소',await revoke(f,'manager1',a.id));
  console.log('요청 후 신청:',apps(f),'| 기록 수:',hist(f).length);
  f.db.exec('DROP TRIGGER fail_auto');
  const r=await revoke(f,'manager1',a.id);res('실패 장치 제거 후 다시 승인 취소',r);
  console.log('promoted:',r.data.promoted?`#${r.data.promoted.id} ${r.data.promoted.status}`:null);
  console.log('신청:',apps(f),'| 기록 수:',hist(f).length); }

{ line();console.log('T30 승인, 대기 취소, 승인 취소 기록 실패도 롤백');
  const f=await fixture(t),a=await created(f,'alice'),b=await created(f,'bob');
  for(const [action,call] of [['APPROVE',()=>f.action('manager1',a.id,'approve')],['CANCEL',()=>f.action('bob',b.id,'cancel')]]){
    f.db.exec(`CREATE TRIGGER fail_change BEFORE INSERT ON application_history WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END`);
    res(`${action} 기록 실패 상태에서 요청`,await call());
    console.log('신청:',apps(f),'| 기록 수:',hist(f).length);
    f.db.exec('DROP TRIGGER fail_change'); }
  await f.action('manager1',a.id,'approve');
  f.db.exec("CREATE TRIGGER fail_revoke BEFORE INSERT ON application_history WHEN NEW.action='REVOKE' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END");
  res('REVOKE 기록 실패 상태에서 승인 취소',await revoke(f,'manager1',a.id));
  console.log('신청:',apps(f),'| 기록 수:',hist(f).length); }

{ line();console.log('T31 서버 재시작 후 유지');
  const {openDb}=await import('../src/db.js');
  const f=await fixture(t),a=await approved(f,'alice'),b=await created(f,'bob');
  await revoke(f,'manager1',a.id);
  console.log('재시작 전 신청:',apps(f));await f.stop();
  const db=openDb(f.path);
  console.log('재시작 후 신청:',db.prepare('SELECT * FROM applications ORDER BY id').all().map(x=>`#${x.id} user${x.user_id} ${x.status}`).join(' / '));
  console.log('재시작 후 bob 기록:',db.prepare('SELECT * FROM application_history WHERE application_id=?').all(b.id).map(h=>`[기록#${h.id} ${h.action} 원인:${h.cause_history_id??'없음'}]`).join(' '));
  db.close(); }

{ line();console.log('T32 연속 승인 취소 (정원 2명)');
  const f=await fixture(t),a=await approved(f,'alice'),b=await approved(f,'bob'),c=await created(f,'charlie');
  let r=await revoke(f,'manager1',a.id);res('alice 승인 취소',r);console.log('promoted:',r.data.promoted?`#${r.data.promoted.id}(charlie) ${r.data.promoted.status}`:null);
  r=await revoke(f,'manager1',b.id);res('bob 승인 취소',r);console.log('promoted:',r.data.promoted);
  console.log('승인 인원:',await approvedCount(f,0));
  res('alice 승인 다시 취소',await revoke(f,'manager1',a.id));
  console.log('자동 승인 기록 수:',hist(f).filter(h=>h.action==='AUTO_APPROVE').length); }

line();
for(const fn of cleanups.reverse())await fn();
