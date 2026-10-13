// Azure 앱 등록 후 받은 "애플리케이션(클라이언트) ID"를 넣는다. 비밀 값이 아니므로 저장소에 둬도 된다.
export const CONFIG = {
  clientId: '06a34119-e00e-4b75-847c-91d884910250',
  authority: 'https://login.microsoftonline.com/consumers',
  scopes: ['User.Read', 'Files.ReadWrite'],
};
