# Daymark

일정·업무 데스크톱 앱 (Electron)

## 폴더 구조

- `electron/` — 메인 프로세스 (창, 트레이, Google 로그인/동기화)
- `src/` — UI (`login.html`, `task-app.html`)
- `assets/` — 앱 아이콘 등

## 실행

```bash
npm install
npm start
```

이 프로젝트 경로에서 수정하면 됩니다. 설치본(`C:\Program Files\Daymark`)과는 별개입니다.

## 참고

- Google 로그인용 `google-oauth.config.json`이 필요합니다. (로컬에만 두고 Git에는 올리지 마세요.)
