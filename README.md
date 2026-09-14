# Voxoira

Free, keyless voice-to-text, live translator, and AI transcript assistant. Static site — no build step, no server, no database. Everything runs in the visitor's browser.

## Files in this repo

| File | Purpose |
|---|---|
| `index.html` | The entire site (HTML, CSS, and JS in one file) |
| `CNAME` | Tells GitHub Pages which custom domain to serve (`voxoira.com`) |
| `ads.txt` | Authorizes Google to sell ads on this domain, once AdSense is approved |
| `robots.txt` | Allows search engines to crawl the site, points to the sitemap |
| `sitemap.xml` | Single-page sitemap for search engines |
| `.nojekyll` | Tells GitHub Pages to skip Jekyll processing and serve files as-is |

## Deploying on GitHub Pages

1. Create a new **public** repository on GitHub (e.g. `voxoira`).
2. Upload every file in this folder to the **root** of the repo (drag-and-drop on the repo's main page works, or `git add . && git commit -m "Initial site" && git push`).
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to `Deploy from a branch`, branch `main`, folder `/ (root)`. Save.
5. Under **Custom domain**, type `voxoira.com` and click **Save**. (This will look for the `CNAME` file already in the repo — since it's already there, GitHub should pick it up automatically.)
6. Leave the **Enforce HTTPS** checkbox for later — it only becomes available once DNS is pointed correctly (next section) and GitHub has issued a certificate. This can take anywhere from a few minutes to a few hours.

Your site will be reachable at `https://<your-username>.github.io/<repo-name>/` immediately, and at `https://voxoira.com` once DNS below is set up.

## Buying the domain and pointing DNS via Cloudflare

1. Register `voxoira.com` (or your chosen domain) through Cloudflare Registrar, or through any other registrar and then add the site to Cloudflare as a DNS-only zone.
2. In the Cloudflare dashboard, go to **DNS → Records** for the domain and add:

   | Type | Name | Content | Proxy status |
   |---|---|---|---|
   | A | `@` | `185.199.108.153` | **DNS only** (grey cloud) |
   | A | `@` | `185.199.109.153` | **DNS only** (grey cloud) |
   | A | `@` | `185.199.110.153` | **DNS only** (grey cloud) |
   | A | `@` | `185.199.111.153` | **DNS only** (grey cloud) |
   | CNAME | `www` | `<your-username>.github.io` | **DNS only** (grey cloud) |

   Important: keep the proxy status **grey/DNS-only**, not orange, until GitHub has issued the HTTPS certificate for your domain. An orange-clouded (proxied) record can prevent GitHub's certificate validation from completing. Once "Enforce HTTPS" is available and checked in GitHub Pages settings, you can switch the records to proxied (orange cloud) if you want Cloudflare's CDN/caching — optional, not required.

3. Remove any default/parking A or CNAME records Cloudflare may have created for the domain.
4. Wait for DNS to propagate (usually minutes with Cloudflare, up to 24 hours worst case). Back in GitHub → Settings → Pages, you should see the custom domain verified with a green checkmark, and the **Enforce HTTPS** checkbox become available — check it.

## After it's live

- Verify the domain in [Google Search Console](https://search.google.com/search-console) (DNS TXT record is the easiest verification method, added the same way as the records above).
- Once you have a Google AdSense publisher ID, replace `REPLACE_WITH_YOUR_PUBLISHER_ID` in `ads.txt` with `pub-XXXXXXXXXXXXXXXX`, and update `AD_CLIENT` inside `index.html`'s `initMonetization()` function with the full `ca-pub-XXXXXXXXXXXXXXXX` ID.
