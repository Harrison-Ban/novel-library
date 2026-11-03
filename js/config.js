// Google Cloud에서 만든 "OAuth 클라이언트 ID"(…apps.googleusercontent.com)를 넣는다. 비밀 값이 아니므로 저장소에 둬도 된다.
export const CONFIG = {
  clientId: '1028776071056-t9bhn39veep9ip7eraoj6c007edlaq3m.apps.googleusercontent.com',
  // drive: 소설 폴더의 파일 목록·이동·이름 변경·휴지통, drive.appdata: 앱 전용 숨김 공간의 library.json
  scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.appdata'],
  // 고정된 소설 폴더: Google Drive '컴퓨터 › 내 컴퓨터 › 소설' (PC의 문서\소설을 동기화한 폴더).
  // 없으면 '문서' 폴더 안의 '소설'을 쓴다 (폴더 이름이 영어일 수도 있어 함께 찾는다)
  rootName: '소설',
  rootParentNames: ['문서', 'Documents', '내 문서'],
};
