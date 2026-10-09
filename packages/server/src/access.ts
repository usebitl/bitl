/**
 * 계정이 새로 쓸 수 있는가 (이벤트 수집·목표·원격 승인·알림).
 * 로컬 모드는 늘 쓸 수 있다. 클라우드 서버는 여기에 요금제(체험·구독·읽기 전용)를 끼운다.
 */
export interface AccessPolicy {
  canWrite(accountId: string): Promise<boolean>;
}

export const allowAll: AccessPolicy = { canWrite: async () => true };
