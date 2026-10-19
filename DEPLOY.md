# Deploying the Poker Room

The room gets its own droplet at **room.shakybetspokertools.com**. Players sign in with their ShakyBets account. You grant access with the new **Poker Room** tool in `/admin`, the same way as the other tools.

## What we're building

| Piece | Choice | Cost/mo |
|---|---|---|
| Droplet | Basic, Regular SSD, **2 vCPU / 4 GB**, Ubuntu 24.04, region **NYC3** | $24 |
| Droplet backups | Weekly, turned on when creating it | ~$5 |
| Database | SQLite on the droplet, streamed continuously to Spaces by **Litestream** | — |
| Spaces bucket | NYC3, for the Litestream replica (250 GB included) | $5 |
| **Total** | | **~$34** |

Why this size: the load test ran 500 bot players, acting far faster than people, on 29% of one core and about 300 MB, with the server and every client in one process. 2 vCPU / 4 GB is generous headroom. It's a separate box so nothing else (HORSE+, Triple Draw) can push it out of memory.

Why SQLite and not managed Postgres: the room is one process, and its "write the action to the log, then broadcast" guarantee relies on synchronous writes. Litestream ships every change to Spaces within about a second, and a restore is one command. Postgres would mean rewriting the store for no gain at this size.

## What you do (accounts I can't create for you)

1. **Create the droplet** at DigitalOcean: Ubuntu 24.04, Basic, Regular, 2 vCPU / 4 GB, NYC3, with backups on. Add the same SSH key you use for the main droplet and name it `poker-room`. Note its IP.
2. **DNS at GoDaddy:** add an `A` record, `room` → the droplet's IP.
3. **Spaces:** create a bucket in NYC3 (for example `shakybets-room-backup`, File Listing restricted), plus a Spaces access key under API → Spaces Keys. Keep the key and secret for step 5.
4. Send me the droplet IP, and say "go". From there I run the rest over SSH and check each step.

## What I then do

### On the new droplet

5. Copy `deploy/setup.sh` up and run it. It installs nginx, certbot, Node 24, Litestream and the firewall (SSH and web only), clones `ShakysPokerRoom` into `/opt/poker-room`, and installs the service and the nginx site.
6. Fill in the config:
   - `/etc/poker-room.env`: `ROOM_HANDOFF_SECRET` (a new `openssl rand -hex 32`), `ROOM_ORIGINS=https://room.shakybetspokertools.com`.
   - `/etc/litestream.yml`: the bucket name.
   - `/etc/default/litestream`: the Spaces key and secret.
7. `systemctl start poker-room litestream`, then `certbot --nginx -d room.shakybetspokertools.com`. HTTP will redirect to HTTPS.

### On the main droplet (light edits only, per the memory rules)

8. Add `ROOM_URL=https://room.shakybetspokertools.com` and the same `ROOM_HANDOFF_SECRET` to `/etc/shakybets-auth.env`.
9. Add the `location = /room` block from `deploy/main-site-room.nginx` to the shakybets nginx file **on the server**, since certbot owns it. Then `nginx -t && systemctl reload nginx`.
10. Deploy the updated accounts service and landing page: `./deploy.sh auth` and `./deploy.sh` from `ShakyBets Site`. These add the Poker Room tool, the `/room` hand-off and the landing-page card.

### Check

11. Smoke test:
    - `/health` answers.
    - Sign in on the main site and open the Poker Room card. You land in the room signed in as yourself.
    - A second account without the tool gets "denied".
    - Create your club, issue chips to yourself and a second account, and play a few hands across two browsers.
    - Check that a Litestream snapshot appears in the bucket.
12. **Restore drill:** `litestream restore -o /tmp/check.db /var/lib/poker-room/room.db`, then `sqlite3 /tmp/check.db 'select count(*) from hands'`.

## Day to day

- **Update:** `ROOM_HOST=root@<ip> ROOM_SSH_KEY=<your deploy key> ./deploy/deploy.sh`. This pushes main, pulls it on the droplet and restarts. Hands in progress resume, and players reconnect on their own.
- **Logs:** `journalctl -u poker-room -f`.
- **Backups:** Litestream streams continuously, with daily snapshots kept for 30 days, on top of the weekly droplet backups.
- **Access:** grant or revoke the Poker Room tool in `/admin` on the main site. Inside the room, club owners approve members and manage chips.

## Not covered yet

- An uptime alert. DigitalOcean Monitoring can watch `https://room.shakybetspokertools.com/health`. It's free; turn it on in the control panel.
- Email or push notifications (tournament starting, your turn).
