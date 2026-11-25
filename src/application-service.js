import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.

const alreadyApplied=()=>new AppError(409,'ALREADY_APPLIED','이미 신청한 행사입니다.');
const capacityFull=()=>new AppError(409,'CAPACITY_FULL','정원이 다 찼습니다.');

// 안에서 에러가 나면 ROLLBACK, 끝까지 가면 COMMIT
// IMMEDIATE로 시작해야 다른 서버가 중간에 끼어들어 쓰지 못함
function inTransaction(db,work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result=work();
    db.exec('COMMIT');
    return result;
  } catch(err) {
    db.exec('ROLLBACK');
    // 검사를 통과했는데 DB UNIQUE에 걸린 경우도 중복이니까 500 말고 409
    if(/UNIQUE constraint failed: applications\.event_id, applications\.user_id/.test(err?.message)) throw alreadyApplied();
    throw err;
  }
}

export function createApplicationService(repo) {
  const db=repo.db;

  // 담당 운영자인지 확인 (학생이거나 다른 행사 운영자면 false)
  function isManagerOf(actor,eventId) {
    const event=repo.event(eventId);
    return actor.role==='MANAGER' && event.managerId===actor.id;
  }

  // 같은 행사 대기자 중 제일 먼저 신청한 사람, 시간이 같으면 id 작은 사람
  function nextWaiting(eventId) {
    const row=db.prepare(`SELECT id FROM applications WHERE event_id=? AND status='PENDING'
      ORDER BY created_at ASC, id ASC LIMIT 1`).get(eventId);
    return row ? row.id : null;
  }

  return {
    apply(actor,eventId) {
      // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
      // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
      return inTransaction(db,()=>{
        const event=repo.event(eventId);
        if(!event) throw missing('행사');
        if(actor.role!=='STUDENT') throw forbidden();
        // 상태 상관없이 기록이 하나라도 있으면 다시 신청 못 함
        if(repo.existing(event.id,actor.id)) throw alreadyApplied();

        const application=repo.insert(event.id,actor.id);
        repo.addHistory({applicationId:application.id,actorId:actor.id,action:'APPLY',toStatus:'PENDING'});
        return application;
      });
    },
    cancel(actor,applicationId) {
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
      return inTransaction(db,()=>{
        const application=repo.application(applicationId);
        if(!application) throw missing('신청');
        // 학생 본인만 취소 가능
        if(actor.role!=='STUDENT' || application.userId!==actor.id) throw forbidden();
        // 승인된 것, 이미 취소된 것은 학생이 취소 못 함
        if(application.status!=='PENDING') throw invalidState();

        const updated=repo.setStatus(application.id,'CANCELLED');
        repo.addHistory({applicationId:application.id,actorId:actor.id,action:'CANCEL',fromStatus:'PENDING',toStatus:'CANCELLED'});
        return updated;
      });
    },
    approve(actor,applicationId) {
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
      return inTransaction(db,()=>{
        const application=repo.application(applicationId);
        if(!application) throw missing('신청');
        if(!isManagerOf(actor,application.eventId)) throw forbidden();
        // 다른 화면에서 이미 취소됐을 수 있어서 트랜잭션 안에서 다시 읽은 상태로 확인
        if(application.status!=='PENDING') throw invalidState();
        //정원은 APPROVED 인원만 세는거라서
        const event=repo.event(application.eventId);
        if(repo.approvedCount(event.id)>=event.capacity) throw capacityFull();

        const updated=repo.setStatus(application.id,'APPROVED');
        repo.addHistory({applicationId:application.id,actorId:actor.id,action:'APPROVE',fromStatus:'PENDING',toStatus:'APPROVED'});
        return updated;
      });
    },
    revoke(actor,applicationId,reason) {
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
      return inTransaction(db,()=>{
        const application=repo.application(applicationId);
        if(!application) throw missing('신청');
        if(!isManagerOf(actor,application.eventId)) throw forbidden();
        if(application.status!=='APPROVED') throw invalidState();

        // 먼저 승인 취소하고 이력 id를 받아 둠 (자동 승급 이력에 원인으로 넣어야 해서)
        const revoked=repo.setStatus(application.id,'REVOKED');
        const revokeHistoryId=repo.addHistory({applicationId:application.id,actorId:actor.id,action:'REVOKE',
          fromStatus:'APPROVED',toStatus:'REVOKED',reason});

        // 대기자 한 명만 올림, 없으면 promoted는 null
        const nextId=nextWaiting(application.eventId);
        let promoted=null;
        if(nextId!==null) {
          promoted=repo.setStatus(nextId,'APPROVED');
          // 자동 승급도 행위자는
          // //승인 취소한 운영자
          repo.addHistory({applicationId:nextId,actorId:actor.id,action:'AUTO_APPROVE',
            fromStatus:'PENDING',toStatus:'APPROVED',causeHistoryId:revokeHistoryId});
        }
        // 여기까지 다 성공해야 COMMIT, 중간에 하나라도 실패하면 4건 전부 ROLLBACK
        return {revoked,promoted};
      });
    }
  };
}
