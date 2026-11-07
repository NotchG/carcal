# carcal dashboard

The UI, its API routes and the SQLite store. Runs on the Mac next to REW. See ../README.md.

```
npm install
npm run build && npm run start   # or double-click start-dashboard.command
npm run dev                      # development
npm test                         # engine tests
```

Environment: `CARCAL_DB` (default ~/carcal_data/carcal.db), `CARCAL_REW_URL` (default http://127.0.0.1:4735; also editable in the app).
