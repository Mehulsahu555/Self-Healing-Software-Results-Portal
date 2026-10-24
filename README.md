# Results Day Portal: self-healing demo (Scenario A)

Needs Node 22.5 or newer (built-in SQLite). Run: `npm install` then `npm start`.
- Student portal: http://localhost:5100
- Admin panel: http://localhost:5100/admin (sign-in page first; password `admin123`, set your own with the `ADMIN_KEY` environment variable)
- Health console: http://localhost:5200

## Architecture
`supervisor.js` (:5200) starts and watches `app.js` (:5100) and hosts the health console, incident log and chaos API. It is a separate process so it survives app crashes.

## Database
SQLite through Node's built-in `node:sqlite`: `data/portal.db` (live results, quarantine, audit log, settings) and a separate `data/portal-backup.db` (trusted copy). Every record carries a SHA-256 checksum. Database slowness and outages are injected in code for chaos testing. The 200 demo students are generated on first run.

## Healing mechanisms (6 of 10)
| # | Mechanism | Heals |
|---|-----------|-------|
| 1 | Health checks and automatic restart (supervisor.js) | Crash and freeze |
| 2 | Retry with exponential backoff | Brief DB glitch |
| 3 | Circuit breaker | Slow or dead DB |
| 4 | Fallback to cached last-known result | DB outage |
| 6 | Self-repairing data (checksum, quarantine, restore from backup) | Corrupt records |
| 7 | Load shedding (120 req/s, 429 plus Retry-After) | 10x traffic spike |

Each incident is logged as Detected, Diagnosed, Action, Recovered in `logs/incidents.jsonl` and in the console, with time to detect and time to recover.

## Student result page
Shows five subject marks, total, percentage, grade and pass or fail. Students can download a PDF marksheet (`/api/result/<roll>/pdf`) or print it. The PDF goes through the same healing path, so it still works from the cache during a database outage.

## Admin panel
Signed-in access only: a password page comes first, then a signed, HTTP-only session cookie lasting 8 hours (survives watchdog restarts). Five wrong attempts lock sign-in for 30 seconds. Publish or hide results, statistics and grade distribution, upload Excel (.xlsx) or CSV (roll, name, five subject marks) with validation, add or edit one student, search, delete, export CSV, activity log, and a quarantine view of records the system repaired.

## Chaos
`node chaos.js dbslow | dbdown | corrupt [roll] | corrupt-both [roll] | flood | freeze | crash | healing-on | healing-off | reseed | all`
The console buttons do the same. Turn self-healing off for the baseline.

## Download and print chaos (student page)
Open the student page and expand "Demo controls": slow database, database down, break PDF download, break printing, reset, and a self-healing switch. With healing ON, a broken PDF download waits while the PDF renderer is restarted (about 3 s) and the page says so; printing is repaired the same way (about 3 s). With healing OFF both stay broken and the page says self-healing is off. The result page also reports what self-healing did (retry, cache, or repair) and how long it took. The health console has Downloads and Printing tiles, and the same two buttons.

## Failures stay until healed
With self-healing OFF every failure persists: the DB stays slow or down, a frozen app stays frozen, a crash stays down, corrupt marks stay corrupt, and the flood keeps sending waves (up to 30 s). Turn self-healing ON and the system heals them: the circuit breaker plus a failover (simulated: the injected DB fault is cleared as if the pool reconnected to a replica) takes about 6 to 8 s, the watchdog restarts a frozen or crashed app in about 2 to 4 s, and the scanner repairs corrupt records in about 3 s. Between takes with healing off, use "Stop traffic flood" and "Reset DB faults (manual)".

## Seeing it from the student's side
The console card "What a student sees" looks up one roll every second. Corrupt record with healing off shows 999 marks, healing on repairs it from backup within about 3 s. Corrupt record and backup shows "on hold" and needs a person (re-upload in the admin panel). The flood sends 3 waves of 1,500 requests: with healing on, requests are shed and the portal retries for the student.

## Known limits
- Record and backup both corrupted: quarantined and put on hold, not auto-repaired.
- The supervisor is a single point of failure (production: systemd, Docker or Kubernetes restart policies).
- The DB failover is simulated (a real system needs a replica or managed database).
- One machine, one process; the DB outage is simulated, and the cache is in memory.
- The admin password is a demo default.

## AI Use Declaration
ChatCPT and Cloud AI
