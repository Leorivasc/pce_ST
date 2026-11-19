# Publishing PCE_ST

PCE_ST is a static site: HTML, JavaScript, a WASM file and the EmuTOS ROM. Sections 1-4
cover your own Apache server; section 5 covers GitHub Pages, built and published by
GitHub Actions. The web server only has to serve files. The one real problem is **remote sync**, because the browser talks
to your WebDAV server (Nextcloud) directly, so CORS matters. Both are covered below.

## 1. Build the site

On the machine where the core is built (see README, "Build"):

```bash
scripts/build-core.sh      # once, or after changing core/ (needs emsdk)
scripts/make-dist.sh       # assembles dist/ (about 2 MB)
```

`dist/` keeps the layout the page expects (`web/`, `build/out/`, `core/`, `roms/`);
**do not rearrange it**: the page reaches the WASM core and the ROM with relative
paths such as `../build/out/`.

Copy the **contents** of `dist/` (including the hidden `.htaccess`) to the server:

```bash
rsync -av --delete dist/ user@server:/var/www/pce-st/
```

Then open `https://your.server/pce-st/` (or its own host name).

## 2. Apache configuration

Modules: `mod_mime`, `mod_deflate`, `mod_expires`, `mod_headers` (all standard).

```bash
sudo a2enmod mime deflate expires headers
```

`dist/.htaccess` already sets the file types, compression and caching. If you prefer
not to allow `.htaccess` files, put the same settings in the site's configuration:

```apache
Alias /pce-st /var/www/pce-st
<Directory /var/www/pce-st>
    Require all granted
    Options -Indexes
    AddType application/wasm .wasm
    AddType text/javascript .js
    Header set Cache-Control "no-cache"
    <IfModule mod_deflate.c>
        AddOutputFilterByType DEFLATE text/html text/css text/javascript application/wasm application/json image/svg+xml
    </IfModule>
</Directory>
```

Things that matter:

- **`.wasm` must be served as `application/wasm`**, or the core will not load.
- **HTTPS is recommended.** Audio, fullscreen, pointer lock and storage work best in a
  secure context (`localhost` also counts), and the integrity hashes of the library
  packages use `crypto.subtle`, which browsers only provide on secure origins.
- Nothing else is needed: no COOP/COEP headers, no PHP, no database. All user data
  (library, ROMs, snapshots, preferences) lives in the visitor's browser.
- Updating is a new `rsync`. Files are revalidated on every load (`no-cache`), so
  visitors get the new version on their next reload. Do **not** add long `Expires`
  headers for `.wasm` or `.js`: the page checks that the core's version matches and
  shows an error if a cached old `pce_st_core.wasm` sits next to newer scripts.

## 3. Remote sync (WebDAV) without CORS problems

CORS is enforced by the browser. A page may only call a WebDAV server freely if it has
the **same origin** (same scheme, host and port). Choose one of the two setups.

### Option A (recommended): same origin, no CORS at all

Serve PCE_ST from the **same Apache virtual host** that serves Nextcloud (or
proxies to it). Then the WebDAV URL is a path on the page's own origin and the browser
applies no CORS rules.

Nextcloud on the same Apache:

```apache
# in the Nextcloud virtual host (https://cloud.example.org)
Alias /pce-st /var/www/pce-st
<Directory /var/www/pce-st>
    Require all granted
    Options -Indexes
    AddType application/wasm .wasm
</Directory>
```

PCE_ST is then at `https://cloud.example.org/pce-st/` and the WebDAV folder URL to enter
in the dialog is:

```text
https://cloud.example.org/remote.php/dav/files/<user>/PCE_ST/
```

Nextcloud on another machine behind Apache (reverse proxy): publish PCE_ST on the proxy's
host and proxy the DAV path to Nextcloud, so the browser only ever sees one origin:

```apache
# modules: a2enmod proxy proxy_http
ProxyPreserveHost Off
ProxyPass        /dav/ https://nextcloud.internal/remote.php/dav/
ProxyPassReverse /dav/ https://nextcloud.internal/remote.php/dav/
```

and use `https://your.server/dav/files/<user>/PCE_ST/` as the URL. Do not proxy
anything but the DAV path.

### Option B: PCE_ST on a different origin (add CORS headers)

Only if PCE_ST must live on another host name than the WebDAV server. Add this to the
**WebDAV server's** virtual host (the one that answers `remote.php/dav`), replacing the
origin with the exact origin of the page:

