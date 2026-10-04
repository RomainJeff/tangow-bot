---
name: run-and-preview
description: Run a project's dev server on the computer and check the result in its Chromium, with logs you can read.
---

Use this to see a web change, not just to make its tests pass.

1. Find the dev command in the manifest scripts (`dev`, `start`, `serve`) or the onboarding notes. Pick a port the project expects; pass one explicitly if several apps run.
2. Run it in the background with a log file, so your shell does not block and you keep the output:

   ```bash
   (cd <project> && nohup <dev command> > /tmp/dev-<name>.log 2>&1 &) ; sleep 3; tail -n 30 /tmp/dev-<name>.log
   ```

   Wait until the log prints the listening URL. If the port is taken, find who holds it (`ss -ltnp` or `lsof -i :<port>`) instead of changing ports silently.
3. Open the URL in the computer's Chromium (the desktop browser, `DISPLAY=:1`): `xdg-open http://localhost:<port>` or `chromium http://localhost:<port> &`. Take a screenshot if your tooling offers one; otherwise describe what the page shows.
4. Exercise the change the way a user would: the page, the click, the form. Then check for errors on both sides: `tail /tmp/dev-<name>.log` and the browser console.
5. Keep the server running while you iterate; most dev servers reload on save. Restart it only after dependency or config changes.
6. When done, stop what you started (`kill <pid>` or `pkill -f "<dev command>"`) and say in your summary what you verified visually and what you could not.

Never expose the server beyond localhost and never put secrets in URLs or screenshots.
