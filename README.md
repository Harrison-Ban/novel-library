# 소설 서재 (novel-library)

OneDrive의 소설 txt 파일을 분류·정리하는 개인용 웹앱(PWA). 요구사항은 [PRD.md](PRD.md), 작업 규칙은 [CLAUDE.md](CLAUDE.md), 처음 설정은 [docs/SETUP.md](docs/SETUP.md)를 본다.

- 서버 없는 정적 웹앱, 빌드 과정 없음
- `main` 브랜치에 푸시하면 GitHub Actions가 GitHub Pages로 배포한다
- 배포 주소: https://harrison-ban.github.io/novel-library/

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
| `js/app.js` | 시작·로그인·루트 폴더 지정·설정, 동기화 표시 |
| `vendor/msal-browser.min.js` | @azure/msal-browser 3.30.0 (MIT) |
| `vendor/sortable.min.js` | SortableJS 1.15.6 (MIT) |
