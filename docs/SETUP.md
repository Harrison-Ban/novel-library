# 처음 설정 안내

화면 이름은 한국어/영어 중 보이는 쪽을 따라가면 됩니다. 한 번만 하면 됩니다.

## 1. Azure 앱 등록 (로그인용)

1. https://portal.azure.com 에 접속해 **OneDrive를 쓰는 Microsoft 계정**으로 로그인합니다.
2. 위쪽 검색창에 `앱 등록`(App registrations)을 입력하고 결과에서 **앱 등록**을 누릅니다.
3. **+ 새 등록**(New registration)을 누릅니다.
4. 다음처럼 입력합니다.
   - 이름(Name): `novel-library`
   - 지원되는 계정 유형(Supported account types): **개인 Microsoft 계정만**(Personal Microsoft accounts only)
   - 리디렉션 URI(Redirect URI): 왼쪽 드롭다운에서 **단일 페이지 애플리케이션(SPA)** 선택, 오른쪽에 `https://harrison-ban.github.io/novel-library/` 입력 (끝의 `/`까지 정확히)
5. **등록**(Register)을 누릅니다.
6. 열린 **개요**(Overview) 화면의 **애플리케이션(클라이언트) ID**(Application (client) ID) 값을 복사해 Claude에게 보내 주세요. 비밀 값이 아니라서 보내도 괜찮습니다.
7. (PC에서 localhost로도 테스트하려면) 왼쪽 메뉴 **인증**(Authentication) → 단일 페이지 애플리케이션 아래 **URI 추가** → `http://localhost:8080/` 입력 → 아래 **저장**.
8. 왼쪽 메뉴 **API 권한**(API permissions) → **+ 권한 추가** → **Microsoft Graph** → **위임된 권한**(Delegated permissions) → 검색창에 `Files.ReadWrite` 입력 후 체크 → **권한 추가**. (`User.Read`는 처음부터 있습니다.)

클라이언트 비밀(Certificates & secrets)은 만들지 않습니다.

> 2번에서 "디렉터리 밖에서 앱을 만들 수 없다"는 식의 안내가 나오면, 개인 계정에 Azure 디렉터리가 아직 없다는 뜻입니다. 그 화면을 캡처해서 Claude에게 보내 주세요.

## 2. GitHub Pages 켜기 (배포용)

`main` 브랜치에 코드가 올라간 뒤에 합니다.

1. https://github.com/Harrison-Ban/novel-library 에서 위쪽 **Settings** 탭을 누릅니다. (휴대폰에서는 브라우저를 "데스크톱 사이트"로 보면 탭이 보입니다.)
2. 왼쪽 메뉴 **General** → **Default branch** 칸의 ⇄ 버튼 → `main` 선택 → **Update** → 확인.
3. 왼쪽 메뉴 **Pages** → **Build and deployment**의 **Source**를 **GitHub Actions**로 바꿉니다.
4. 위쪽 **Actions** 탭 → **Deploy to GitHub Pages** → 오른쪽 **Run workflow** → **Run workflow**. (다음부터는 `main`에 푸시될 때 자동으로 돌아갑니다.)
5. 초록 체크가 뜨면(1~2분) https://harrison-ban.github.io/novel-library/ 에 접속합니다.

## 3. 확인 (PC나 휴대폰 중 하나로)

1. 배포 주소를 열고 **Microsoft 계정으로 로그인**을 누릅니다.
2. 처음에 "앱이 OneDrive 파일에 접근" 권한 동의 화면이 나오면 **예**(동의)를 누릅니다.
3. 폴더 목록에서 소설 루트 폴더까지 들어간 뒤 **소설 루트로 지정**을 누릅니다.
4. 미분류(루트)와 하위 폴더별로 파일 이름·용량·수정일이 보이면 1단계 완료입니다.
5. **설정** 화면 아래에서 버전과 배포 시각을 확인할 수 있습니다.

루트 폴더 선택은 OneDrive의 `앱/novel-library/library.json`(영어 표시: `Apps/novel-library`)에 저장되어, 다른 기기에서 로그인해도 같은 폴더가 열립니다.
