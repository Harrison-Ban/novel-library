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
| `js/library.js` | OneDrive 앱 폴더의 `library.json` 읽기·저장 (eTag 비교) |
| `js/scan.js` | 루트·하위 폴더의 txt·doc·docx 목록, 기기 캐시 |
| `js/app.js` | 화면 흐름 |
| `vendor/msal-browser.min.js` | @azure/msal-browser 3.30.0 (MIT) |
