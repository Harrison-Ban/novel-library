# 처음 설정 안내

화면 이름은 한국어/영어 중 보이는 쪽을 따라가면 됩니다. 한 번만 하면 됩니다.

## 1. Google Cloud 설정 (로그인용, 무료)

PC 브라우저에서 하는 것을 추천합니다. 메뉴 이름은 한국어/영어 중 보이는 쪽을 따라가세요.

**① 프로젝트 만들기**
1. https://console.cloud.google.com 에 접속해 **소설이 있는 Google Drive 계정(Gmail)**으로 로그인합니다. 처음이면 서비스 약관 동의 창에서 체크 후 **동의 및 계속**.
2. 맨 위 왼쪽의 **프로젝트 선택** 상자(처음엔 "프로젝트 선택" 또는 "My First Project")를 누릅니다 → 오른쪽 위 **새 프로젝트**(New project).
3. 프로젝트 이름에 `novel-library` 입력 → **만들기**(Create). 1분쯤 뒤 알림이 뜨면 **프로젝트 선택**을 눌러 이 프로젝트로 들어갑니다.

**② Google Drive API 켜기**
4. 위쪽 검색창에 `Google Drive API` 입력 → 결과의 **Google Drive API** → 파란 **사용**(Enable) 버튼.

**③ 로그인 화면(동의 화면) 만들기**
5. 위쪽 검색창에 `Google Auth Platform` (또는 `OAuth 동의 화면`) 입력 → 들어가서 **시작하기**(Get started).
6. 차례대로 입력합니다.
   - 앱 정보: 앱 이름 `소설 서재`, 사용자 지원 이메일 = 내 Gmail → **다음**
   - 대상(Audience): **외부**(External) → **다음**
   - 연락처 정보: 내 Gmail → **다음**
   - 정책 동의 체크 → **계속** → **만들기**(Create)
7. 왼쪽 메뉴 **대상**(Audience) → 아래 **테스트 사용자**(Test users)의 **+ Add users** → 내 Gmail 입력 → **저장**. ("게시 상태: 테스트"는 그대로 둡니다. 나만 쓰는 앱이라 게시할 필요가 없습니다.)

**④ 클라이언트 ID 만들기**
8. 왼쪽 메뉴 **클라이언트**(Clients) → **+ 클라이언트 만들기**(Create client).
9. 다음처럼 입력합니다.
   - 애플리케이션 유형: **웹 애플리케이션**(Web application)
   - 이름: `novel-library`
   - **승인된 JavaScript 원본**(Authorized JavaScript origins) → **+ URI 추가** → `https://harrison-ban.github.io` 입력 (뒤에 `/`나 `/novel-library`를 붙이지 않습니다)
   - 승인된 리디렉션 URI는 비워 둡니다.
10. **만들기**(Create)를 누르면 창에 **클라이언트 ID**(`…apps.googleusercontent.com`으로 끝남)가 나옵니다. 이 값을 복사해 Claude에게 보내 주세요. 비밀 값이 아니라서 보내도 괜찮습니다.
    - 같은 창의 **클라이언트 보안 비밀번호**(Client secret)는 쓰지 않습니다. 복사하거나 보내지 마세요.

> (PC에서 localhost로도 테스트하려면) 9번의 JavaScript 원본에 `http://localhost:8080`도 추가합니다.

## 2. GitHub Pages 켜기 (배포용) — 이미 해 두었음

`main` 브랜치에 코드가 올라간 뒤에 합니다.

1. https://github.com/Harrison-Ban/novel-library 에서 위쪽 **Settings** 탭을 누릅니다. (휴대폰에서는 브라우저를 "데스크톱 사이트"로 보면 탭이 보입니다.)
2. 왼쪽 메뉴 **General** → **Default branch** 칸의 ⇄ 버튼 → `main` 선택 → **Update** → 확인.
3. 왼쪽 메뉴 **Pages** → **Build and deployment**의 **Source**를 **GitHub Actions**로 바꿉니다.
4. 위쪽 **Actions** 탭 → **Deploy to GitHub Pages** → 오른쪽 **Run workflow** → **Run workflow**. (다음부터는 `main`에 푸시될 때 자동으로 돌아갑니다.)
5. 초록 체크가 뜨면(1~2분) https://harrison-ban.github.io/novel-library/ 에 접속합니다.

## 3. 확인 (PC나 휴대폰 중 하나로)

1. 배포 주소 https://harrison-ban.github.io/novel-library/ 를 열고 **Google 계정으로 로그인**을 누릅니다.
2. "Google에서 확인하지 않은 앱" 경고가 나오면 나만 쓰는 테스트 앱이라서 그렇습니다. **고급**(Advanced) → **소설 서재(으)로 이동(안전하지 않음)**을 누릅니다.
3. 권한 화면에서 **체크 상자를 모두 선택**한 뒤 **계속**을 누릅니다. (Drive 파일 보기·수정, 앱 전용 데이터)
4. 앱이 Google Drive의 `컴퓨터 › 내 컴퓨터 › 소설` 폴더(PC의 문서\소설을 동기화한 것)를 자동으로 찾고, 처음에는 **📁 폴더 설정** 화면이 열립니다. 올릴 폴더를 체크하고 **저장**을 누릅니다.
5. 고른 폴더별 칸에 파일 이름·용량·수정일이 보이면 됩니다.
6. 보안을 위해 한 시간마다 "Google 연결 갱신" 창이 뜹니다. **다시 연결**을 한 번 누르면 하던 작업을 이어서 합니다.

분류·읽던 위치·폴더 설정은 Google Drive의 앱 전용 숨김 공간에 `library.json`으로 저장되어, 다른 기기에서 로그인해도 같게 보입니다. (Drive 화면에는 보이지 않고, Drive 설정 → 앱 관리에서 확인할 수 있습니다.)
