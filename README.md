# 소설 서재 (novel-library)

OneDrive의 소설 txt 파일을 분류·정리하는 개인용 웹앱(PWA). 요구사항은 [PRD.md](PRD.md), 작업 규칙은 [CLAUDE.md](CLAUDE.md), 처음 설정은 [docs/SETUP.md](docs/SETUP.md)를 본다.

- 서버 없는 정적 웹앱, 빌드 과정 없음
- `main` 브랜치에 푸시하면 GitHub Actions가 GitHub Pages로 배포한다
- 배포 주소: https://harrison-ban.github.io/novel-library/

## 앱 설치와 업데이트

- 휴대폰: 브라우저 메뉴(⋮) → "홈 화면에 추가" 또는 "앱 설치". PC: 주소창 오른쪽 설치 아이콘. 설정 화면의 **홈 화면에 설치** 버튼도 쓸 수 있다.
- 배포하면 `sw.js`의 버전이 바뀐다. 앱을 연 직후에는 새 버전을 바로 적용하고, 사용 중이면 "새 버전이 있습니다" 알림을 띄운다.
- localhost에서는 서비스 워커를 쓰지 않는다 (개발 중 옛 파일이 남지 않게).

## PC에서 직접 실행 (선택)

```
python3 -m http.server 8080
```

브라우저에서 http://localhost:8080/ 을 연다. 이 주소도 Azure 리디렉션 URI에 등록되어 있어야 로그인된다.

## 구조

| 파일 | 역할 |
|---|---|
| `index.html`, `css/app.css` | 화면 |
| `js/config.js` | Azure 클라이언트 ID, 권한 |
| `js/auth.js` | 로그인·토큰 갱신 (MSAL) |
| `js/graph.js` | Microsoft Graph 호출, 429 재시도 |
| `js/library.js` | OneDrive 앱 폴더의 `library.json` 읽기·저장, 모아서 저장, eTag 충돌 시 다시 불러와 합치기 |
| `js/model.js` | 분류 그룹·항목·파일 태그와 변경 op |
| `js/scan.js` | 루트·하위 폴더의 txt·doc·docx 목록, 기기 캐시 |
| `js/state.js` | 화면 상태, 알림, 대화상자 |
| `js/board.js` | 보드(칸·카드), 드래그, 선택 모드, 필터·검색·정렬 |
| `js/manage.js` | 분류 관리 화면 |
| `js/fileops.js` | 파일 이동·이름 변경·휴지통, 폴더 생성·이름 변경·삭제, 이름 충돌 처리, 작업 기록 |
| `js/reader.js` | txt 리더: 나눠 불러오기, 보기 설정, 스크롤·페이지 모드, 읽던 위치 |
| `js/encoding.js` | UTF-8·EUC-KR(CP949)·UTF-16 자동 판별 |
| `js/convert.js` | doc·docx → UTF-8 txt 변환 |
| `js/app.js` | 시작·로그인·루트 폴더 지정·설정, 동기화 표시 |
| `js/pwa.js` | 앱 설치, 새 버전 자동 적용·새로고침 알림 |
| `sw.js` | 서비스 워커: 앱 파일을 기기에 저장, 배포마다 버전 교체 (배포 때 버전·파일 목록 자동 기입) |
| `manifest.webmanifest`, `icons/` | 홈 화면 설치 정보와 아이콘 |
| `vendor/msal-browser.min.js` | @azure/msal-browser 3.30.0 (MIT) |
| `vendor/sortable.min.js` | SortableJS 1.15.6 (MIT) |
| `vendor/mammoth.browser.min.js` | mammoth 1.8.0 (BSD-2-Clause), docx 텍스트 추출 |
| `vendor/pdfjs/` | pdf.js 4.10.38 legacy build (Apache-2.0), doc→PDF 텍스트 추출 |
