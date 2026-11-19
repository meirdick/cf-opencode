# Deployment Guide

## Cloudflare Pages (Recommended)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to Workers & Pages > Create Application > Pages
3. Connect to your GitHub repository
4. Configure build settings:
   - **Project name**: `cf-opencode-marketing` (or your choice)
   - **Production branch**: `main`
   - **Build command**: Leave empty
   - **Build output directory**: `marketing`
   - **Root directory**: `/`
5. Click "Save and Deploy"

Your site will be live at `https://cf-opencode-marketing.pages.dev` (or your custom domain).

## Custom Domain

After deployment:
1. Go to your Pages project settings
2. Click "Custom domains"
3. Add your domain (e.g., `skyworker.dev`)
4. Update your DNS records as instructed

## Environment Variables

No environment variables needed. This is a static site.

## Updating

Any push to the `main` branch will automatically trigger a new deployment.

## Local Preview

```bash
cd marketing
python3 -m http.server 8000
# Visit http://localhost:8000
```

Or using the skyworker preview:
```bash
cd marketing
skyworker-preview 8000 &
python3 -m http.server 8000
```

## Performance Tips

- The site is already optimized with:
  - Single HTML file (no external dependencies)
  - Inline CSS (no additional HTTP requests)
  - Responsive images (via CSS)
  - Fast loading on Cloudflare's edge network

## Analytics (Optional)

To add analytics, insert your tracking code before the closing `</body>` tag in `index.html`:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=YOUR-GA-ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'YOUR-GA-ID');
</script>
```
