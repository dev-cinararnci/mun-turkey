# MUN Turkey

MUN Turkey is a server-backed conference hub for the Turkish MUN circuit.

## Local start

1. Run `node server.js`
2. Open `http://localhost:3000`

On Windows you can also run `start-mun-turkey.cmd`.

## Public deployment notes

This project is ready for a simple Node deployment and already includes:

- persistent user accounts
- direct messages
- applications, awards, guides, and reviews
- verified conference seed import
- basic origin checks, security headers, and request rate limits

Before public launch, the next recommended upgrade is moving from SQLite to PostgreSQL and adding an admin workflow for conference updates.

## Publish online

The fastest public launch path with the current codebase is:

1. Push this repo to GitHub.
2. Deploy it as a Node web service on a host that supports persistent storage.
3. Mount a persistent disk or volume and point the app at it with `DATA_DIR` or `DB_PATH`.
4. Set `PUBLIC_BASE_URL` to your real HTTPS domain and set `COOKIE_SECURE=true`.
5. Use `/api/health` as the health check path.
6. Add your custom domain and let the host issue TLS for it.

### Recommended MVP host setup

A simple MVP-friendly setup is a single Node web service plus one persistent disk for SQLite.

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`
- Persistent disk mount example: `/var/data`
- Environment example:
  - `PUBLIC_BASE_URL=https://your-domain.com`
  - `COOKIE_SECURE=true`
  - `DATA_DIR=/var/data`
  - `SESSION_MAX_AGE=1209600`

### Before a bigger launch

This app can go online now, but for a stronger public launch the next upgrades should be:

- move from SQLite to PostgreSQL
- add an admin dashboard for conference review and edits
- add backups and uptime monitoring
- add email verification, password reset, and moderation tools

## Environment variables

- `PORT`: HTTP port, defaults to `3000`
- `PUBLIC_BASE_URL`: public app URL used for origin checks
- `COOKIE_SECURE`: set to `true` behind HTTPS
- `SESSION_MAX_AGE`: session lifetime in seconds
- `DATA_DIR`: directory for SQLite storage, defaults to `./data`
- `DB_PATH`: full path to the SQLite file, overrides `DATA_DIR` if set