```apache
# modules: a2enmod headers rewrite
<Location "/remote.php/dav/">
    Header always set Access-Control-Allow-Origin  "https://pce.example.org"
    Header always set Access-Control-Allow-Methods "GET, HEAD, PUT, MKCOL, DELETE, OPTIONS"
    Header always set Access-Control-Allow-Headers "Authorization, If-Match, If-None-Match, Content-Type"
    Header always set Access-Control-Expose-Headers "ETag, Last-Modified"
    Header always set Access-Control-Max-Age "600"
    Header always set Vary "Origin"

    # The browser's preflight (OPTIONS) carries no credentials: answer it here,
    # before Nextcloud asks for authentication.
    RewriteEngine On
    RewriteCond %{REQUEST_METHOD} OPTIONS
    RewriteRule ^ - [R=204,L]
</Location>
```

Points that commonly go wrong:

- The origin is exact: scheme, host and port, no trailing slash (`https://pce.example.org`).
  `*` also works here because the page sends no cookies, but a fixed origin is safer.
- `MKCOL` and `DELETE` must be in the allowed methods (the library creates `blobs/` and
  cleans up with them); `ETag` must be in `Expose-Headers`, or sync stops with "no ETag".
- Nextcloud may add its own `Access-Control-*` headers on some routes: duplicates break
  the check. Test with the command below.
- If a reverse proxy sits in front of Apache, the `Header` lines must be in the
  component that actually answers `OPTIONS`.

Check the preflight from a terminal (expect `204` and the `Access-Control-*` lines):

```bash
curl -si -X OPTIONS https://cloud.example.org/remote.php/dav/files/USER/PCE_ST/ \
  -H "Origin: https://pce.example.org" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: authorization,if-match,content-type" | head -20
```

### Connecting

In PCE_ST: Work layout, library panel, **Configure** (title bar).

- **WebDAV folder URL**: the folder inside your account, for example
  `https://cloud.example.org/remote.php/dav/files/<user>/PCE_ST/` (create the folder
  first, or let PCE_ST create it).
- **User** and an **application password** (Nextcloud: Settings, Security, "Create new
  app password"): revocable, unlike your real password. Tick "remember" only on a
  device you own: it is stored unencrypted in that browser.
- Scope: "Whole library" (incremental, keeps revisions and deletions in sync) or
  "Mounted disks only" (one `workspace.pcest` file).

Error messages and what they mean: a generic network error is usually CORS (check the
preflight above); 401 is the user/password; 404/405/409 on upload means the folder does
not exist or `MKCOL` is not allowed; "no ETag" means `Expose-Headers` lacks `ETag`.

## 4. Checklist

1. `https://your.server/pce-st/` loads and EmuTOS boots (a white screen with the
   EmuTOS banner appears within a second).
2. Browser developer tools, Network: `pce_st_core.wasm` answers `200` with
   `content-type: application/wasm`.
3. The ROM button shows "EmuTOS" with a green LED.
4. Library panel, Configure, Connect: the LED turns green and `library.json` appears in
   the remote folder after the first sync.

## 5. GitHub Pages

The workflow `.github/workflows/publish-web.yml` publishes the site at
`https://<user>.github.io/pce_ST/`. Nothing compiled is committed: GitHub builds it.

**When it runs:** on every push to the `web_publish` branch, or by hand (Actions tab,
"Publish web site", "Run workflow"). Publishing is a deliberate step: bring
`web_publish` up to date with `master` when you want a new version online:

```bash
git checkout web_publish
git merge --ff-only master      # or: git merge master
git push origin web_publish
git checkout master
```

**What it does:** installs emsdk 7.0.0 (cached between runs), builds the core from the
vendored PCE (`scripts/build-core.sh`), runs the core, library, automation and MCP test
suites, assembles `dist/` (`scripts/make-dist.sh`) and deploys it. If a test fails,
nothing is published and the site keeps the previous version. The browser suite does
not run there; run it locally before publishing.

**One-time setup:** repository Settings, Pages, "Build and deployment", Source: **GitHub
Actions**.

**Differences from Apache:**

- `.htaccess` is ignored. GitHub Pages already serves `.wasm` as `application/wasm`
  and compresses responses; only the cache rules are lost (Pages caches for about 10
  minutes, so a new version can take that long to show up, or use a hard reload).
- The site lives under a subpath (`/pce_ST/`). That works because every path in the page
  is relative (checked: `dist/` served under `/pce_ST/` boots EmuTOS at 71 fps).
- **Remote sync:** the page and your Nextcloud are on different origins, so option A of
  section 3 (same origin) is not possible; use **option B** with the origin
  `https://<user>.github.io` (no `/pce_ST`: an origin has no path). The rest of
  section 3 applies unchanged.
