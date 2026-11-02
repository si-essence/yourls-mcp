# Live check against a YOURLS server

**Result: PASS, passed=12, failed=0** (2 Nov 2026).

Server: real YOURLS 1.10.6 at `http://127.0.0.1:8090`, PHP 8.5.8 built-in server, throwaway MariaDB 11.4.4 on 127.0.0.1:33306. `DATABASE_URL` was unset. Admin username `admin`. The password was read from `/workspace/tools/yourls/admin.pw` and was never printed.

Command:

```bash
unset DATABASE_URL
YOURLS_URL=http://127.0.0.1:8090 YOURLS_USERNAME=admin npm run live-check
```

Checks (all PASS): tool list (3 tools); `version` with `db=1` (`1.10.6`, `db_version` `507`); `db-stats`; `shorturl` preview (dry-run, nothing sent); `shorturl` confirm (created keyword `mcpmvz2ocgh`); duplicate keyword returned `[input]` HTTP 400; `expand`; `url-stats`; `stats` with `filter=last`, `limit=10`, `start=0`; unknown keyword `expand` returned `[not-found]` HTTP 404; bad password returned `[unauthorized]` HTTP 403.

Signature auth: computed with `/workspace/research/grocy-live/php` from `user/config.php` as `substr(hash_hmac("sha256", "api:" . user, YOURLS_COOKIEKEY), 0, 32)` (YOURLS 1.10 `yourls_auth_signature`). The token was never printed. A second stdio session with `YOURLS_SIGNATURE` ran `version` and passed.

All 6 core actions ran live. Plugin actions `delete`, `update`, and `edit` were not called. They are excluded from the connector.
